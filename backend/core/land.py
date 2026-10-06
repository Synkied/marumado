"""Reviewing and landing an agent's work on a task: what it changed, then merge it, open a pull request, send it back
with what to change (tasks.send_back), or discard it.

Two kinds of work. A step of a plan that ran beside others worked on a branch of its own, in a git worktree
(Task.worktree): its work is that branch, against the branch the project's folder is on, and it can be merged into
it, pushed as a pull request, or thrown away with its worktree. Any other task's agent worked in the project's folder
itself: its work is what changed there since it got the task (Task.git_start), and there is nothing to merge.

Reading runs git in the project's folder here when Marumado sees it (the worktrees' branches live in the same
repository); otherwise where the agent runs. Merging and the rest change the repository, so they run where the agent
runs, with the owner's rights and tools (herdr.execute).
"""
import re
import shlex
import subprocess
from pathlib import Path

from . import herdr, tasks
from .models import Task

LIMIT = 256 * 1024  # the most of one file's diff shown
MAX_FILES = 300
SECONDS = 120  # the longest a merge, a push or a pull request may take

q = shlex.quote


# ---------------------------------------------------------------- reading

def _local(task: Task) -> Path | None:
    """The project's repository here, when the agent's work can be read from it."""
    if not task.project or not task.project.path or task.agent_source >= herdr.MACHINE_BASE:
        return None
    path = Path(task.project.path)
    if not (path / '.git').exists():
        return None
    if task.worktree and not _run_local(path, 'rev-parse', '--verify', '--quiet', f'refs/heads/{task.worktree}').strip():
        return None  # its branch is in another clone, where the agent runs
    return path


def _run_local(path: Path, *args: str) -> str:
    try:
        out = subprocess.run(['git', '-c', 'safe.directory=*', '-c', 'core.quotepath=off', '-C', str(path), *args],
                             capture_output=True, timeout=20, env={'GIT_OPTIONAL_LOCKS': '0', 'PATH': '/usr/bin:/bin:/usr/local/bin'})
    except (OSError, subprocess.TimeoutExpired):
        return ''
    return out.stdout[:LIMIT + 1].decode(errors='replace')


def _git(task: Task, *args: str) -> str:
    """git `args` in the task's repository: here when it can be read here, or where its agent runs."""
    local = _local(task)
    if local:
        return _run_local(local, *args)
    there = tasks.folder_for(task.project, task.agent_source)
    if not there:
        raise RuntimeError("The project has no folder where its agent runs.")
    script = f'cd {q(there)} && GIT_OPTIONAL_LOCKS=0 git -c core.quotepath=off {" ".join(q(a) for a in args)} 2>/dev/null | head -c {LIMIT + 1}'
    return herdr.shell(task.agent_source, script).decode(errors='replace')


def _numstat(text: str) -> dict[str, tuple[int, int]]:
    out = {}
    for line in text.splitlines():
        parts = line.split('\t')
        if len(parts) >= 3:
            out[parts[-1]] = (int(parts[0]) if parts[0].isdigit() else 0, int(parts[1]) if parts[1].isdigit() else 0)
    return out


def _files(name_status: str, numstat: str) -> list[dict]:
    counts = _numstat(numstat)
    files = []
    for line in name_status.splitlines():
        parts = line.split('\t')
        if len(parts) < 2:
            continue
        path = parts[-1]
        add, rem = counts.get(path, (0, 0))
        files.append({'path': path, 'status': parts[0][:1], 'original': parts[1] if len(parts) == 3 else None, 'add': add, 'del': rem})
    return files


def review(task: Task) -> dict:
    """What the agent's work is, for the owner to check: its commits, the files it changed with the lines added and
    removed in each, and what can be done with it."""
    base = {'kind': None, 'branch': task.worktree, 'into': '', 'commits': [], 'files': [], 'ahead': 0, 'behind': 0,
            'exists': False, 'landed': task.landed, 'pr_url': task.pr_url}
    if not task.project or not task.started_at:
        return {**base, 'reason': 'No agent has worked on it in a project yet.'}
    if task.agent_source >= herdr.MACHINE_BASE:
        return {**base, 'reason': "Its agent ran on another machine: review its work in that machine's Marumado."}
    if task.worktree:
        into = _git(task, 'symbolic-ref', '--quiet', '--short', 'HEAD').strip()
        exists = bool(_git(task, 'rev-parse', '--verify', '--quiet', f'refs/heads/{task.worktree}').strip())
        if not exists:
            return {**base, 'kind': 'branch', 'into': into, 'reason': f'The branch {task.worktree} is gone.' if not task.landed else ''}
        span = f'HEAD...{task.worktree}'
        counts = _git(task, 'rev-list', '--left-right', '--count', span).split()
        commits = _git(task, 'log', '--format=%h%x09%s', f'HEAD..{task.worktree}').splitlines()[:100]
        files = _files(_git(task, 'diff', '--name-status', '-M', span), _git(task, 'diff', '--numstat', '-M', span))
        return {**base, 'kind': 'branch', 'into': into, 'exists': True,
                'behind': int(counts[0]) if len(counts) == 2 else 0, 'ahead': int(counts[1]) if len(counts) == 2 else 0,
                'commits': [dict(zip(('sha', 'subject'), c.split('\t', 1))) for c in commits if '\t' in c],
                'files': files[:MAX_FILES], 'file_count': len(files)}
    if not task.git_start:
        return {**base, 'kind': 'folder', 'reason': "Marumado couldn't tell where the project stood when the agent started."}
    commits = _git(task, 'log', '--format=%h%x09%s', f'{task.git_start}..HEAD').splitlines()[:100]
    files = _files(_git(task, 'diff', '--name-status', '-M', task.git_start), _git(task, 'diff', '--numstat', '-M', task.git_start))
    files += [{'path': p, 'status': '?', 'original': None, 'add': 0, 'del': 0}
              for p in _git(task, 'ls-files', '--others', '--exclude-standard').splitlines() if p]
    return {**base, 'kind': 'folder', 'into': _git(task, 'symbolic-ref', '--quiet', '--short', 'HEAD').strip(),
            'commits': [dict(zip(('sha', 'subject'), c.split('\t', 1))) for c in commits if '\t' in c],
            'files': files[:MAX_FILES], 'file_count': len(files)}


