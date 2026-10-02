"""Tasks handed to coding agents in Herdr: give one to an agent, then follow what it does.

Assigning runs on a thread of its own (starting an agent can take a while). After that the monitor calls
watch() every few seconds: each change of the agent's state (working, blocked, idle, done) becomes an event
with the end of its terminal, and when the agent finishes its turn the task waits for review, with the commits
and files it changed in the project.
"""
import logging
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from django.db import close_old_connections, transaction

from . import discovery, herdr
from .models import Task, TaskEvent

log = logging.getLogger(__name__)

SNAPSHOT_LINES = 60
FINAL_LINES = 200
MAX_FILES = 60

# Tasks being handed to an agent right now; watch() leaves them alone until that is over.
_assigning: set[int] = set()
_lock = threading.Lock()


def _now():
    return datetime.now(timezone.utc)


def event(task: Task, kind: str, text: str = '', **fields) -> TaskEvent:
    return TaskEvent.objects.create(task=task, kind=kind, text=text[:500], **fields)


def prompt_text(task: Task) -> str:
    return f'{task.title}\n\n{task.notes.strip()}'.strip()


def _snapshot(pane_id: str, lines: int = SNAPSHOT_LINES) -> str:
    try:
        return herdr.read(pane_id, lines)
    except (RuntimeError, ValueError):
        return ''


# ---------------------------------------------------------------- git

def _repo(task: Task) -> Path | None:
    """The task's project folder, when Marumado can see it and it is a git repository."""
    if not task.project or not task.project.path:
        return None
    path = Path(task.project.path)
    return path if (path / '.git').exists() else None


def git_head(task: Task) -> str:
    path = _repo(task)
    return discovery._git(path, 'rev-parse', 'HEAD') if path else ''


def changes(task: Task) -> dict | None:
    """What changed in the project since the agent got the task: new commits, and changed files (committed or not)."""
    path = _repo(task)
    if not path or not task.git_start:
        return None
    commits = []
    for line in discovery._git(path, 'log', '--format=%h%x09%s', f'{task.git_start}..HEAD').splitlines()[:50]:
        sha, _, subject = line.partition('\t')
        commits.append({'sha': sha, 'subject': subject})
    files = []
    for line in discovery._git(path, 'diff', '--name-status', task.git_start).splitlines():
        status, _, name = line.partition('\t')
        files.append({'status': status[:1], 'path': name.split('\t')[-1]})
    for line in discovery._git(path, 'ls-files', '--others', '--exclude-standard').splitlines():
        files.append({'status': '?', 'path': line})
    return {
        'commits': commits,
        'files': files[:MAX_FILES],
        'file_count': len(files),
        'stat': discovery._git(path, 'diff', '--shortstat', task.git_start),
    }


def record_changes(task: Task) -> None:
    """Add a `changes` event, unless nothing changed since the last one."""
    found = changes(task)
    if found is None:
        return
    last = task.events.filter(kind='changes').order_by('-at', '-id').first()
    if last and last.data == found:
        return
    n, c = found['file_count'], len(found['commits'])
    text = f"{c} commit{'s' if c != 1 else ''}, {n} file{'s' if n != 1 else ''} changed" if (n or c) else 'No changes in the project'
    event(task, 'changes', text, data=found)


# ---------------------------------------------------------------- assigning

def _unique_name(task: Task, taken: set[str]) -> str:
    base = f'task-{task.id}'
    name, n = base, 2
    while name in taken:
        name, n = f'{base}-{n}', n + 1
    return name


def assign(task: Task, pane_id: str = '', kind: str = '') -> None:
    """Hand the task to the agent in `pane_id`, or to a new `kind` agent started in the project's folder.
    Checks what it can up front (raising ValueError), then does the slow part on a thread."""
    listed = herdr.agents()
    if not listed['available']:
        raise RuntimeError(f"Herdr isn't reachable {listed['where']}.")
    if pane_id:
        agent = next((a for a in listed['agents'] if a['pane_id'] == pane_id), None)
        if not agent or agent['kind'] == 'terminal':
            raise ValueError('That agent is no longer open.')
        if agent['status'] == 'blocked':
            raise ValueError('That agent is waiting on a question: answer it in Agents first.')
        if agent['status'] == 'working':
            raise ValueError('That agent is busy with something else.')
    elif kind not in herdr.AGENT_KINDS:
        raise ValueError('Choose an agent to give it to.')
    if pane_id:
        task.agent_name, task.agent_kind = agent['name'], agent['kind']
    else:
        task.agent_name, task.agent_kind = _unique_name(task, {a['name'] for a in listed['agents'] if a['name']}), kind
    task.pane_id = pane_id
    task.state = Task.STARTING
    # Its state before the task, so only a change after the prompt counts.
    task.agent_state = agent['status'] if pane_id else ''
    task.agent_title = ''
    task.live = True
    task.prompt_pending = False
    task.git_start = git_head(task)
    task.started_at = _now()
    task.finished_at = None
    task.save()
    who = f"{task.agent_name or task.agent_kind} ({task.agent_kind})" if pane_id else f'a new {kind} agent'
    event(task, 'assigned', f'Given to {who}', data={'pane_id': pane_id, 'kind': task.agent_kind, 'name': task.agent_name,
                                                      'git_start': task.git_start})
    _start_handover(task, start=not pane_id)


