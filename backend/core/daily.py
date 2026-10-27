"""Tokens used each day, by every agent, kept for good in ~/.agents/marumado/usage.json where the agents run.

Agents' session records don't last (Claude Code deletes its own after 30 days), so what they used is summed as they
are written and kept in a ledger of its own: in ~/.agents, which is backed up with the rest of your agent setup. One
ledger per source (this machine, a VM, an SSH host), next to the records it comes from; a machine in Machines keeps
its own, read through its Marumado.

The ledger holds, for each record, how far it has been read and what it used, by UTC hour and model:
  {"version": 2,
   "files": {path: {"kind", "folder", "offset", "state", "hours": {"2026-10-27T13": {model: [calls, input, cache write 5m,
                    cache write 1h, cache read, output, cost]}}}},
   "gone": {path: the same}}
A record that is no longer listed moves to `gone` whole, so what it used stays; listed again (a listing can miss a
record it can't read for a while), it moves back as it was and is never read twice. Hours, not days: the browser makes days of
them in its own time zone. Reading is incremental (`offset`), at most BUDGET bytes a run, so a first run over months of
records catches up over a few runs.
"""
import json
import logging
import re
import shlex
import threading
import time
from datetime import datetime, timezone
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import herdr, transcripts, usage

log = logging.getLogger(__name__)

LEDGER = '"$HOME/.agents/marumado/usage.json"'
SHOWN = '~/.agents/marumado/usage.json'
ROOTS = '"$HOME/.claude/projects" "$HOME/.codex/sessions" "$HOME/.pi/agent/sessions"'
CHUNK = 8 * 1024 * 1024  # at most this much of one record a run
BUDGET = 48 * 1024 * 1024  # and of every record together
FRESH = 90  # seconds: a ledger read this recently is not read again for the page
MARK = '\n@@marumado-usage@@\n'
# A session record: transcripts.RECORD, and Claude Code's sub-agents' records too (<session>/subagents/agent-*.jsonl).
RECORD = re.compile(r'^/(?:[^/\0]+/)*(?:\.claude/projects/[^/\0]+/(?:[^/\0]+/)*[^/\0]+|\.codex/sessions/(?:[^/\0]+/)*rollout-[^/\0]+|\.pi/agent/sessions/[^/\0]+/[^/\0]+)\.jsonl$')

_locks: dict[int, threading.Lock] = {}
_seen: dict[int, tuple[float, dict, bool]] = {}  # source id: (when, ledger, still behind)
_guard = threading.Lock()
_runs: dict[int, list[dict]] = {}  # source id: its last runs, newest last: when, how long, bytes read, calls added
RUNS = 12


def _kind(path: str) -> str:
    return 'codex' if '/.codex/' in path else 'pi' if '/.pi/agent/' in path else 'claude'


def _folder(kind: str, path: str) -> str:
    """Claude Code's and Pi's folder for the record (their working folder, dashed); Codex's is read from the record."""
    if kind == 'codex':
        return ''
    return path.split('/.claude/projects/' if kind == 'claude' else '/.pi/agent/sessions/', 1)[1].split('/', 1)[0]


def _add(hours: dict, hour: str, model: str, row: list) -> None:
    into = hours.setdefault(hour, {}).setdefault(model, [0] * 7)
    for i, v in enumerate(row):
        into[i] = round(into[i] + v, 6) if i == 6 else into[i] + v


def _row(entry: list, sign: int = 1) -> list:
    return [sign, *(sign * v for v in entry[2:7]), sign * (usage.cost(entry) or 0.0)]


def _hour(ms: int) -> str:
    return time.strftime('%Y-%m-%dT%H', time.gmtime(ms / 1000))


def _read_listing(src) -> tuple[dict, dict[str, int]]:
    out = herdr.shell(src, f'cat {LEDGER} 2>/dev/null; printf %s {shlex.quote(MARK)}; '
                           f'find {ROOTS} -type f -name "*.jsonl" -exec stat -c "%s\t%n" {{}} + 2>/dev/null', timeout=60)
    text = out.decode(errors='replace')
    head, _, listing = text.partition(MARK)
    try:
        ledger = json.loads(head) if head.strip() else {}
    except ValueError:
        raise RuntimeError(f'{SHOWN} could not be read: it is not valid JSON.')
    if not isinstance(ledger, dict):
        ledger = {}
    ledger.setdefault('files', {})
    if ledger.get('version', 1) < 2:
        # Version 1 summed the records it no longer listed by folder, and read them again from the start when they
        # came back, so a record a listing missed now and then was counted many times over: its `gone` goes.
        ledger['gone'] = {}
    ledger['version'] = 2
    ledger.setdefault('gone', {})
    sizes = {}
    for line in listing.splitlines():
        size, _, path = line.partition('\t')
        if size.isdigit() and RECORD.match(path) and '/../' not in path:
            sizes[path] = int(size)
    return ledger, sizes