def diff(task: Task, path: str) -> dict:
    """One file's changes in the agent's work, as a unified diff."""
    found = next((f for f in review(task)['files'] if f['path'] == path), None)
    if found is None:
        raise ValueError('That file is no longer among the changes.')
    names = [n for n in (found['original'], path) if n]
    opts = ['--no-color', '--no-ext-diff', '--no-textconv', '-M']
    if found['status'] == '?':
        text = _git(task, 'diff', *opts, '--no-index', '--', '/dev/null', path)
    elif task.worktree:
        text = _git(task, 'diff', *opts, f'HEAD...{task.worktree}', '--', *names)
    else:
        text = _git(task, 'diff', *opts, task.git_start, '--', *names)
    return {'path': path, 'diff': text[:LIMIT], 'truncated': len(text) > LIMIT}


# ---------------------------------------------------------------- landing

def _branch_task(task: Task) -> None:
    if not task.worktree:
        raise ValueError('Its agent worked in the project’s folder itself: there is no branch to land.')
    if task.agent_source >= herdr.MACHINE_BASE:
        raise ValueError("Its agent ran on another machine: land its work from that machine's Marumado.")
    if task.landed:
        raise ValueError(f'Its work was {task.landed} already.')
    if task.state not in (Task.REVIEW, Task.DONE, Task.FAILED):
        raise ValueError('Its agent is still at work: wait for it to finish its turn.')
    if herdr.terminal_mode() != 'control':
        raise ValueError('Changing repositories is turned off here (MARUMADO_HERDR_TERMINAL).')


def _repo_there(task: Task) -> str:
    there = tasks.folder_for(task.project, task.agent_source)
    if not there:
        raise RuntimeError("The project has no folder where its agent runs.")
    return there


def _worktree_dir(task: Task) -> str:
    """The worktree's folder where the agent runs."""
    for w in herdr.worktrees(_repo_there(task), task.agent_source):
        if w.get('branch') == task.worktree:
            return w.get('path') or ''
    return task.agent_cwd if task.agent_cwd and task.agent_cwd != _repo_there(task) else ''


def _execute(task: Task, cwd: str, script: str) -> tuple[int, str]:
    return herdr.execute(task.agent_source, cwd, script, SECONDS, near=task.pane_id if task.live else '')


def _sharing(task: Task):
    """The tasks whose agents work on the same branch (a plan's steps that continue one another)."""
    return Task.objects.filter(worktree=task.worktree, project=task.project).exclude(pk=task.pk)