def _start_handover(task: Task, start: bool) -> None:
    with _lock:
        if task.id in _assigning:
            raise ValueError('This task is already being handed over.')
        _assigning.add(task.id)
    threading.Thread(target=_handover, args=(task.id, start), name=f'marumado-task-{task.id}', daemon=True).start()


# Every field watch() and the handover change. Saving only these never brings back a task deleted meanwhile.
_FIELDS = ['state', 'pane_id', 'agent_name', 'agent_kind', 'agent_state', 'agent_title', 'live', 'prompt_pending',
           'git_start', 'started_at', 'finished_at', 'updated_at']


def _save(task: Task) -> None:
    with transaction.atomic():
        task.save(update_fields=_FIELDS)


def _wait_for_answer(task: Task, text: str) -> None:
    """The agent stopped on a question before it got the task: send it once the question is answered."""
    task.state, task.agent_state, task.prompt_pending = Task.BLOCKED, 'blocked', True
    _save(task)
    event(task, 'state', text, state='blocked', output=_snapshot(task.pane_id))


def _start(task: Task) -> bool:
    """Open a workspace in the project's folder and start the agent there. True when it is ready for the task now;
    False when it is still starting: watch() sends the task once it is (or asks you, if it stops on a question)."""
    cwd = task.project.path if task.project and task.project.path else ''
    opened = herdr.open_workspace(cwd, task.project.name if task.project else task.title)
    task.pane_id, task.agent_state, task.prompt_pending = opened['pane_id'], '', True
    _save(task)
    where = opened['cwd'] or 'its default folder'
    if cwd and opened['cwd'] and opened['cwd'].rstrip('/') != cwd.rstrip('/'):
        event(task, 'error', f"{cwd} isn't on the machine Herdr runs on, so the agent starts in {where}")
    event(task, 'state', f'Opened a workspace in {where}, starting {task.agent_kind}', state='starting')
    if not herdr.launch_agent(task.agent_name, task.agent_kind, task.pane_id):
        return False
    agent = next((a for a in herdr.agents()['agents'] if a['pane_id'] == task.pane_id), None)
    if agent and agent['status'] == 'blocked':
        return False
    task.agent_state = 'idle'
    _save(task)
    event(task, 'state', f'{task.agent_kind} started in {task.pane_id}', state='idle', output=_snapshot(task.pane_id))
    return True


def _handover(task_id: int, start: bool) -> None:
    """Start the agent if `start`, then send it the task (now, or once watch() sees it ready)."""
    close_old_connections()
    try:
        task = Task.objects.select_related('project').get(pk=task_id)
        if start and not _start(task):
            return
        try:
            picked_up = herdr.prompt_task(task.pane_id, prompt_text(task))
        except herdr.Blocked:
            _wait_for_answer(task, 'The agent is waiting on a question. Answer it in Agents and the task is sent.')
            return
        task.prompt_pending = False
        _save(task)
        event(task, 'prompt', 'Task sent to the agent' if picked_up else "Task sent, but the agent hasn't started on it yet",
              output=prompt_text(task))
    except Task.DoesNotExist:
        return
    except Exception as exc:  # anything that stops the handover fails the task, with the reason
        log.warning('assigning task %s failed: %s', task_id, exc)
        try:
            task = Task.objects.get(pk=task_id)
        except Task.DoesNotExist:
            return  # deleted meanwhile
        task.state, task.live, task.prompt_pending, task.finished_at = Task.FAILED, False, False, _now()
        _save(task)
        event(task, 'error', f"Couldn't hand it over: {exc}", output=_snapshot(task.pane_id) if task.pane_id else '')
    finally:
        with _lock:
            _assigning.discard(task_id)
        close_old_connections()


# ---------------------------------------------------------------- watching

