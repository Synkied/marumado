"""An agent's conversation, for the Agents module's Conversation view: the steps of its session record
(core/transcripts.py), found from its Herdr pane rather than from a task, and the images in them.

A pane's record is the one Herdr says its agent is in (Pi reports it, a new session's too, before its file exists),
or the one its process says it is writing (Claude Code's and Codex's, _own): so a /clear or /new shows the new
session at once, not the last one until the next prompt writes its record. Otherwise it is the newest one in its folder written since the agent started: none yet is a new session, not the
folder's last one (a new agent showed an old conversation). Two agents of one kind in one folder can't be told apart that way
(core/pulse.py), so then: one given a task has the record its task found; Claude Code names its session (`ai-title`
in the record) and shows that name as the terminal's title, which Herdr reports, so a pane gets the record of its
title; and the others skip the records already taken. `sure` is False when it is still a guess, so the page can say
it may be showing another agent's. An agent on a machine in Machines is read by
that machine's Marumado (its agents/<pane>/trace and agents/<pane>/image).
"""
import json
import re
import shlex
import time
from urllib.parse import urlencode

from . import herdr, transcripts
from .models import Task

PANE_SECONDS = 10  # how long a pane's kind and folder are taken as known
FRESH_SECONDS = 5  # how often a folder is looked at again while the agent has no record of its own yet
SLACK = 5  # seconds: a record a little older than the agent's start is still its own (a resumed one is written to)
TITLE_SECONDS = 15  # how long the names of a folder's sessions are taken as known
TITLE = re.compile(r'"aiTitle": ?("(?:[^"\\]|\\.)*")')

_panes: dict[tuple, tuple[float, dict, list[dict]]] = {}
_titles: dict[tuple, tuple[float, dict[str, str]]] = {}
_starts: dict[tuple, float | None] = {}


def _pane(src: herdr.Source, pane_id: str) -> tuple[dict, list[dict]]:
    """The pane's agent ({kind, cwd, title, …}) and the other agents of its kind in its folder."""
    key = (src.id, pane_id)
    hit = _panes.get(key)
    if hit and time.monotonic() - hit[0] < PANE_SECONDS:
        return hit[1], hit[2]
    listed = herdr._list(src)
    if not listed['available']:
        raise RuntimeError(listed['error'])
    pane = next((a for a in listed['agents'] if a['pane_id'] == pane_id), None)
    if pane is None:
        raise ValueError('That agent is no longer in Herdr.')
    peers = [a for a in listed['agents'] if a['kind'] == pane['kind'] and a['cwd'] == pane['cwd'] and a['pane_id'] != pane_id]
    _panes[key] = (time.monotonic(), pane, peers)
    return pane, peers


def _names(src: herdr.Source, paths: list[str]) -> dict[str, str]:
    """The name Claude Code last gave each session ({path: title}), from the end of its record."""
    key = (src.id, tuple(paths))
    hit = _titles.get(key)
    if hit and time.monotonic() - hit[0] < TITLE_SECONDS:
        return hit[1]
    script = ''.join(f'printf "%s\\t%s\\n" {shlex.quote(p)} "$(tail -c 2000000 -- {shlex.quote(p)} 2>/dev/null | '
                     f'grep -oE \'"aiTitle": ?"([^"\\\\]|\\\\.)*"\' | tail -n 1)"; ' for p in paths)
    names = {}
    for line in herdr.shell(src, script).decode(errors='replace').splitlines():
        path, _, found = line.partition('\t')
        m = TITLE.search(found)
        if m:
            try:
                names[path] = json.loads(m.group(1)).strip()
            except ValueError:
                pass
    _titles[key] = (time.monotonic(), names)
    return names


def _pid(src: herdr.Source, pane_id: str) -> int | None:
    """The pane's agent's process id: None when that can't be told."""
    try:
        procs = (herdr._run(src, 'pane', 'process-info', '--pane', pane_id).get('process_info') or {}).get('foreground_processes') or []
    except (RuntimeError, ValueError, AttributeError):
        return None
    return next((p.get('pid') for p in procs if isinstance(p.get('pid'), int)), None)