def _read_chunks(src, wanted: list[tuple[str, int, int]]) -> list[bytes]:
    """Each (path, offset, length) as read: `<bytes read>\\n<the bytes>` per record, in order."""
    parts = ['t=$(mktemp) || exit 1']
    for path, offset, n in wanted:
        parts.append(f'tail -c +{offset + 1} -- {shlex.quote(path)} 2>/dev/null | head -c {n} > "$t"; wc -c < "$t"; cat "$t"')
    parts.append('rm -f "$t"')
    out = herdr.shell(src, '\n'.join(parts), timeout=180)
    chunks, at = [], 0
    for _ in wanted:
        end = out.index(b'\n', at)
        n = int(out[at:end].strip() or 0)
        chunks.append(out[end + 1:end + 1 + n])
        at = end + 1 + n
    return chunks


def _feed(rec: dict, path: str, data: bytes, kind: str) -> None:
    """Add what this new piece of the record used to its hours. Only whole lines count: the rest waits for next time."""
    state = rec.setdefault('state', {})
    if state.get('skip'):  # the end of a line too long to read whole (one holding images): no usage there
        cut = data.find(b'\n')
        if cut < 0:
            rec['offset'] += len(data)
            return
        rec['offset'] += cut + 1
        data = data[cut + 1:]
        state.pop('skip')
    end = data.rfind(b'\n')
    if end < 0:
        if len(data) >= CHUNK:
            rec['offset'] += len(data)
            state['skip'] = True
        return
    data = data[:end + 1]
    parser = transcripts.Parser(kind, '')
    last = state.get('last')  # Claude Code and Pi: the last call, which a later line may still grow
    if last and kind != 'codex':
        parser.calls[last[0]] = list(last[1])
    parser._totals = state.get('totals') or {}
    parser._model = state.get('model') or ''
    parser.feed(data)
    hours = rec.setdefault('hours', {})
    for key, entry in parser.calls.items():
        if last and kind != 'codex' and key == last[0]:
            if entry == last[1]:
                continue
            _add(hours, _hour(last[1][0]), last[1][1] or '?', _row(last[1], -1))
        _add(hours, _hour(entry[0]), entry[1] or '?', _row(entry))
    if parser.calls and kind != 'codex':
        key = next(reversed(parser.calls))
        state['last'] = [key, parser.calls[key]]
    state['totals'], state['model'] = parser._totals, parser._model
    if kind == 'codex' and parser.cwd and not rec.get('folder'):
        rec['folder'] = parser.cwd
    rec['offset'] += len(data)


def collect(src) -> tuple[dict, bool]:
    """Read what the source's records added since the last run into its ledger, and write it back. (ledger, behind):
    `behind` when there is more to read than one run reads. Raises RuntimeError."""
    src = herdr.get_source(src)
    with _guard:
        lock = _locks.setdefault(src.id, threading.Lock())
    with lock:
        ledger, sizes = _read_listing(src)
        files, before = ledger['files'], json.dumps(ledger, sort_keys=True)
        gone = ledger['gone']
        for path in [p for p in files if p not in sizes]:  # deleted, or not readable for now: keep it whole
            gone[path] = files.pop(path)
        for path in [p for p in gone if p in sizes]:  # listed again: back as it was, read on from where it was
            files[path] = gone.pop(path)
        wanted, budget, behind = [], BUDGET, False
        for path, size in sorted(sizes.items(), key=lambda kv: kv[1] - (files.get(kv[0]) or {}).get('offset', 0)):
            rec = files.get(path)
            if rec and size < rec['offset']:  # rewritten from the start: read it again
                rec.update(offset=0, state={}, hours={})
            offset = rec['offset'] if rec else 0
            if size <= offset:
                continue
            n = min(size - offset, CHUNK, budget)
            if n <= 0:
                behind = True
                break
            wanted.append((path, offset, n))
            budget -= n
            behind = behind or n < size - offset
        started, read, calls = time.time(), 0, 0
        if wanted:
            for (path, _, _), data in zip(wanted, _read_chunks(src, wanted)):
                kind = _kind(path)
                rec = files.setdefault(path, {'kind': kind, 'folder': _folder(kind, path), 'offset': 0, 'state': {}, 'hours': {}})
                was = _calls(rec)
                _feed(rec, path, data, kind)
                read += len(data)
                calls += _calls(rec) - was
        runs = _runs.setdefault(src.id, [])
        runs.append({'at': started, 'took': round(time.time() - started, 2), 'read': read, 'calls': calls, 'records': len(wanted),
                     'tracked': len(files), 'done': sum(min(r['offset'], sizes.get(p, 0)) for p, r in files.items()),
                     'size': sum(sizes.values())})
        del runs[:-RUNS]
        if json.dumps(ledger, sort_keys=True) != before:
            body = json.dumps(ledger, separators=(',', ':')).encode()
            herdr.shell(src, f'mkdir -p "$HOME/.agents/marumado" && cat > {LEDGER}.tmp && mv {LEDGER}.tmp {LEDGER}',
                        timeout=60, data=body)
        _seen[src.id] = (time.monotonic(), ledger, behind)
        return ledger, behind


