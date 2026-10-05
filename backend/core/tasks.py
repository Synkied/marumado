"""Tasks handed to coding agents in Herdr: give one to an agent, then follow what it does.

Assigning runs on a thread of its own (starting an agent can take a while). After that the monitor calls
watch() every few seconds: each change of the agent's state (working, blocked, idle, done) becomes an event
with the end of its terminal, and when the agent finishes its turn the task waits for review, with the commits
and files it changed in the project.
"""
import logging
import re
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode

from django.db import close_old_connections, transaction

from . import discovery, herdr, places, transcripts
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


TITLE_LENGTH = 80


def title_from(prompt: str) -> str:
    """A short title for a prompt: its first line, down to its first sentence, cut at a word when still too long."""
    line = next((x for x in prompt.splitlines() if x.strip()), '')
    line = ' '.join(re.sub(r'^\s*(?:[#>*-]+|\d+[.)])\s*', '', line).split())
    sentence = re.match(r'(.+?)[.!?:;](?:\s|$)', line)
    if sentence and len(sentence.group(1)) <= TITLE_LENGTH:
        return sentence.group(1)
    if len(line) <= TITLE_LENGTH:
        return line
    cut = line[:TITLE_LENGTH - 1]
    return (cut.rsplit(' ', 1)[0] if ' ' in cut else cut).rstrip(',;:-–— ') + '…'


def prompt_text(task: Task) -> str:
    text = task.prompt.strip() or task.title
    if task.worktree:
        # Steps of a plan that run side by side each get a worktree: say so, so the work stays on its branch.
        text += (f'\n\nYou are working in a git worktree of the project, on the branch {task.worktree}. Other agents work on '
                 'other branches at the same time. Commit your work on this branch; leave merging to me.')
    return text


def _snapshot(task: Task, lines: int = SNAPSHOT_LINES) -> str:
    try:
        return herdr.read(task.pane_id, lines, task.agent_source)
    except (RuntimeError, ValueError):
        return ''


# ---------------------------------------------------------------- git

def _repo(task: Task) -> Path | None:
    """The task's project folder, when Marumado can see it and it is a git repository; for a step in a worktree, the
    worktree's folder (its .git is a file). An agent on another machine works in that machine's copy, so this one's
    says nothing about what it changed."""
    if not task.project or not task.project.path or task.agent_source >= herdr.MACHINE_BASE:
        return None
    if task.worktree and task.agent_cwd:
        src = next((s for s in herdr.sources(include_machines=False) if s.id == task.agent_source), None)
        tree = Path(herdr.folder_here(task.agent_cwd, src) if src and src.folders else task.agent_cwd)
        return tree if (tree / '.git').exists() else None
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


def assign(task: Task, pane_id: str = '', kind: str = '', source: int = herdr.ENV, worktree: str = '') -> None:
    """Hand the task to the agent in `pane_id`, or to a new `kind` agent started in the project's folder,
    in `source` (where Herdr runs). `worktree`: the branch the agent works on; a new agent gets a git worktree of the
    project on that new branch (a plan's step beside others), an open one is already in it (the step above's).
    Checks what it can up front (raising ValueError), then does the slow part on a thread."""
    listed = herdr.agents()
    src = next((s for s in listed['sources'] if s['id'] == source), None)
    if src is None:
        raise ValueError('That agent source no longer exists.')
    if not src['available']:
        raise RuntimeError(f"Herdr isn't reachable {src['where']}.")
    mine = [a for a in listed['agents'] if a['source'] == source]
    if pane_id:
        agent = next((a for a in mine if a['pane_id'] == pane_id), None)
        if not agent or agent['kind'] == 'terminal':
            raise ValueError('That agent is no longer open.')
        if agent['status'] == 'blocked':
            raise ValueError('That agent is waiting on a question: answer it in Agents first.')
        if agent['status'] == 'working':
            raise ValueError('That agent is busy with something else.')
    elif kind not in herdr.AGENT_KINDS:
        raise ValueError('Choose an agent to give it to.')
    if pane_id:
        task.agent_name, task.agent_kind, task.agent_cwd = agent['name'], agent['kind'], agent['cwd']
    else:
        task.agent_name, task.agent_kind = _unique_name(task, {a['name'] for a in mine if a['name']}), kind
    task.pane_id, task.agent_source = pane_id, source
    task.worktree = worktree
    task.state = Task.STARTING
    # Its state before the task, so only a change after the prompt counts.
    task.agent_state = agent['status'] if pane_id else ''
    task.agent_title = ''
    task.live = True
    task.prompt_pending = False
    task.transcript = ''
    if not pane_id:
        task.agent_cwd = folder_for(task.project, source)
    task.git_start = git_head(task)
    task.started_at = _now()
    task.finished_at = None
    task.save()
    who = f"{task.agent_name or task.agent_kind} ({task.agent_kind})" if pane_id else f'a new {kind} agent'
    on = f" on {src['name']}" if len(listed['sources']) > 1 else ''
    event(task, 'assigned', f'Given to {who}{on}', data={'pane_id': pane_id, 'source': source, 'kind': task.agent_kind,
                                                          'name': task.agent_name, 'git_start': task.git_start})
    _start_handover(task, start=not pane_id)


