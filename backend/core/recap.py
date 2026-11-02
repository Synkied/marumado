"""What was done on a project over some days, written by Claude from what the agents were told and did there.

The usage ledger (core/daily.py) knows which session records worked in a project's folder, and when. Those records
hold what the agents were told (your prompts), the files they changed and what they said back. With the project's
commits and its tasks finished in those days, that is the material: Claude (`claude -p`, where the agents run, with
the owner's login, through herdr.execute) turns it into a few lines. Records go after 30 days (Claude Code deletes
them); commits and tasks stay, so an old span is summed up from those alone.

Summaries are kept in a Setting (`usage_recaps`) by project and days, so the page shows them again.
"""
import base64
import logging
import shlex
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

from . import daily, herdr, transcripts

log = logging.getLogger(__name__)

KEY = 'usage_recaps'
KEEP = 200  # summaries kept, newest first
RECORD_BYTES = 24 * 1024 * 1024  # read at most this much of one record
BYTES = 64 * 1024 * 1024  # and of every record together
LINE = 256 * 1024  # lines longer than this (pictures, long tool output) are left out: no prompt is that long
MATERIAL = 40_000  # characters of material given to Claude
MODEL = 'haiku'
SECONDS = 240

_lock = threading.Lock()


def _bounds(start: str, end: str, tz: str) -> tuple[int, int]:
    """The days [start, end] in `tz` as epoch milliseconds [from, to)."""
    zone = daily._zone(tz)
    a = datetime.strptime(start, '%Y-%m-%d').replace(tzinfo=zone)
    b = datetime.strptime(end, '%Y-%m-%d').replace(tzinfo=zone) + timedelta(days=1)
    if b <= a:
        raise ValueError('The days end before they start.')
    return int(a.timestamp() * 1000), int(b.timestamp() * 1000)


def _hours_in(rec: dict, lo: int, hi: int) -> bool:
    for hour in rec.get('hours') or {}:
        at = int(datetime.strptime(hour, '%Y-%m-%dT%H').replace(tzinfo=timezone.utc).timestamp() * 1000)
        if lo - 3_600_000 < at < hi:
            return True
    return False


def _sessions(src, project: str, lo: int, hi: int) -> list[dict]:
    """The project's sessions in [lo, hi) in this source's records: per record, the prompts, files edited and the
    last thing the agent said, with when."""
    seen = daily._seen.get(src.id)
    ledger = seen[1] if seen else daily.collect(src)[0]
    names = daily._project_names(src)
    wanted = [(path, rec) for path, rec in ledger.get('files', {}).items()
              if '/subagents/' not in path and daily._folder_name(rec.get('folder', ''), names) == project and _hours_in(rec, lo, hi)]
    out, budget = [], BYTES
    for path, rec in sorted(wanted, key=lambda pr: -pr[1].get('offset', 0)):
        size = min(rec.get('offset', 0), RECORD_BYTES)
        if size <= 0 or size > budget:
            continue
        budget -= size
        try:
            # The record's end, if it is long: its first lines can be weeks older than the days asked for.
            data = herdr.shell(src, f'tail -c {size} -- {shlex.quote(path)} | awk \'length($0) <= {LINE}\'', timeout=120)
        except RuntimeError as exc:
            log.debug('reading %s for a recap failed: %s', path, exc)
            continue
        kind = rec.get('kind') or daily._kind(path)
        parser = transcripts.Parser(kind, '')
        parser.feed(data if size == rec.get('offset', 0) else data[data.find(b'\n') + 1:])
        steps = [s for s in parser.steps if lo <= (s.get('t') or 0) < hi]
        prompts = [s for s in steps if s['kind'] == 'you' and s['title'] not in ('Interrupted',) and not s['title'].startswith('Sent ')
                   and not (s['title'].startswith('/') and ' ' not in s['title'].strip())]
        if not prompts:
            continue
        files: dict[str, None] = {}
        for s in steps:
            for f in s.get('files') or []:
                rel = parser.rel(f.get('path') or '')
                files['/'.join(rel.split('/')[-3:]) if rel.startswith('/') else rel] = None
        said = [s for s in steps if s['kind'] == 'say']
        out.append({
            'kind': kind, 'source': src.name, 'start': steps[0]['t'],
            'prompts': [transcripts.clip(s['detail'] or s['title'], 700) for s in prompts],
            'files': list(files)[:40],
            'last': transcripts.clip(said[-1]['detail'] or said[-1]['title'], 900) if said else '',
        })
    return out


def _commits(path: str, lo: int, hi: int) -> list[str]:
    if not path or not Path(path).is_dir():
        return []
    try:
        res = subprocess.run(
            ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', f'safe.directory={path}', '-C', path, 'log',
             '--all', '--no-merges', f'--since=@{lo // 1000}', f'--until=@{hi // 1000}', '--date=short', '--pretty=format:%ad %s', '-n', '120'],
            capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [line for line in res.stdout.splitlines() if line.strip()] if res.returncode == 0 else []


def _tasks(project: str, lo: int, hi: int) -> list[str]:
    from .models import Task
    a = datetime.fromtimestamp(lo / 1000, timezone.utc)
    b = datetime.fromtimestamp(hi / 1000, timezone.utc)
    done = Task.objects.filter(project__name=project, finished_at__gte=a, finished_at__lt=b).order_by('finished_at')
    return [f"{t.title} ({t.get_state_display().lower()})" for t in done[:60]]