# What the task becomes when its agent enters a state.
_TASK_STATE = {'working': Task.WORKING, 'blocked': Task.BLOCKED}


def watch(now: float = 0) -> None:
    """Follow every live task's agent: record its state changes, and what it changed once it finishes."""
    tasks = list(Task.objects.filter(live=True).select_related('project'))
    with _lock:
        tasks = [t for t in tasks if t.id not in _assigning]
    if not tasks:
        return
    listed = herdr.agents()
    if not listed['available']:
        return  # Herdr unreachable for a moment: wait, don't fail tasks over it
    panes = {a['pane_id']: a for a in listed['agents']}
    for task in tasks:
        try:
            _follow(task, panes.get(task.pane_id))
        except Exception:
            log.exception('watching task %s failed', task.id)


def _follow(task: Task, agent: dict | None) -> None:
    starting = task.state == Task.STARTING and task.prompt_pending
    if starting and agent is not None and (agent['kind'] == 'terminal' or agent['status'] == 'unknown'):
        # A new agent still coming up in its shell. Give it a while, then say what the terminal shows.
        if task.started_at and (_now() - task.started_at).total_seconds() > herdr.START_SECONDS:
            task.state, task.live, task.prompt_pending, task.finished_at = Task.FAILED, False, False, _now()
            _save(task)
            event(task, 'error', f"{task.agent_kind} didn't start in {task.pane_id} within {herdr.START_SECONDS // 60} minutes",
                  output=_snapshot(task.pane_id))
        return
    if agent is None or agent['kind'] == 'terminal':
        # The pane was closed, or the agent in it quit.
        was_working = task.state in (Task.STARTING, Task.WORKING, Task.BLOCKED)
        event(task, 'closed', 'The agent was closed before it finished' if was_working else 'The agent was closed')
        record_changes(task)
        task.live = False
        if was_working:
            task.state, task.finished_at = Task.FAILED, _now()
        _save(task)
        return

    # Titles that only name the agent ("Claude Code") say nothing about the task.
    title = '' if agent['title'].lower().startswith(agent['kind']) else agent['title'][:200]
    retitled = bool(title) and title != task.agent_title
    if retitled:
        task.agent_title = title
        event(task, 'activity', title)

    status = agent['status']
    if status == task.agent_state or status == 'unknown':
        if retitled:
            task.save(update_fields=['agent_title', 'updated_at'])
        return
    task.agent_state = status
    if task.prompt_pending and status in ('idle', 'done'):
        # The question it stopped on is answered: now it gets the task.
        task.state = Task.STARTING
        _save(task)
        event(task, 'state', 'Question answered, sending the task' if task.events.filter(kind='state', state='blocked', at__gte=task.started_at).exists()
              else f'{task.agent_kind} is ready, sending the task', state=status)
        _start_handover(task, start=False)
        return
    if status in _TASK_STATE:
        task.state, task.finished_at = _TASK_STATE[status], None
        text = 'Working' if status == 'working' else (
            f'{task.agent_kind} asks something first (trusting the folder, say). Answer it in Agents and the task is sent.'
            if task.prompt_pending else 'Waiting on you: approval or question')
        event(task, 'state', text,
              state=status, output=_snapshot(task.pane_id))
    else:  # idle or done: ready for input again
        # A task sent but never picked up stays `starting`; one the agent worked on is ready for review.
        if task.state in (Task.WORKING, Task.BLOCKED) or (task.state == Task.STARTING and status == 'done'):
            task.state, task.finished_at = Task.REVIEW, _now()
            event(task, 'state', 'Finished its turn', state=status, output=_snapshot(task.pane_id, FINAL_LINES))
            record_changes(task)
        else:
            event(task, 'state', 'Idle', state=status)
    _save(task)


# ---------------------------------------------------------------- owner's actions

def mark_done(task: Task) -> None:
    if task.live:
        record_changes(task)
    task.state, task.live = Task.DONE, False
    task.finished_at = task.finished_at or _now()
    task.save()
    event(task, 'done', 'Marked done')


def to_review(task: Task) -> None:
    """Put it under review by hand: the agent (if any) is still followed."""
    if task.live:
        record_changes(task)
    task.state, task.finished_at = Task.REVIEW, task.finished_at or _now()
    task.save()
    event(task, 'moved', 'Moved to review')


def reopen(task: Task) -> None:
    """Back to the to-do list, keeping its history. The agent (if still open) is left as it is."""
    task.state, task.live, task.prompt_pending = Task.TODO, False, False
    task.agent_state = ''
    task.save()
    event(task, 'reopened', 'Back to to do')