def follow(task: Task, pane_id: str, source: int = herdr.ENV) -> None:
    """Make the task the record of an agent already at work: nothing is sent to it, Marumado just follows it from now on."""
    listed = herdr.agents()
    agent = next((a for a in listed['agents'] if a['source'] == source and a['pane_id'] == pane_id), None)
    if not agent or agent['kind'] == 'terminal':
        raise ValueError('That agent is no longer open.')
    if Task.objects.filter(live=True, agent_source=source, pane_id=pane_id).exclude(pk=task.pk).exists():
        raise ValueError('Another task already follows that agent.')
    status = agent['status']
    task.state = _TASK_STATE.get(status, Task.REVIEW)
    task.pane_id, task.agent_source = pane_id, source
    task.agent_name, task.agent_kind, task.agent_state = agent['name'], agent['kind'], status
    task.agent_title = '' if agent['title'].lower().startswith(agent['kind']) else agent['title'][:200]
    task.live, task.prompt_pending = True, False
    task.agent_cwd, task.transcript = agent['cwd'], ''
    task.git_start = git_head(task)
    task.started_at = _now()
    task.finished_at = _now() if task.state == Task.REVIEW else None
    task.save()
    src = next((s for s in listed['sources'] if s['id'] == source), None)
    on = f" on {src['name']}" if src and len(listed['sources']) > 1 else ''
    event(task, 'assigned', f"Following {agent['name'] or agent['kind']} ({agent['kind']}){on}, already at work",
          data={'follow': True, 'pane_id': pane_id, 'source': source, 'kind': agent['kind'], 'name': agent['name'], 'git_start': task.git_start},
          output=_snapshot(task))


def _start_handover(task: Task, start: bool) -> None:
    with _lock:
        if task.id in _assigning:
            raise ValueError('This task is already being handed over.')
        _assigning.add(task.id)
    threading.Thread(target=_handover, args=(task.id, start), name=f'marumado-task-{task.id}', daemon=True).start()


# Every field watch() and the handover change. Saving only these never brings back a task deleted meanwhile.
_FIELDS = ['state', 'pane_id', 'agent_source', 'agent_name', 'agent_kind', 'agent_state', 'agent_title', 'live', 'prompt_pending',
           'agent_cwd', 'transcript', 'git_start', 'started_at', 'finished_at', 'updated_at']


def _save(task: Task) -> None:
    with transaction.atomic():
        task.save(update_fields=_FIELDS)


def _wait_for_answer(task: Task, text: str) -> None:
    """The agent stopped on a question before it got the task: send it once the question is answered."""
    task.state, task.agent_state, task.prompt_pending = Task.BLOCKED, 'blocked', True
    _save(task)
    event(task, 'state', text, state='blocked', output=_snapshot(task))


def folder_for(project, source: int) -> str:
    """Where a new agent for the project starts, in `source`: on another machine, the project's folder there (as its
    Marumado reports it, '' if it has none); elsewhere, the project's folder here, where a VM sees it."""
    if project is None:
        return ''
    if source >= herdr.MACHINE_BASE:
        return places.folder_on(project, source - herdr.MACHINE_BASE)
    return herdr.folder_in(project.path, source)