def _own(src: herdr.Source, kind: str, pid: int | None) -> str | None:
    """The record the agent's process says it is writing, even before it exists: Claude Code names its session in
    ~/.claude/sessions/<pid>.json, Codex holds ~/.codex/thread-writer-locks/<thread>.lock open. A /clear or /new
    changes it at once, while the new record is only written with the next prompt. '' when that thread has no record
    yet (a new session), None when the process doesn't say (another agent, an older version, no /proc)."""
    if pid is None or kind not in ('claude', 'codex'):
        return None
    if kind == 'claude':
        # Its start (/proc/<pid>/stat, field 22) tells this process's file from one left by an earlier process of that id.
        script = (f'echo "$HOME"; awk \'{{print $22}}\' /proc/{pid}/stat 2>/dev/null; echo; '
                  f'head -c 20000 "$HOME/.claude/sessions/{pid}.json" 2>/dev/null')
        lines = herdr.shell(src, script).decode(errors='replace').split('\n', 2)
        if len(lines) < 3:
            return None
        try:
            mine = json.loads(lines[2])
        except ValueError:
            return None
        session, cwd = mine.get('sessionId'), mine.get('cwd')
        if not (isinstance(session, str) and re.fullmatch(r'[0-9a-f-]{8,64}', session) and isinstance(cwd, str) and cwd):
            return None
        if str(mine.get('procStart', '')) != lines[1].strip() or mine.get('pid') != pid:
            return None
        return f'{lines[0].strip()}/.claude/projects/{transcripts.claude_folder(cwd)}/{session}.jsonl'
    # Its subagents' threads are locked too: they were spawned after it, and thread ids (UUIDv7) sort by time.
    script = (f'id=$(ls -l /proc/{pid}/fd 2>/dev/null | sed -n "s|.*/thread-writer-locks/\\([0-9a-f-]*\\)\\.lock$|\\1|p" | sort | head -n 1); '
              f'[ -n "$id" ] && echo "$id" && find "$HOME/.codex/sessions" -name "rollout-*-$id.jsonl" 2>/dev/null | head -n 1')
    lines = herdr.shell(src, script).decode(errors='replace').splitlines()
    if not lines:
        return None
    return lines[1].strip() if len(lines) > 1 and transcripts.RECORD.match(lines[1].strip()) else ''


def _started(src: herdr.Source, pane_id: str) -> float | None:
    """When the pane's agent started (unix seconds), from its process: None when that can't be told."""
    pid = _pid(src, pane_id)
    if pid is None:
        return None
    key = (src.id, pane_id, pid)
    if key not in _starts:
        if len(_starts) > 500:
            _starts.clear()
        # Its start in clock ticks after boot (/proc/<pid>/stat, field 22), plus when the machine booted.
        script = (f"b=$(awk '/^btime/ {{print $2}}' /proc/stat); s=$(awk '{{print $22}}' /proc/{pid}/stat 2>/dev/null); "
                  f't=$(getconf CLK_TCK 2>/dev/null || echo 100); [ -n "$s" ] && echo $((b + s / t))')
        try:
            out = herdr.shell(src, script).decode().strip()
            _starts[key] = float(out) if out.isdigit() else None
        except (RuntimeError, ValueError):
            return None
    return _starts[key]


def _named(pane: dict) -> str:
    """The record Herdr says the pane's agent is in (Pi's integration reports its path), or ''."""
    session = pane.get('session') or {}
    value = session.get('value') or ''
    return value if session.get('kind') == 'path' and transcripts.RECORD.match(value) and '/../' not in value else ''


