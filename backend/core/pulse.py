"""What the agents are writing, for home: the lines each one added and removed lately, read from their session records
(core/transcripts.py pulse).

Agents are grouped by source, kind and folder: their records are found by folder, so two agents of one kind in one
folder can't be told apart, and are reported together. Agents on another machine in Machines are read by that
machine's Marumado (its agents/pulse); one too old to have it is left out.
"""
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import herdr, transcripts

# Reading records runs a shell in every source, so the answer is shared between requests for a few seconds.
CACHE_SECONDS = 10

_lock = threading.Lock()
_cache: dict[bool, tuple[float, dict]] = {}


def _folder(src: herdr.Source, kind: str, cwd: str, panes: list[str]) -> dict:
    row = {'source': src.id, 'kind': kind, 'cwd': cwd, 'panes': panes}
    try:
        return {**row, **transcripts.pulse(src, kind, cwd, len(panes))}
    except RuntimeError as exc:
        return {**row, 'found': False, 'error': str(exc), 'edits': [], 'files': [], 'kinds': {}, 'now': None,
                'steps': [], 'turn': None, 'usage': None}


def _machine(src: herdr.Source) -> list[dict]:
    try:
        data = herdr._remote(src, 'GET', 'agents/pulse', query='machines=0', timeout=30)
    except (RuntimeError, ValueError):
        return []
    return [{**f, 'source': src.id} for f in data.get('folders') or [] if f.get('source', herdr.ENV) == herdr.ENV]


def _read(include_machines: bool) -> dict:
    data = herdr.agents(include_machines)
    every = {s.id: s for s in herdr.sources(include_machines)}
    groups: dict[tuple, list[str]] = {}
    remote = set()
    for a in data['agents']:
        src = every.get(a.get('source', herdr.ENV))
        if src is None or a['kind'] == 'terminal':
            continue
        if src.kind == 'machine':
            remote.add(src.id)
        elif a['kind'] in transcripts.KINDS and a['cwd']:
            groups.setdefault((src.id, a['kind'], a['cwd']), []).append(a['pane_id'])
    jobs = [(_folder, (every[s], kind, cwd, panes)) for (s, kind, cwd), panes in groups.items()]
    jobs += [(_machine, (every[s],)) for s in remote]
    if not jobs:
        return {'time': time.time(), 'folders': []}
    with ThreadPoolExecutor(max_workers=min(8, len(jobs))) as pool:
        done = list(pool.map(lambda job: job[0](*job[1]), jobs))
    folders = [f for one in done for f in (one if isinstance(one, list) else [one])]
    return {'time': time.time(), 'folders': folders}


def pulse(include_machines: bool = True) -> dict:
    with _lock:
        hit = _cache.get(include_machines)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    data = _read(include_machines)
    with _lock:
        _cache[include_machines] = (time.time(), data)
    return data