def _start(task: Task) -> bool:
    """Open a workspace in the project's folder and start the agent there. True when it is ready for the task now;
    False when it is still starting: watch() sends the task once it is (or asks you, if it stops on a question)."""
    cwd = folder_for(task.project, task.agent_source)
    label = task.project.name if task.project else task.title
    if task.worktree:
        if not cwd:
            raise ValueError("A worktree needs the project's folder, and it has none where Herdr runs.")
        opened = herdr.open_worktree(cwd, task.worktree, f'{label} · {task.worktree.rsplit("/", 1)[-1]}', task.agent_source)
        event(task, 'state', f'Made a git worktree on the branch {task.worktree}', state='starting')
    else:
        opened = herdr.open_workspace(cwd, label, task.agent_source)
    task.pane_id, task.agent_state, task.prompt_pending = opened['pane_id'], '', True
    task.agent_cwd = opened['cwd'] or cwd
    _save(task)
    where = opened['cwd'] or 'its default folder'
    if not task.worktree and cwd and opened['cwd'] and opened['cwd'].rstrip('/') != cwd.rstrip('/'):
        event(task, 'error', f"{cwd} isn't on the machine Herdr runs on, so the agent starts in {where}")
    event(task, 'state', f'Opened a workspace in {where}, starting {task.agent_kind}', state='starting')
    if not herdr.launch_agent(task.agent_name, task.agent_kind, task.pane_id, task.agent_source):
        return False
    agent = next((a for a in herdr.agents()['agents'] if (a['source'], a['pane_id']) == (task.agent_source, task.pane_id)), None)
    if agent and agent['status'] == 'blocked':
        return False
    task.agent_state = 'idle'
    _save(task)
    event(task, 'state', f'{task.agent_kind} started in {task.pane_id}', state='idle', output=_snapshot(task))
    return True


def _handover(task_id: int, start: bool) -> None:
    """Start the agent if `start`, then send it the task (now, or once watch() sees it ready)."""
    close_old_connections()
    try:
        task = Task.objects.select_related('project').get(pk=task_id)
        if start and not _start(task):
            return
        try:
            picked_up = herdr.prompt_task(task.pane_id, prompt_text(task), task.agent_source)
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
        event(task, 'error', f"Couldn't hand it over: {exc}", output=_snapshot(task) if task.pane_id else '')
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
    # A source unreachable for a moment: wait, don't fail its tasks over it. A source that is gone closes them.
    unreachable = {s['id'] for s in listed['sources'] if not s['available']}
    panes = {(a['source'], a['pane_id']): a for a in listed['agents']}
    for task in tasks:
        if task.agent_source in unreachable:
            continue
        try:
            _follow(task, panes.get((task.agent_source, task.pane_id)))
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
                  output=_snapshot(task))
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
              state=status, output=_snapshot(task))
    else:  # idle or done: ready for input again
        # A task sent but never picked up stays `starting`; one the agent worked on is ready for review.
        if task.state in (Task.WORKING, Task.BLOCKED) or (task.state == Task.STARTING and status == 'done'):
            task.state, task.finished_at = Task.REVIEW, _now()
            event(task, 'state', 'Finished its turn', state=status, output=_snapshot(task, FINAL_LINES))
            record_changes(task)
        else:
            event(task, 'state', 'Idle', state=status)
    _save(task)


# ---------------------------------------------------------------- what the agent did

def trace(task: Task, start: int = 0) -> dict:
    """The agent's thinking and actions for the task, from its session record (core/transcripts.py), from step `start`.
    A task that follows an agent already at work shows its whole session; one handed over starts at its prompt."""
    if not task.started_at:
        return {'found': False, 'reason': 'No agent has had it yet.', 'steps': [], 'total': 0}
    assigned = task.events.filter(kind='assigned').order_by('-at', '-id').first()
    followed = bool(assigned and assigned.data.get('follow'))
    cwd = task.agent_cwd or folder_for(task.project, task.agent_source)
    since = None if followed else task.started_at.timestamp()
    src = herdr.get_source(task.agent_source)
    if src.kind == 'machine':
        query = {'kind': task.agent_kind, 'cwd': cwd, 'title': prompt_text(task), 'path': task.transcript, 'from': start}
        if since is not None:
            query['since'] = since
        data = herdr._remote(src, 'GET', 'agents/trace', query=urlencode(query), timeout=40)
    else:
        data = transcripts.trace(src, task.agent_kind, cwd, since, prompt_text(task), task.transcript, start, any_session=followed)
    if data.get('path') and data['path'] != task.transcript:
        task.transcript = data['path']
        task.save(update_fields=['transcript'])
    return data


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
    task.state, task.live, task.prompt_pending = Task.QUEUED if task.plan_id and task.plan.running else Task.TODO, False, False
    task.agent_state, task.archived_at = '', None
    task.save()
    event(task, 'reopened', 'Back to to do')


def archive(task: Task) -> None:
    """Put a done task away: off the board and every list, kept with its history until restored."""
    if task.state != Task.DONE:
        raise ValueError('Only a done task can be archived. Mark it done first.')
    if task.archived_at:
        return
    task.archived_at = _now()
    task.save(update_fields=['archived_at', 'updated_at'])
    event(task, 'archived', 'Archived')


def restore(task: Task) -> None:
    """Back from the archive, where it was."""
    if not task.archived_at:
        return
    task.archived_at = None
    task.save(update_fields=['archived_at', 'updated_at'])
    event(task, 'restored', 'Restored from the archive')
