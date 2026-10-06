"""A plan's check: a command (the tests, a type check, a linter) run in a step's folder once its agent has finished.

A plan with a check (Plan.check_command) treats a step as finished only once the check passes in it: the rows under it
wait until then. The monitor calls run_due() after tasks.watch(): every step of a running plan that is to review and
not checked yet gets its check, run where its agent works (herdr.execute), on a thread of its own.
When it fails, the step goes back to its agent with the end of what the check printed, to fix and commit; once the
agent finishes again, the check runs again. After Plan.check_fixes of those, or with no agent left to send it to, the
step fails, holding back the rows under it, until the owner runs the check again, reopens the step or marks it done.
"""
import logging
import threading
import time

from django.db import close_old_connections

from . import herdr, tasks
from .models import Task

log = logging.getLogger(__name__)

SECONDS = 15 * 60  # the longest a check may take
OUTPUT = 12_000  # how much of the end of what it printed is kept
FIX_LINES = 60  # how many of its last lines go back to the agent

_running: set[int] = set()
_lock = threading.Lock()


def command(task: Task, plan=None) -> str:
    plan = plan or (task.plan if task.plan_id else None)
    return plan.check_command.strip() if plan else ''


def passed(task: Task, plan=None) -> bool:
    """Whether the step (of `plan`, when given) counts as finished for the rows under it: done by the owner, or to
    review with its check (if its plan has one) passed."""
    if task.state == Task.DONE:
        return True
    return task.state == Task.REVIEW and (not command(task, plan) or task.check_state in ('passed', 'skipped'))


def skip_finished(plan) -> None:
    """A plan just given a check: its steps to review already finished without one, so they don't hold back the rows
    under them now."""
    plan.steps.filter(state=Task.REVIEW, check_state='').update(check_state='skipped')


def run_due() -> None:
    """Check every finished step of a running plan that hasn't been checked since its agent last finished."""
    due = (Task.objects.filter(state=Task.REVIEW, check_state__in=('', 'fixing'), plan__running=True, archived_at__isnull=True,
                               landed='')
           .exclude(plan__check_command='').select_related('plan', 'project'))
    for task in due:
        start(task)


def start(task: Task) -> None:
    """Run the step's check on a thread of its own."""
    with _lock:
        if task.id in _running:
            return
        _running.add(task.id)
    task.check_state = 'running'
    task.save(update_fields=['check_state', 'updated_at'])
    try:
        threading.Thread(target=_run, args=(task.id,), name=f'marumado-check-{task.id}', daemon=True).start()
    except Exception:
        with _lock:
            _running.discard(task.id)
        raise


def _run(task_id: int) -> None:
    close_old_connections()
    try:
        task = Task.objects.select_related('plan', 'project').get(pk=task_id)
        cmd = command(task)
        if not cmd:
            task.check_state = ''
            task.save(update_fields=['check_state', 'updated_at'])
            return
        cwd = task.agent_cwd or tasks.folder_for(task.project, task.agent_source)
        began = time.monotonic()
        try:
            if not cwd:
                raise RuntimeError("The step has no folder to run it in.")
            if herdr.terminal_mode() != 'control':
                raise RuntimeError('Running commands is turned off here (MARUMADO_HERDR_TERMINAL).')
            # CI=1: test runners that would otherwise watch for changes run once and exit.
            code, out = herdr.execute(task.agent_source, cwd, f'export CI=1; {cmd}', SECONDS, near=task.pane_id if task.live else '')
        except herdr.TimedOut as exc:
            code, out = None, str(exc)
        except (RuntimeError, ValueError) as exc:
            _could_not_run(task, cmd, str(exc))
            return
        _finish(task, cmd, code, out, time.monotonic() - began)
    except Task.DoesNotExist:
        return
    except Exception:
        log.exception('checking task %s failed', task_id)
        Task.objects.filter(pk=task_id, check_state='running').update(check_state='failed')
    finally:
        with _lock:
            _running.discard(task_id)
        close_old_connections()


def _tail(text: str, n: int) -> str:
    return text[-n:] if len(text) > n else text


def _could_not_run(task: Task, cmd: str, reason: str) -> None:
    """A check that can't run can't pass: the step fails with the reason, rather than waiting for nothing."""
    task.refresh_from_db()
    task.check_state = 'failed'
    fields = ['check_state', 'updated_at']
    if task.state == Task.REVIEW:
        task.state, task.finished_at = Task.FAILED, tasks._now()
        fields += ['state', 'finished_at']
    task.save(update_fields=fields)
    tasks.event(task, 'check', f"Couldn't run the check: {reason}", data={'ok': False, 'command': cmd, 'error': reason})


def _finish(task: Task, cmd: str, code: int | None, out: str, seconds: float) -> None:
    task.refresh_from_db()
    ok = code == 0
    took = f'{seconds:.0f} s' if seconds < 120 else f'{seconds / 60:.0f} min'
    data = {'ok': ok, 'code': code, 'seconds': round(seconds, 1), 'command': cmd}
    if ok:
        task.check_state = 'passed'
        task.save(update_fields=['check_state', 'updated_at'])
        tasks.event(task, 'check', f'Check passed ({took})', data=data, output=_tail(out, OUTPUT))
        return
    why = 'timed out' if code is None else f'failed (exit code {code})'
    tasks.event(task, 'check', f'Check {why} after {took}', data=data, output=_tail(out, OUTPUT))
    if task.state != Task.REVIEW:
        # Moved on meanwhile (marked done, reopened, given back to the agent): what it found is in the history.
        task.check_state = 'failed' if task.state != Task.DONE else task.check_state
        task.save(update_fields=['check_state', 'updated_at'])
        return
    if task.check_tries < task.plan.check_fixes and task.live and task.pane_id:
        lines = '\n'.join(out.splitlines()[-FIX_LINES:])
        text = (f'The check `{cmd}` {why} once you finished. Fix what it reports, check it passes, then commit.\n\n'
                f'The end of what it printed:\n```\n{lines}\n```')
        try:
            tasks.send_back(task, text, by='check')
            task.check_state, task.check_tries = 'fixing', task.check_tries + 1
            task.save(update_fields=['check_state', 'check_tries', 'updated_at'])
            return
        except (RuntimeError, ValueError) as exc:
            tasks.event(task, 'error', f"Couldn't send it back to the agent: {exc}")
    task.check_state, task.state, task.finished_at = 'failed', Task.FAILED, tasks._now()
    task.save(update_fields=['check_state', 'state', 'finished_at', 'updated_at'])
    tries = f' after {task.check_tries} fix{"es" if task.check_tries != 1 else ""}' if task.check_tries else ''
    tasks.event(task, 'error', f'The check still fails{tries}: the step failed. Run the check again, reopen the step, or mark it done.')


def again(task: Task) -> None:
    """The owner's "run the check again": a step that failed on its check is to review again, and checked anew."""
    if not command(task):
        raise ValueError('Its plan has no check.')
    if task.state not in (Task.REVIEW, Task.FAILED) or task.check_state == 'running':
        raise ValueError('Only a finished step can be checked again.')
    task.state, task.check_state = Task.REVIEW, ''
    task.save(update_fields=['state', 'check_state', 'updated_at'])
    tasks.event(task, 'moved', 'Checking again')
    if not task.plan.running:
        start(task)