def merge(task: Task, clean_up: bool = True) -> str:
    """Merge the task's branch into the branch the project's folder is on, with a merge commit. Refused while its
    worktree has changes not committed, or the project's folder has; a merge that conflicts is undone and says which
    files. Then, with `clean_up` and no other unfinished task on the branch, its agent's workspace, its worktree and
    the branch are removed. The task is done. Returns what happened, in a sentence."""
    _branch_task(task)
    repo, tree = _repo_there(task), _worktree_dir(task)
    branch = q(task.worktree)
    message = q(f'Merge {task.worktree}: {task.title}'[:200])
    script = (
        (f'if [ -n "$(git -C {q(tree)} status --porcelain 2>/dev/null)" ]; then git -C {q(tree)} status --short | head -n 40; exit 10; fi; ' if tree else '')
        + 'if [ -n "$(git status --porcelain --untracked-files=no)" ]; then git status --short --untracked-files=no | head -n 40; exit 11; fi; '
        # A merge that stops is undone: on conflicts, saying which files (12); otherwise with what git said (13).
        + f'if ! said=$(git merge --no-ff --no-edit -m {message} {branch} 2>&1); then '
        + 'conflicts=$(git diff --name-only --diff-filter=U); git merge --abort >/dev/null 2>&1; '
        + 'if [ -n "$conflicts" ]; then echo "$conflicts"; exit 12; fi; echo "$said" | tail -n 8; exit 13; fi; '
        + 'git rev-parse --short HEAD'
    )
    code, out = _execute(task, repo, script)
    if code == 10:
        raise ValueError(f'The agent left changes it didn’t commit, in its worktree: ask it to commit them first.\n{out}')
    if code == 11:
        raise ValueError(f'The project’s folder has changes not committed: commit or stash them there first.\n{out}')
    if code == 12:
        raise ValueError(f'It conflicts with the branch it goes into, so nothing was merged. Ask the agent to merge that '
                         f'branch into its own and settle these files first:\n{out}')
    if code == 13:
        raise RuntimeError(f'git couldn’t merge it, so nothing was merged:\n{out[-1500:]}')
    if code != 0:
        raise RuntimeError(f'Merging failed (exit code {code}): {out[-1500:]}')
    sha = out.strip().splitlines()[-1] if out.strip() else ''
    done = tasks._now()
    for t in [task, *_sharing(task).filter(state__in=(Task.REVIEW, Task.DONE), landed='')]:
        t.landed, t.state, t.finished_at = 'merged', Task.DONE, t.finished_at or done
        t.save(update_fields=['landed', 'state', 'finished_at', 'updated_at'])
        tasks.event(t, 'merged', f'Merged {task.worktree} into the project’s branch' + (f' ({sha})' if sha else ''), data={'sha': sha})
    said = f'Merged {task.worktree}' + (f' as {sha}' if sha else '') + '.'
    if clean_up:
        said += ' ' + _clean_up(task, force=False)
    return said


def discard(task: Task) -> str:
    """Throw the task's work away: its agent's workspace, its worktree and its branch, unmerged. The task goes back to
    To do (queued again in a running plan, where it runs anew)."""
    _branch_task(task)
    if _sharing(task).exclude(state__in=(Task.DONE, Task.TODO)).exclude(landed='discarded').exists():
        raise ValueError('Other steps of its plan work on the same branch: discarding it would throw their work away too.')
    said = _clean_up(task, force=True)
    branch = task.worktree
    tasks.event(task, 'discarded', f'Discarded {branch} and its worktree')
    tasks.reopen(task)
    task.worktree = ''
    task.save(update_fields=['worktree', 'updated_at'])
    return said


def _clean_up(task: Task, force: bool) -> str:
    """Remove the agent's worktree (closing its workspace, the agent with it) and the branch."""
    if not force and _sharing(task).exclude(state=Task.DONE).exists():
        return 'Its worktree stays: other steps work on that branch.'
    repo = _repo_there(task)
    entry = next((w for w in herdr.worktrees(repo, task.agent_source) if w.get('branch') == task.worktree), None)
    if entry and entry.get('open_workspace_id'):
        herdr.remove_worktree(entry['open_workspace_id'], force, task.agent_source)
    elif entry and entry.get('path'):
        code, out = _execute(task, repo, f'git worktree remove {"--force " if force else ""}{q(entry["path"])}')
        if code:
            return f'Its worktree stays at {entry["path"]}: {out.strip()[-300:]}'
    code, out = _execute(task, repo, f'git branch {"-D" if force else "-d"} {q(task.worktree)}')
    for t in [task, *_sharing(task)]:
        if t.live:
            t.live = False
            t.save(update_fields=['live', 'updated_at'])
    if code:
        return f'Its worktree is removed; the branch stays: {out.strip()[-300:]}'
    return 'Its worktree and branch are removed.'


PR_URL = re.compile(r'https?://\S+/pull/\d+')


def pull_request(task: Task) -> str:
    """Push the task's branch and open a pull request for it with the GitHub CLI, where the agent runs. Returns its
    address; the task stays to review until it is merged there."""
    _branch_task(task)
    if task.pr_url:
        return task.pr_url
    tree = _worktree_dir(task) or _repo_there(task)
    body = (task.prompt.strip() or task.title) + '\n\n---\nMade by a coding agent, from Marumado.'
    script = (
        'command -v gh >/dev/null || { echo "The GitHub CLI (gh) isn’t installed where the agent runs."; exit 20; }; '
        f'git push -u origin {q(task.worktree)} 2>&1 | tail -n 5 || exit 21; '
        f'gh pr create --head {q(task.worktree)} --title {q(task.title)} --body {q(body)} 2>&1 | tail -n 5'
    )
    code, out = _execute(task, tree, script)
    found = PR_URL.search(out)
    if not found:
        raise RuntimeError(out.strip()[-1500:] or f'gh pr create failed (exit code {code}).')
    task.pr_url = found.group(0)
    task.save(update_fields=['pr_url', 'updated_at'])
    tasks.event(task, 'pr', 'Opened a pull request', data={'url': task.pr_url})
    return task.pr_url