def _calls(rec: dict) -> int:
    return sum(r[0] for models in (rec.get('hours') or {}).values() for r in models.values())


def progress(src_id: int) -> dict:
    """How the collector is doing on a source: its last run's records tracked, bytes read of all there are, and its
    recent runs (newest first)."""
    runs = _runs.get(src_id) or []
    last = runs[-1] if runs else {}
    return {'tracked': last.get('tracked', 0), 'done': last.get('done', 0), 'size': last.get('size', 0),
            'runs': [{k: r[k] for k in ('at', 'took', 'read', 'calls', 'records')} for r in reversed(runs)]}


def collect_all(now: float = 0) -> bool:
    """Every source of this machine's own (another machine's Marumado keeps its own). True when one is still behind."""
    behind = False
    for src in herdr.sources(include_machines=False):
        try:
            behind = collect(src)[1] or behind
        except Exception as exc:
            log.debug('collecting the usage of %s failed: %s', src.name, exc)
    return behind


def _project_names(src) -> dict[str, str]:
    """Each project, by the folder key its agents' records go under: Claude Code's and Pi's dashed folders, and the
    folder itself (Codex)."""
    from .models import Project
    names = {}
    for p in Project.objects.exclude(path='').only('name', 'path'):
        there = herdr.folder_in(p.path, src).rstrip('/')
        names[transcripts.claude_folder(there)] = p.name
        names[transcripts.pi_folder(there)] = p.name
        names[there] = p.name
    return names


def _folder_name(folder: str, names: dict[str, str]) -> str:
    if folder in names:
        return names[folder]
    best = max((k for k in names if k.startswith('/') and folder.startswith(k + '/')), key=len, default='')
    if best:
        return names[best]
    # Not a project here: its folder's last part (a dashed folder can't be told apart from dashes in its name, so
    # what follows the last `projects-` stands for it).
    name = folder.strip('-').rsplit('/', 1)[-1]
    return name.rsplit('projects-', 1)[-1] or 'elsewhere'


def _day_of(zone):
    """A UTC hour's day in `zone`, remembered: a ledger repeats the same hours many times."""
    seen: dict[str, str] = {}

    def day(hour: str) -> str:
        if hour not in seen:
            at = datetime.strptime(hour, '%Y-%m-%dT%H').replace(tzinfo=timezone.utc)
            seen[hour] = at.astimezone(zone).strftime('%Y-%m-%d')
        return seen[hour]
    return day


def days(src, out: dict, names: dict[str, str], ledger: dict, day) -> None:
    """Add the ledger's hours to `out`, by (day, source, project, model): [calls, input, cache write 5m, 1h, read,
    output, cost]."""
    def put(folder: str, by_hour: dict):
        project = _folder_name(folder, names)
        for hour, models in by_hour.items():
            d = day(hour)
            for model, r in models.items():
                if r[0]:
                    _add(out, (d, src.name, project), model, r)
    for rec in ledger.get('files', {}).values():
        put(rec.get('folder', ''), rec.get('hours') or {})
    for rec in ledger.get('gone', {}).values():
        put(rec.get('folder', ''), rec.get('hours') or {})


def _zone(name: str):
    try:
        return ZoneInfo(name) if name else timezone.utc
    except (ZoneInfoNotFoundError, ValueError):
        return timezone.utc