def material(project: str, start: str, end: str, tz: str = '', include_machines: bool = True) -> dict:
    """What there is to go on for `project` over the days [start, end] in `tz`: sessions from every source (another
    machine's through its Marumado), and, from this Marumado, its commits and finished tasks."""
    lo, hi = _bounds(start, end, tz)
    sessions, errors = [], []
    for src in herdr.sources(include_machines):
        try:
            if src.kind == 'machine':
                data = herdr._remote(src, 'GET', 'usage/recap/material',
                                     query=f'machines=0&project={quote(project)}&from={start}&to={end}&tz={quote(tz)}', timeout=150)
                sessions += [{**s, 'source': src.name if s.get('source') == 'This machine' else s.get('source')} for s in data.get('sessions', [])]
            else:
                sessions += _sessions(src, project, lo, hi)
        except Exception as exc:
            errors.append(f'{src.name}: {exc}')
    sessions.sort(key=lambda s: s['start'])
    out = {'sessions': sessions, 'errors': errors}
    if include_machines:
        from .models import Project
        p = Project.objects.filter(name=project).exclude(path='').first()
        out['commits'] = _commits(p.path, lo, hi) if p else []
        out['tasks'] = _tasks(project, lo, hi)
    return out


def _brief(project: str, start: str, end: str, m: dict) -> str:
    days = start if start == end else f'{start} to {end}'
    parts = [f'Project: {project}\nDays: {days}\n']
    if m.get('commits'):
        parts.append('## Commits (newest first)\n' + '\n'.join(f'- {c}' for c in m['commits']))
    if m.get('tasks'):
        parts.append('## Tasks finished\n' + '\n'.join(f'- {t}' for t in m['tasks']))
    for i, s in enumerate(m.get('sessions', []), 1):
        when = time.strftime('%Y-%m-%d %H:%M', time.gmtime(s['start'] / 1000))
        block = [f'## Agent session {i} ({s["kind"]}, {when} UTC)', 'What the agent was asked:']
        block += [f'- {p}' for p in s['prompts']]
        if s.get('files'):
            block.append('Files it changed: ' + ', '.join(s['files']))
        if s.get('last'):
            block.append(f'The last thing it said: {s["last"]}')
        parts.append('\n'.join(block))
    text = '\n\n'.join(parts)
    return text if len(text) <= MATERIAL else text[:MATERIAL] + '\n\n[the rest was cut]'


PROMPT = """You are writing a short work log for a developer, from the material below about one of their projects.
Say what was done on the project in those days: the features built, bugs fixed and changes made. Group related work, \
lead with what matters most, and name concrete things (features, screens, behaviour) the way a teammate would. Never \
name files, paths, functions or commit hashes, and leave out release/version bumps, chit-chat, attempts that were \
redone, and anything not about this project.
Write 2 to 6 bullet points, each one plain sentence starting with "- ". No heading, no intro, no closing line, no \
markdown other than the bullets. Do not use tools. If the material shows nothing was really done, say so in one bullet.

"""


def _write(brief: str) -> str:
    """Claude's summary of `brief`, from the first source where `claude` runs. Raises RuntimeError."""
    body = (PROMPT + brief).encode()
    script = ('PATH="$HOME/.local/bin:$HOME/.claude/local:$HOME/.npm-global/bin:/usr/local/bin:$PATH"; '
              'command -v claude >/dev/null || { echo "Claude Code (claude) is not installed where the agents run."; exit 96; }; '
              f'printf %s {shlex.quote(base64.b64encode(body).decode())} | base64 -d | claude -p --model {MODEL} --output-format text')
    tried = []
    for src in herdr.sources(include_machines=False):
        try:
            code, out = herdr.execute(src, '/tmp', script, timeout=SECONDS)
        except Exception as exc:
            tried.append(f'{src.name}: {exc}')
            continue
        if code == 0 and out.strip():
            return out.strip()
        tried.append(f'{src.name}: {out.strip()[-300:] or f"exit {code}"}')
    raise RuntimeError('; '.join(tried) or 'No agent source to run Claude in.')


def _store() -> dict:
    from .models import Setting
    s = Setting.objects.filter(key=KEY).first()
    return s.value if s and isinstance(s.value, dict) else {}


def _key(project: str, start: str, end: str) -> str:
    return f'{project}\t{start}\t{end}'


def saved(start: str, end: str) -> list[dict]:
    """Every summary kept for the days [start, end]."""
    return [v for k, v in _store().items() if k.endswith(f'\t{start}\t{end}')]


def write(project: str, start: str, end: str, tz: str = '') -> dict:
    """Write (again) the summary of `project` over [start, end], keep it, and return it. Raises RuntimeError,
    ValueError."""
    from .models import Setting
    _bounds(start, end, tz)  # ValueError on a bad day
    m = material(project, start, end, tz)
    counts = {'sessions': len(m['sessions']), 'prompts': sum(len(s['prompts']) for s in m['sessions']),
              'commits': len(m.get('commits', [])), 'tasks': len(m.get('tasks', []))}
    if not counts['prompts'] and not counts['commits'] and not counts['tasks']:
        text = ''
    else:
        text = _write(_brief(project, start, end, m))
    entry = {'project': project, 'from': start, 'to': end, 'text': text, 'at': time.time(), 'counts': counts, 'errors': m['errors']}
    with _lock:
        store = _store()
        store[_key(project, start, end)] = entry
        keep = dict(sorted(store.items(), key=lambda kv: -kv[1].get('at', 0))[:KEEP])
        Setting.objects.update_or_create(key=KEY, defaults={'value': keep})
    return entry

