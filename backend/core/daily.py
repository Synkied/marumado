"""Tokens used each day, by every agent, kept for good in ~/.agents/marumado/usage.json where the agents run.

Agents' session records don't last (Claude Code deletes its own after 30 days), so what they used is summed as they
are written and kept in a ledger of its own: in ~/.agents, which is backed up with the rest of your agent setup. One
ledger per source (this machine, a VM, an SSH host), next to the records it comes from; a machine in Machines keeps
its own, read through its Marumado.

The ledger holds, for each record, how far it has been read and what it used, by UTC hour and model:
  {"version": 1,
   "files": {path: {"kind", "folder", "offset", "state", "hours": {"2026-10-27T13": {model: [calls, input, cache write 5m,
                    cache write 1h, cache read, output, cost]}}}},
   "gone": {"<kind>\\t<folder>": {hour: {model: [...]}}}}
A record that is deleted moves to `gone`, by folder, so what it used stays. Hours, not days: the browser makes days of
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
    ledger.setdefault('version', 1)
    ledger.setdefault('files', {})
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
        for path in [p for p in files if p not in sizes]:  # deleted: keep what it used, by folder
            rec = files.pop(path)
            gone = ledger['gone'].setdefault(f"{rec.get('kind', _kind(path))}\t{rec.get('folder', '')}", {})
            for hour, models in (rec.get('hours') or {}).items():
                for model, row in models.items():
                    _add(gone, hour, model, row)
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
        if wanted:
            for (path, _, _), data in zip(wanted, _read_chunks(src, wanted)):
                kind = _kind(path)
                rec = files.setdefault(path, {'kind': kind, 'folder': _folder(kind, path), 'offset': 0, 'state': {}, 'hours': {}})
                _feed(rec, path, data, kind)
        if json.dumps(ledger, sort_keys=True) != before:
            body = json.dumps(ledger, separators=(',', ':')).encode()
            herdr.shell(src, f'mkdir -p "$HOME/.agents/marumado" && cat > {LEDGER}.tmp && mv {LEDGER}.tmp {LEDGER}',
                        timeout=60, data=body)
        _seen[src.id] = (time.monotonic(), ledger, behind)
        return ledger, behind


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
    for key, by_hour in ledger.get('gone', {}).items():
        put(key.partition('\t')[2], by_hour)


def _zone(name: str):
    try:
        return ZoneInfo(name) if name else timezone.utc
    except (ZoneInfoNotFoundError, ValueError):
        return timezone.utc


def report(include_machines: bool = True, tz: str = '') -> dict:
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
                data = herdr._remote(src, 'GET', 'usage', query=f'machines=0&tz={quote(tz)}', timeout=60)
                # Its own sources, under its name when it calls one "This machine".
                rows += [[r[0], src.name if r[1] == 'This machine' else r[1], *r[2:]] for r in data.get('rows', [])]
                info['behind'] = any(s.get('behind') for s in data.get('sources', []))
            else:
                seen = _seen.get(src.id)
                if seen and time.monotonic() - seen[0] < FRESH:
                    ledger, behind = seen[1], seen[2]
                else:
                    ledger, behind = collect(src)
                info['behind'] = behind
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