def report(include_machines: bool = True, tz: str = '', fresh: bool = False) -> dict:
    """What every source's agents used, by day in the time zone `tz` (the browser's; UTC by default), source, project
    and model: rows of [day, source, project, model, calls, input, cache write 5m, cache write 1h, cache read, output,
    cost], newest day first. With how each source's ledger is doing, and which models have a known price."""
    out: dict = {}
    day = _day_of(_zone(tz))
    sources: list[dict] = []
    rows: list = []
    for src in herdr.sources(include_machines):
        info = {'id': src.id, 'name': src.name, 'where': src.where(), 'stored': SHOWN, 'ok': True, 'error': '', 'behind': False}
        try:
            if src.kind == 'machine':
                data = herdr._remote(src, 'GET', 'usage', query=f'machines=0&tz={quote(tz)}{"&fresh=1" if fresh else ""}', timeout=60)
                # Its own sources, under its name when it calls one "This machine".
                rows += [[r[0], src.name if r[1] == 'This machine' else r[1], *r[2:]] for r in data.get('rows', [])]
                theirs = data.get('sources', [])
                info['behind'] = any(s.get('behind') for s in theirs)
                info.update(tracked=sum(s.get('tracked', 0) for s in theirs), done=sum(s.get('done', 0) for s in theirs),
                            size=sum(s.get('size', 0) for s in theirs),
                            runs=sorted((r for s in theirs for r in s.get('runs', [])), key=lambda r: -r['at'])[:RUNS])
            else:
                seen = _seen.get(src.id)
                if seen and not fresh and time.monotonic() - seen[0] < FRESH:
                    ledger, behind = seen[1], seen[2]
                else:
                    ledger, behind = collect(src)
                info['behind'] = behind
                info.update(progress(src.id))
                days(src, out, _project_names(src), ledger, day)
        except Exception as exc:
            info.update(ok=False, error=str(exc))
        sources.append(info)
    for key, models in out.items():
        for model, r in models.items():
            rows.append([*key, model, *r])
    rows.sort(key=lambda r: r[0], reverse=True)
    priced = sorted({r[3] for r in rows if usage.price(r[3]) is not None})
    return {'rows': rows, 'sources': sources, 'priced': priced}


CHECK_RECORDS = 12
CHECK_BYTES = 96 * 1024 * 1024


def _ids(kind: str, data: bytes, day, on: str) -> tuple[set[str], list[int]]:
    """A record read in one go: the ids of its model calls on the day `on`, and their [calls, tokens]."""
    parser = transcripts.Parser(kind, '')
    parser.feed(data)
    ids, sums = set(), [0, 0]
    for key, e in parser.calls.items():
        if e[0] and day(_hour(e[0])) == on:
            ids.add(key if not key.isdigit() else f'{key}@{e[0]}')
            sums[0] += 1
            sums[1] += sum(e[2:7])
    return ids, sums


def check(day_key: str, tz: str = '') -> dict:
    """Where a day's tokens come from, to tell a collector fault from records that hold the same calls: per source,
    the records that used most that day, each with what the ledger holds and what reading it again in one go finds,
    and how many of its calls are in another of those records too."""
    day = _day_of(_zone(tz))
    out = []
    for src in herdr.sources(include_machines=True):
        if src.kind == 'machine':
            try:
                data = herdr._remote(src, 'GET', 'usage/check', query=f'machines=0&day={quote(day_key)}&tz={quote(tz)}', timeout=120)
                out += [{**s, 'name': src.name if s['name'] == 'This machine' else s['name']} for s in data.get('sources', [])]
            except Exception as exc:
                out.append({'id': src.id, 'name': src.name, 'error': str(exc), 'records': []})
            continue
        info = {'id': src.id, 'name': src.name, 'error': '', 'records': [], 'calls': 0, 'tokens': 0}
        try:
            ledger, _ = collect(src)
            per = []
            for path, rec in [*ledger['files'].items(), *ledger['gone'].items()]:
                c = t = 0
                for hour, models in (rec.get('hours') or {}).items():
                    if day(hour) == day_key:
                        for r in models.values():
                            c, t = c + r[0], t + sum(r[1:6])
                if c:
                    per.append((t, c, path, rec))
            info['calls'] += sum(c for _, c, _, _ in per)
            info['tokens'] += sum(t for t, _, _, _ in per)
            info['count'] = len(per)
            per.sort(key=lambda x: -x[0])
            top = per[:CHECK_RECORDS]
            seen: dict[str, int] = {}
            ids: dict[str, set] = {}
            budget = CHECK_BYTES
            for t, c, path, rec in top:
                listed = path in ledger['files']
                row = {'path': path, 'kind': rec.get('kind'), 'offset': rec.get('offset', 0), 'ledger': [c, t], 'again': None, 'shared': 0,
                       'listed': listed}
                info['records'].append(row)
                if not listed or rec['offset'] > budget:
                    continue
                budget -= rec['offset']
                data = herdr.shell(src, f'head -c {rec["offset"]} -- {shlex.quote(path)}', timeout=120)
                ids[path], row['again'] = _ids(rec.get('kind') or _kind(path), data, day, day_key)
                for i in ids[path]:
                    seen[i] = seen.get(i, 0) + 1
            for row in info['records']:
                row['shared'] = sum(1 for i in ids.get(row['path'], ()) if seen[i] > 1)
        except Exception as exc:
            info['error'] = str(exc)
        out.append(info)
    return {'day': day_key, 'sources': out}