def _record(src: herdr.Source, pane: dict, peers: list[dict]) -> tuple[str, bool]:
    """The pane's session record, and whether that is sure: its task's, the one Herdr names, the one named as its
    terminal's title, or the newest in its folder written since it started that no other pane has. ('', True): a new
    session with no record yet."""
    tasks = Task.objects.filter(live=True, agent_source=src.id).exclude(transcript='').values_list('pane_id', 'transcript')
    theirs = set()
    for pane_id, path in tasks:
        if pane_id == pane['pane_id']:
            return path, True
        theirs.add(path)
    named = _named(pane)
    if named:
        return named, True
    own = _own(src, pane['kind'], _pid(src, pane['pane_id']))
    if own is not None:
        return own, True
    theirs |= {_named(a) for a in peers} - {''}
    started = _started(src, pane['pane_id'])
    since = lambda found: [p for t, p in found if p not in theirs and (started is None or t >= started - SLACK)]
    newest = since(transcripts.newest(src, pane['kind'], pane['cwd']))
    if not newest and started is not None:
        newest = since(transcripts.newest(src, pane['kind'], pane['cwd'], FRESH_SECONDS))  # its first record, just written?
    if not peers:
        return (newest[0], True) if newest else ('', True)
    if pane['kind'] == 'claude' and newest:
        names = _names(src, newest)
        title = (pane.get('title') or '').strip()
        mine = next((p for p in newest if title and names.get(p) == title), '')
        if mine:
            return mine, True
        # Not named yet (a new session): the newest record no other agent here is named after.
        others = {(a.get('title') or '').strip() for a in peers} - {''}
        newest = [p for p in newest if names.get(p) not in others] or newest
    return (newest[0], False) if newest else ('', False)



def trace(pane_id: str, source, start: int = 0) -> dict:
    """The pane's session from step `start` on (a negative one: the last -start steps), as transcripts.trace."""
    src = herdr.get_source(source)
    if not herdr.PANE_ID.match(pane_id):
        raise ValueError('Not a Herdr pane id.')
    if src.kind == 'machine':
        return herdr._remote(src, 'GET', f'agents/{pane_id}/trace', query=urlencode({'from': start}), timeout=40)
    pane, peers = _pane(src, pane_id)
    herdr.looked(src.id, pane_id)  # its conversation is open: a turn it finished is seen, as in its terminal
    if pane['kind'] not in transcripts.KINDS:
        name = 'a plain terminal' if pane['kind'] == 'terminal' else pane['kind']
        return {'found': False, 'reason': f"Marumado can't read {name}'s record: only Claude Code's, Codex's and Pi's.", 'steps': [], 'total': 0}
    if not pane['cwd']:
        return {'found': False, 'reason': 'This agent has no working folder to find its record in.', 'steps': [], 'total': 0}
    path, sure = _record(src, pane, peers)
    if not path:
        # A new session: nothing written yet, so nothing to show (not the folder's last session).
        return {'found': True, 'path': '', 'first': 0, 'from': 0, 'total': 0, 'steps': [], 'kind': pane['kind'], 'shared': len(peers) + 1, 'sure': sure}
    data = transcripts.trace(src, pane['kind'], pane['cwd'], None, '', path, start)
    data.pop('usage', None)
    return {**data, 'kind': pane['kind'], 'shared': len(peers) + 1, 'sure': sure}


def image(pane_id: str, source, path: str, image_id: str) -> tuple[str, bytes]:
    """One image of the pane's session: (media type, bytes)."""
    src = herdr.get_source(source)
    if not herdr.PANE_ID.match(pane_id):
        raise ValueError('Not a Herdr pane id.')
    if src.kind == 'machine':
        from . import machines
        tunnel = machines.get(int(src.target))
        if tunnel is None:
            raise RuntimeError(f'{src.name} is no longer in Machines.')
        try:
            res = tunnel.request('GET', f'agents/{pane_id}/image', urlencode({'source': 0, 'path': path, 'id': image_id}), b'', '', timeout=60)
        except machines.Unavailable as exc:
            raise RuntimeError(str(exc))
        if res.status_code != 200:
            raise ValueError('That image could not be read.')
        return res.headers.get('Content-Type', 'image/png'), res.content
    return transcripts.image(src, path, image_id)
