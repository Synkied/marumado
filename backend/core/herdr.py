"""The coding agents (and plain terminals) running in Herdr (https://herdr.dev): list them, read them, open a terminal, and stream it.
Herdr may run in several places at once (sources: the one set in .env, plus VMs and servers added in the app).

Listing and reading never touch an agent. The live terminal (core/terminal.py) types into it only in
`control` mode (as does send(), the phone-sized prompt box), which MARUMADO_HERDR_TERMINAL can turn down to `observe` or `off`.
"""
import json
import logging
import os
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from marumado.settings import env

from . import sshhome

log = logging.getLogger(__name__)

PANE_ID = re.compile(r'^w[0-9A-Za-z]+:p[0-9A-Za-z]+$')
WORKSPACE_ID = re.compile(r'^w[0-9A-Za-z]+$')
# A branch Marumado names for a plan's step: no spaces, no leading dash, no '..'.
BRANCH = re.compile(r'^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$')
TIMEOUT = 4

# Where Herdr runs, from .env:
#   MARUMADO_HERDR_SMOLVM  the smolvm machine your agents live in (its --name). In Docker, `make up`
#                          mounts the host's smolvm and sets MARUMADO_SMOLVM_HOME/_USER so it runs
#                          as you, against your machines.
#   MARUMADO_HERDR_EXEC    a command that runs things inside the VM your agents live in, e.g.
#                          `smolvm machine exec my-vm --`; Herdr runs as `<that> sh -c 'herdr …'`.
#   MARUMADO_HERDR_SSH     run it on another machine over SSH (user@host or a ~/.ssh/config alias).
#                          Needs key login (no password prompt).
#   MARUMADO_HERDR_BIN     the herdr binary, on this machine or on the SSH host.
#   MARUMADO_HERDR_SOCKET  Herdr's API socket, when it isn't the default one (e.g. mounted into Docker).
#   MARUMADO_HERDR_TERMINAL  control (default): the live terminal in the browser can type into agents;
#                          observe: it only watches; off: no live terminal, just polled output.
#
# More places can be added in the app (Agents → Sources, the AgentSource model): SSH hosts and smolvm machines.
# Every machine in Machines whose Marumado sees a Herdr is a source too (kind `machine`): it is asked through
# that Marumado's API and tunnel, so it is never registered twice.
# Every agent is listed with the source it runs in, since pane ids are only unique within one Herdr.

ENV = 0  # the source set in .env
MACHINE_BASE = 1_000_000  # a machine's source id is this plus its id (AgentSource ids stay far below)
SMOLVM_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$')
# A source that failed is not asked again for a few seconds, so one VM that is off doesn't slow every listing.
RETRY_SECONDS = 15


@dataclass(frozen=True)
class Source:
    """One place Herdr runs. `kind`: env (configured in .env), ssh or smolvm (added in the app)."""
    id: int
    name: str
    kind: str
    target: str = ''
    # Where it sees this machine's folders: (here, there) pairs, as set on the source.
    folders: tuple[tuple[str, str], ...] = field(default=(), compare=False)

    def where(self) -> str:
        """A short description of where Marumado looks for Herdr."""
        if self.kind == 'machine':
            return f"on {self.name}, through its Marumado"
        if self.kind == 'ssh':
            return f'over SSH on {self.target}'
        if self.kind == 'smolvm':
            return f'in the smolvm machine {self.target}'
        if env('HERDR_SMOLVM'):
            return f"in the smolvm machine {env('HERDR_SMOLVM')}"
        if env('HERDR_EXEC'):
            return f"through {env('HERDR_EXEC').strip()}"
        if env('HERDR_SSH'):
            return f"over SSH on {env('HERDR_SSH')}"
        return 'on this machine'


ENV_FOLDERS = 'env_source_folders'


def _pairs(folders) -> tuple[tuple[str, str], ...]:
    return tuple((f['here'], f['there']) for f in folders or [] if isinstance(f, dict) and f.get('here') and f.get('there'))


def env_folders() -> list[dict]:
    """The .env source's folders, set in Agents → Sources (they live in the database, not .env)."""
    from .models import Setting
    try:
        found = Setting.objects.filter(key=ENV_FOLDERS).first()
    except Exception:  # the database isn't ready (first start, migrations)
        return []
    return list(found.value) if found and isinstance(found.value, list) else []


def set_env_folders(folders: list[dict]) -> None:
    from .models import Setting
    Setting.objects.update_or_create(key=ENV_FOLDERS, defaults={'value': folders})


FOLDER_SOURCES = 'folder_agent_sources'


def folder_sources() -> dict[str, int]:
    """The default agent source of scan folders, by folder: every project in one starts its agents there, unless it
    has its own (Project.agent_source). Set in Projects → Folders."""
    from .models import Setting
    try:
        found = Setting.objects.filter(key=FOLDER_SOURCES).first()
    except Exception:  # the database isn't ready (first start, migrations)
        return {}
    value = found.value if found and isinstance(found.value, dict) else {}
    return {k: v for k, v in value.items() if isinstance(v, int)}


def set_folder_source(folder: str, source_id: int | None) -> None:
    from .models import Setting
    value = folder_sources()
    if source_id is None:
        value.pop(folder, None)
    else:
        value[folder] = source_id
    Setting.objects.update_or_create(key=FOLDER_SOURCES, defaults={'value': value})


def forget_folder_source(source_id: int) -> None:
    """A source was removed: the folders that started their agents there go back to no default."""
    value = folder_sources()
    if source_id in value.values():
        from .models import Setting
        Setting.objects.update_or_create(key=FOLDER_SOURCES, defaults={'value': {k: v for k, v in value.items() if v != source_id}})


def source_of_folder(path: str, defaults: dict[str, int]) -> int | None:
    """The default source of the deepest folder in `defaults` that holds `path`, or None."""
    best = max((f for f in defaults if path and (path == f or path.startswith(f.rstrip('/') + '/'))), key=len, default=None)
    return defaults[best] if best is not None else None


def clean_folders(value) -> list[dict]:
    """[{here, there}, …] with both absolute folders, without trailing slashes. Raises ValueError otherwise."""
    if not isinstance(value, list):
        raise ValueError('Send a list of {here, there} folders.')
    cleaned = []
    for row in value:
        if not isinstance(row, dict) or not isinstance(row.get('here'), str) or not isinstance(row.get('there'), str):
            raise ValueError('Each folder needs here and there.')
        here, there = row['here'].strip(), row['there'].strip()
        if not here and not there:
            continue
        if not here.startswith('/') or not there.startswith('/'):
            raise ValueError('Folders start with /, like /home/you/projects.')
        cleaned.append({'here': here.rstrip('/') or '/', 'there': there.rstrip('/') or '/'})
    return cleaned


def _swap(path: str, pairs) -> str:
    """`path` with the longest matching folder `a` of the (a, b) pairs replaced by `b`; as it is if none match."""
    best = None
    for a, b in pairs:
        if path == a or path.startswith(a.rstrip('/') + '/'):
            if best is None or len(a) > len(best[0]):
                best = (a, b)
    if best is None:
        return path
    rest = path[len(best[0].rstrip('/')):]
    return (best[1].rstrip('/') + rest) or '/'


def folder_in(path: str, source: 'int | Source' = ENV) -> str:
    """`path` (a folder on this machine) as Herdr in `source` sees it, by the source's folders."""
    return _swap(path, get_source(source).folders) if path else path


def folder_here(path: str, source: 'int | Source' = ENV) -> str:
    """A folder in `source` (an agent's) as this machine sees it: folder_in() the other way."""
    return _swap(path, [(b, a) for a, b in get_source(source).folders]) if path else path


def _env_source() -> Source:
    name = env('HERDR_SMOLVM') or env('HERDR_SSH') or ('VM' if env('HERDR_EXEC') else 'This machine')
    return Source(ENV, name, 'env', folders=_pairs(env_folders()))


def _local_binary() -> str | None:
    if env('HERDR_BIN'):
        return env('HERDR_BIN')
    found = shutil.which('herdr')
    if found:
        return found
    default = Path.home() / '.local' / 'bin' / 'herdr'
    return str(default) if default.exists() else None


def _machine_source(tunnel) -> Source:
    return Source(MACHINE_BASE + tunnel.id, tunnel.name, 'machine', str(tunnel.id))


def _machine_sources() -> list[Source]:
    """The machines in Machines whose Marumado last said it sees a Herdr. One that is down or has none is left out:
    the machine being down is news in Machines already."""
    from . import machines
    return [_machine_source(t) for t in machines.tunnels()
            if t.state == 'up' and ((t.overview or {}).get('agents') or {}).get('available')]


def sources(include_machines: bool = True) -> list[Source]:
    """Every place to look for agents: the one in .env, then those added in the app, then other machines'.
    The .env one is left out when nothing points at it (no MARUMADO_HERDR_*, no local herdr) and other sources exist.
    `include_machines` False: only this machine's own (what another Marumado asks for, so two never ask each other in a loop)."""
    from .models import AgentSource
    added = [Source(s.id, s.name, s.kind, s.target, _pairs(s.folders)) for s in AgentSource.objects.all()]
    if include_machines:
        added += _machine_sources()
    configured = any(env(k) for k in ('HERDR_SMOLVM', 'HERDR_EXEC', 'HERDR_SSH', 'HERDR_SOCKET'))
    if added and not configured and not _local_binary():
        return added
    return [_env_source(), *added]


def get_source(source_id: 'int | str | Source | None' = ENV) -> Source:
    """The source with this id (a Source is passed through). Raises ValueError for an unknown one."""
    if isinstance(source_id, Source):
        return source_id
    try:
        wanted = int(source_id or ENV)
    except (TypeError, ValueError):
        raise ValueError('Not an agent source.')
    if wanted == ENV:
        return _env_source()
    if wanted >= MACHINE_BASE:
        from . import machines
        tunnel = machines.get(wanted - MACHINE_BASE)
        if tunnel is None:
            raise ValueError('That machine is no longer in Machines.')
        return _machine_source(tunnel)
    from .models import AgentSource
    found = AgentSource.objects.filter(pk=wanted).first()
    if found is None:
        raise ValueError('That agent source no longer exists.')
    return Source(found.id, found.name, found.kind, found.target, _pairs(found.folders))


def _remote(src: Source, method: str, path: str, payload: dict | None = None, query: str = '', timeout: float = TIMEOUT + 6):
    """Call the Herdr API of the Marumado on another machine (its own .env source), through its tunnel."""
    from . import machines
    tunnel = machines.get(int(src.target))
    if tunnel is None:
        raise RuntimeError(f'{src.name} is no longer in Machines.')
    body = json.dumps(payload).encode() if payload is not None else b''
    try:
        res = tunnel.request(method, path, '&'.join(filter(None, ['source=0', query])), body,
                             'application/json' if payload is not None else '', timeout=timeout)
    except machines.Unavailable as exc:
        raise RuntimeError(str(exc))
    if res.status_code == 204:
        return None
    try:
        data = res.json()
    except ValueError:
        data = {}
    if res.status_code == 404 and not (isinstance(data, dict) and data.get('detail')):
        raise RuntimeError(f"{src.name}'s Marumado can't do that yet: update it.")
    if res.status_code >= 400:
        detail = data.get('detail') if isinstance(data, dict) else ''
        raise RuntimeError(detail or f'{src.name} answered with an error ({res.status_code}).')
    return data


def valid_target(kind: str, target: str) -> bool:
    """An SSH target or a smolvm machine name, safe to pass on the command line."""
    if kind == 'ssh':
        from .machines import valid_target as valid_ssh
        return valid_ssh(target)
    return kind == 'smolvm' and bool(SMOLVM_NAME.match(target))


def where() -> str:
    """Where the .env source looks for Herdr."""
    return _env_source().where()


def terminal_mode() -> str:
    mode = env('HERDR_TERMINAL', 'control').strip().lower()
    return mode if mode in ('control', 'observe', 'off') else 'control'


def _smolvm(machine: str, interactive: bool = False) -> tuple[list[str], dict | None]:
    """`smolvm machine exec`, run as the host user when the host's smolvm is mounted into Docker."""
    home, user = env('SMOLVM_HOME'), env('SMOLVM_USER')
    if home and user:
        uid, _, gid = user.partition(':')
        binary = f'{home}/.smolvm/smolvm'
        prefix = ['setpriv', f'--reuid={uid}', f'--regid={gid or uid}', '--clear-groups', binary]
        return [*prefix, 'machine', 'exec', *(['-i'] if interactive else []), '--name', machine, '--'], {**os.environ, 'HOME': home}
    binary = shutil.which('smolvm') or next(
        (str(p) for p in (Path.home() / '.local/bin/smolvm', Path.home() / '.smolvm/smolvm') if p.exists()), None)
    if not binary:
        raise RuntimeError('smolvm is not installed on this machine.')
    return [binary, 'machine', 'exec', *(['-i'] if interactive else []), '--name', machine, '--'], None


def _ssh(target: str, remote: str) -> list[str]:
    sshhome.prepare()
    return ['ssh', '-o', 'BatchMode=yes', '-o', f'ConnectTimeout={TIMEOUT - 1}', target, remote]


def _elsewhere(src: Source) -> tuple[str, str, str]:
    """(smolvm machine, exec command, SSH target): where `src` runs, when it isn't this machine."""
    smolvm = src.target if src.kind == 'smolvm' else env('HERDR_SMOLVM') if src.kind == 'env' else ''
    ssh = src.target if src.kind == 'ssh' else env('HERDR_SSH') if src.kind == 'env' else ''
    exec_ = env('HERDR_EXEC') if src.kind == 'env' else ''
    return smolvm, exec_, ssh


def _wrap(src: Source, remote: str, interactive: bool = False) -> tuple[list[str], dict | None]:
    """The command line that runs the shell script `remote` where `src` is (not this machine)."""
    smolvm, exec_, ssh = _elsewhere(src)
    # VM exec tools may start commands with a bare environment.
    remote = 'export HOME="${HOME:-/root}" PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"; ' + remote
    if smolvm:
        prefix, environ = _smolvm(smolvm, interactive)
        return [*prefix, 'sh', '-c', remote], environ
    if exec_:
        return [*shlex.split(exec_), 'sh', '-c', remote], None
    return _ssh(ssh, remote), None


def _command(src: Source, args: tuple[str, ...], interactive: bool = False) -> tuple[list[str], dict | None]:
    """The command line that runs `herdr <args>` wherever `src` is. `interactive` keeps stdin connected."""
    if any(_elsewhere(src)):
        # MARUMADO_HERDR_BIN names the binary on the .env source only; sources added in the app find it themselves.
        given = env('HERDR_BIN') if src.kind == 'env' else ''
        binary = shlex.quote(given) if given else '"$(command -v herdr || echo "$HOME/.local/bin/herdr")"'
        return _wrap(src, ' '.join([binary, *map(shlex.quote, args)]), interactive)
    binary = _local_binary()
    if not binary:
        raise RuntimeError('Herdr is not installed on this machine. If it runs elsewhere, add it under Agents → Sources, or set MARUMADO_HERDR_SMOLVM, MARUMADO_HERDR_EXEC or MARUMADO_HERDR_SSH.')
    extra = {'HERDR_SOCKET_PATH': env('HERDR_SOCKET')} if env('HERDR_SOCKET') else {}
    return [binary, *args], {**os.environ, **extra}


def _run(src: Source, *args: str, text: bool = False, timeout: float = TIMEOUT + 4):
    cmd, environ = _command(src, args)
    try:
        # A session of its own, so a timeout kills everything it started: VM exec tools leave helpers holding
        # the output pipes, which would otherwise keep us waiting on them forever.
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, env=environ, start_new_session=True)
    except FileNotFoundError:
        raise RuntimeError(f'{cmd[0]} is not installed.')
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            proc.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        raise RuntimeError(f'Herdr did not answer in time ({src.where()}).')
    out = subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)
    if out.returncode != 0:
        try:
            message = json.loads(out.stderr)['error']['message']
        except (ValueError, KeyError, TypeError):
            message = out.stderr.strip().splitlines()[-1] if out.stderr.strip() else 'Herdr returned an error.'
        if out.returncode == 255 and cmd[0] == 'ssh':
            raise RuntimeError(f'SSH to {cmd[-2]} failed: {message}')
        raise RuntimeError(f'Herdr is not running {src.where()} ({message}).' if 'socket' in message.lower() or 'server' in message.lower() else message)
    return out.stdout if text else json.loads(out.stdout)['result']


def shell(src: 'int | Source', script: str, timeout: float = TIMEOUT + 8) -> bytes:
    """Run a shell script where the agents of `src` run (this machine, a VM or an SSH host), and return what it printed.
    Not for a machine in Machines: that one is asked through its Marumado. Raises RuntimeError."""
    src = get_source(src)
    if src.kind == 'machine':
        raise RuntimeError(f"{src.name}'s files are read through its Marumado.")
    cmd, environ = _wrap(src, script) if any(_elsewhere(src)) else (['sh', '-c', script], None)
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=environ, start_new_session=True)
    except FileNotFoundError:
        raise RuntimeError(f'{cmd[0]} is not installed.')
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        raise RuntimeError(f'No answer in time ({src.where()}).')
    if proc.returncode == 255 and cmd[0] == 'ssh':
        raise RuntimeError(f"SSH to {cmd[-2]} failed: {stderr.decode(errors='replace').strip()}")
    return stdout


_failed_lock = threading.Lock()
_failed: dict[Source, tuple[float, str]] = {}

# Herdr reports a finished turn as `done` until a focus command marks it seen; reads and attaches don't count, and
# focusing would move the Herdr TUI under the user. So Marumado keeps its own: a pane open in a Marumado terminal is
# being looked at, and the turns it finished by then (Herdr's completion_seq) read as `idle` from then on. So is one
# whose conversation is open (it reads the session record every few seconds while the page is in view: looked()).
_seen_lock = threading.Lock()
_watching: dict[tuple[int, str], int] = {}
_looked: dict[tuple[int, str], float] = {}
LOOK_SECONDS = 10  # how long a read of its conversation counts as looking at the pane: more than its polls apart
_closed: set[tuple[int, str]] = set()  # closed since the last listing: counted once more
_seen: dict[tuple[int, str, str], int] = {}


def watch(source_id: int, pane_id: str) -> None:
    """A Marumado terminal opened on the pane."""
    with _seen_lock:
        _watching[(source_id, pane_id)] = _watching.get((source_id, pane_id), 0) + 1


def looked(source_id: int, pane_id: str) -> None:
    """Its conversation was read, for a page showing it: looked at for LOOK_SECONDS."""
    with _seen_lock:
        if len(_looked) > 500:
            _looked.clear()
        _looked[(source_id, pane_id)] = time.monotonic()


def unwatch(source_id: int, pane_id: str) -> None:
    """It closed. The next listing still counts it, so a turn that finished just before is seen too."""
    with _seen_lock:
        n = _watching.pop((source_id, pane_id), 1) - 1
        if n > 0:
            _watching[(source_id, pane_id)] = n
        _closed.add((source_id, pane_id))


def _status(src: Source, pane: dict) -> str:
    status = pane.get('agent_status') or 'unknown'
    done = pane.get('completion_seq')
    if done is None:
        return status
    key = (src.id, pane['pane_id'], pane.get('terminal_id') or '')
    with _seen_lock:
        if key[:2] in _watching or key[:2] in _closed or time.monotonic() - _looked.get(key[:2], -LOOK_SECONDS) < LOOK_SECONDS:
            _seen[key] = max(done, _seen.get(key, 0))
        seen = _seen.get(key, -1)
    return 'idle' if status == 'done' and done <= seen else status


def _settle_watching(src: Source) -> None:
    """After a listing of the source: panes whose terminal closed have had their last look."""
    with _seen_lock:
        _closed.difference_update({k for k in _closed if k[0] == src.id})


def _list(src: Source) -> dict:
    """One source's panes, or why it can't be reached."""
    with _failed_lock:
        failed = _failed.get(src)
    if failed and time.monotonic() - failed[0] < RETRY_SECONDS:
        return {'available': False, 'error': failed[1], 'agents': [], 'workspaces': []}
    if src.kind == 'machine':
        return _list_machine(src)
    try:
        # Every pane, so plain shells (from New terminal, say) can be watched too.
        listed = _run(src, 'pane', 'list')['panes']
        # Only `agent list` carries completion_seq (how a finished turn gets seen) and the agent's name.
        known = {a['pane_id']: a for a in _run(src, 'agent', 'list').get('agents') or []}
        listed = [{**p, **known.get(p['pane_id'], {})} for p in listed]
        spaces = _workspaces(_run(src, 'workspace', 'list')['workspaces'])
    except (RuntimeError, ValueError, KeyError, OSError) as exc:
        with _failed_lock:
            _failed[src] = (time.monotonic(), str(exc))
        return {'available': False, 'error': str(exc), 'agents': [], 'workspaces': []}
    workspaces = {w['id']: w['label'] for w in spaces}
    with _failed_lock:
        _failed.pop(src, None)
    rows = []
    for a in listed:
        rows.append({
            'pane_id': a['pane_id'],
            'source': src.id,
            'name': a.get('name') or '',
            'kind': a.get('agent') or 'terminal',
            'status': _status(src, a),
            'title': a.get('terminal_title_stripped') or '',
            'cwd': a.get('foreground_cwd') or a.get('cwd') or '',
            'workspace': workspaces.get(a.get('workspace_id'), ''),
            'workspace_id': a.get('workspace_id') or '',
            'focused': bool(a.get('focused')),
            # The session Herdr knows the agent is in ({kind: path|id, value}), when its integration reports it.
            **({'session': {'kind': a['agent_session'].get('kind'), 'value': a['agent_session'].get('value')}}
               if isinstance(a.get('agent_session'), dict) and a['agent_session'].get('value') else {}),
        })
    _settle_watching(src)
    return {'available': True, 'error': '', 'agents': rows, 'workspaces': spaces}


def _workspaces(listed: list[dict]) -> list[dict]:
    """Herdr's workspaces, in its order: {id, label, cwd, worktree_of, linked}. A git worktree's workspace is linked to
    its repository's (`worktree_of`), and Herdr closes that one only with its linked ones (`linked` of them)."""
    primary = {}
    for w in listed:
        tree = w.get('worktree') or {}
        if tree.get('repo_key') and not tree.get('is_linked_worktree'):
            primary.setdefault(tree['repo_key'], w['workspace_id'])
    out = []
    for w in listed:
        tree = w.get('worktree') or {}
        of = primary.get(tree.get('repo_key')) if tree.get('is_linked_worktree') else None
        out.append({'id': w['workspace_id'], 'label': w.get('label') or '', 'cwd': tree.get('checkout_path') or '',
                    'worktree_of': of or '', 'linked': 0})
    for w in out:
        w['linked'] = sum(1 for o in out if o['worktree_of'] == w['id'])
    return out


def _list_machine(src: Source) -> dict:
    """The agents of another machine's own Herdr (its .env source), as its Marumado lists them."""
    try:
        data = _remote(src, 'GET', 'agents', query='machines=0')
        own = next((s for s in data.get('sources') or [] if s['id'] == ENV), None)
        available = own['available'] if own else data['available']
        error = (own['error'] if own else data.get('error', '')) or ''
        rows = [{**a, 'source': src.id} for a in data['agents'] if a.get('source', ENV) == ENV]
        # Older Marumados don't list workspaces.
        spaces = (own or {}).get('workspaces') or []
    except (RuntimeError, ValueError, KeyError, TypeError) as exc:
        with _failed_lock:
            _failed[src] = (time.monotonic(), str(exc))
        return {'available': False, 'error': str(exc), 'agents': [], 'workspaces': []}
    with _failed_lock:
        _failed.pop(src, None)
    return {'available': available, 'error': error, 'agents': rows if available else [], 'workspaces': spaces if available else []}


def forget_failures() -> None:
    """Ask every source again on the next listing (after a source is added or changed, say)."""
    with _failed_lock:
        _failed.clear()


def agents(include_machines: bool = True) -> dict:
    """Every live agent in every source, with its state and what its terminal says it is doing.
    `available`: at least one source answered. `sources`: each one, and whether it answered.
    `include_machines` False leaves out other machines' agents (see sources())."""
    try:
        every = sources(include_machines)
    except Exception as exc:  # the database isn't ready (first start, migrations)
        log.warning('listing agent sources failed: %s', exc)
        every = [_env_source()]
    with ThreadPoolExecutor(max_workers=min(8, len(every))) as pool:
        listed = list(pool.map(_list, every))
    rows = [a for one in listed for a in one['agents']]
    errors = [f'{s.name}: {one["error"]}' if len(every) > 1 else one['error'] for s, one in zip(every, listed) if not one['available']]
    return {
        'available': any(one['available'] for one in listed),
        'error': '; '.join(errors),
        'where': ', '.join(s.where() for s in every),
        'terminal': terminal_mode(),
        'kinds': AGENT_KINDS,
        'sources': [{'id': s.id, 'name': s.name, 'kind': s.kind, 'where': s.where(), 'available': one['available'],
                     'folders': [{'here': a, 'there': b} for a, b in s.folders],
                     'error': one['error'], 'agents': len(one['agents']), 'workspaces': one['workspaces']}
                    for s, one in zip(every, listed)],
        'agents': rows,
    }


def read(pane_id: str, lines: int = 80, source: 'int | Source' = ENV) -> str:
    """The agent's recent terminal output, as plain text."""
    src = get_source(source)
    if not PANE_ID.match(pane_id):
        raise ValueError('Not a Herdr pane id.')
    lines = str(max(10, min(lines, 400)))
    if src.kind == 'machine':
        return _remote(src, 'GET', f'agents/{pane_id}/output', query=f'lines={lines}')['output']
    try:
        out = _run(src, 'agent', 'read', pane_id, '--source', 'recent-unwrapped', '--lines', lines, text=True)
    except RuntimeError as exc:
        # Full-screen agents' history can only be scrolled back while idle; show the screen meanwhile.
        if 'source visible' not in str(exc) and 'alternate-screen' not in str(exc):
            raise
        out = _run(src, 'agent', 'read', pane_id, '--source', 'visible', text=True)
    return '\n'.join(line.rstrip() for line in out.splitlines()).strip('\n')


KEYS = frozenset({'esc', 'tab', 'shift+tab', 'enter', 'up', 'down', 'left', 'right', 'backspace', 'space', 'ctrl+c', 'ctrl+d', 'y', 'n', *'0123456789'})
MAX_PROMPT = 16 * 1024


def send(pane_id: str, text: str = '', keys: tuple[str, ...] = (), source: 'int | Source' = ENV) -> None:
    """Type into an agent, for screens too small for the live terminal: a prompt (submitted with Enter) or a few keys."""
    src = get_source(source)
    if not PANE_ID.match(pane_id):
        raise ValueError('Not a Herdr pane id.')
    if keys and (len(keys) > 16 or not set(keys) <= KEYS):
        raise ValueError('Unknown key.')
    if src.kind == 'machine':
        _remote(src, 'POST', f'agents/{pane_id}/input', {'text': text, 'keys': list(keys)})
        return
    if keys:
        _run(src, 'pane', 'send-keys', pane_id, *keys, text=True)
        return
    if not text.strip() or len(text) > MAX_PROMPT:
        raise ValueError('Write a prompt first.' if not text.strip() else 'That prompt is too long.')
    try:
        _run(src, 'agent', 'prompt', pane_id, text, text=True)
    except RuntimeError as exc:
        if 'blocked' in str(exc):
            raise RuntimeError('The agent is waiting on a question: answer it with the keys.')
        if 'not found' not in str(exc) and 'not ready' not in str(exc) and 'foreground' not in str(exc):
            raise
        # Not a recognised agent (a plain shell, say): type the text and press Enter.
        _run(src, 'pane', 'send-text', pane_id, text, text=True)
        _run(src, 'pane', 'send-keys', pane_id, 'enter', text=True)


def new_terminal(near: str = '', source: 'int | Source' = ENV, workspace: str = '') -> dict:
    """Open a shell in a new Herdr tab: beside pane `near` (its workspace and folder), in `workspace`, or in a new workspace."""
    src = get_source(source)
    if near and not PANE_ID.match(near):
        raise ValueError('Not a Herdr pane id.')
    if workspace and not WORKSPACE_ID.match(workspace):
        raise ValueError('Not a Herdr workspace id.')
    if src.kind == 'machine':
        return {'pane_id': _remote(src, 'POST', 'agents/terminal', {'near': near, **({'workspace': workspace} if workspace else {})})['pane_id']}
    if workspace:
        made = _run(src, 'tab', 'create', '--workspace', workspace, '--no-focus')
    elif near:
        pane = _run(src, 'pane', 'get', near)['pane']
        cwd = pane.get('foreground_cwd') or pane.get('cwd') or ''
        made = _run(src, 'tab', 'create', '--workspace', pane['workspace_id'], *(['--cwd', cwd] if cwd else []), '--no-focus')
    else:
        made = _run(src, 'workspace', 'create', '--no-focus')
    return {'pane_id': made['root_pane']['pane_id']}

# The agents `herdr agent start` can launch, most common first.
AGENT_KINDS = ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'copilot', 'amp', 'pi', 'devin', 'agy', 'cline', 'omp',
               'mastracode', 'kimi', 'kiro', 'droid', 'grok', 'hermes', 'kilo', 'qodercli', 'qwen', 'letta', 'maki', 'muse']
AGENT_NAME = re.compile(r'^[a-z][a-z0-9_-]{0,31}$')
START_SECONDS = 120  # how long a new agent may take to start before the task fails
LAUNCH_WAIT = 10  # how long `agent start` waits for it; after that the monitor follows it


def open_workspace(cwd: str = '', label: str = '', source: 'int | Source' = ENV) -> dict:
    """A new Herdr workspace (in `cwd`, when that folder exists where Herdr runs): {pane_id, cwd} of its shell."""
    src = get_source(source)
    if src.kind == 'machine':
        made = _remote(src, 'POST', 'agents/workspace', {'cwd': cwd, 'label': label[:60]})
        return {'pane_id': made['pane_id'], 'cwd': made.get('cwd') or ''}
    made = _run(src, 'workspace', 'create', *(['--cwd', cwd] if cwd else []), *(['--label', label[:60]] if label else []), '--no-focus')
    pane = made['root_pane']
    return {'pane_id': pane['pane_id'], 'cwd': pane.get('cwd') or ''}


def open_tab(workspace: str, cwd: str = '', label: str = '', source: 'int | Source' = ENV) -> dict:
    """A new tab in an open Herdr workspace (in `cwd`, when that folder exists where Herdr runs): {pane_id, cwd} of its shell."""
    if not WORKSPACE_ID.match(workspace):
        raise ValueError('Not a Herdr workspace id.')
    src = get_source(source)
    if src.kind == 'machine':
        made = _remote(src, 'POST', 'agents/workspace', {'cwd': cwd, 'label': label[:60], 'workspace': workspace})
        if not made.get('tab'):
            raise RuntimeError(f'The Marumado on {src.name} is too old to open tabs in a workspace: update it.')
        return {'pane_id': made['pane_id'], 'cwd': made.get('cwd') or ''}
    made = _run(src, 'tab', 'create', '--workspace', workspace, *(['--cwd', cwd] if cwd else []), *(['--label', label[:60]] if label else []), '--no-focus')
    pane = made['root_pane']
    return {'pane_id': pane['pane_id'], 'cwd': pane.get('cwd') or ''}


def create_workspace(label: str = '', cwd: str = '', source: 'int | Source' = ENV) -> dict:
    """A new Herdr workspace with a shell, made from the web: {workspace_id, pane_id, cwd}."""
    src = get_source(source)
    label = label.strip()[:60]
    if src.kind == 'machine':
        made = _remote(src, 'POST', 'agents/workspaces', {'label': label, 'cwd': cwd})
        return {'workspace_id': made['workspace_id'], 'pane_id': made['pane_id'], 'cwd': made.get('cwd') or ''}
    made = _run(src, 'workspace', 'create', *(['--cwd', cwd] if cwd else []), *(['--label', label] if label else []), '--no-focus')
    pane = made['root_pane']
    return {'workspace_id': pane['workspace_id'], 'pane_id': pane['pane_id'], 'cwd': pane.get('cwd') or ''}


class GroupClose(RuntimeError):
    """The workspace has git worktrees open as workspaces of their own: Herdr closes it only with them."""


def close_workspace(workspace: str, group: bool = False, source: 'int | Source' = ENV) -> None:
    """Close a Herdr workspace, every tab and pane in it, and whatever runs there (agents too). `group`: with the
    workspaces of its git worktrees. Raises GroupClose when it has some and `group` is False."""
    if not WORKSPACE_ID.match(workspace):
        raise ValueError('Not a Herdr workspace id.')
    src = get_source(source)
    if src.kind == 'machine':
        try:
            _remote(src, 'POST', f'agents/workspaces/{workspace}/close', {'group': group})
        except RuntimeError as exc:
            if 'worktree' in str(exc):
                raise GroupClose(str(exc))
            raise
        return
    try:
        _run(src, 'workspace', 'close', workspace, *(['--group'] if group else []), text=True)
    except RuntimeError as exc:
        if 'linked worktree' in str(exc) or 'group' in str(exc):
            raise GroupClose('Its git worktrees are open as workspaces of their own: close them too, or close those first.')
        raise


def open_worktree(cwd: str, branch: str, label: str = '', source: 'int | Source' = ENV) -> dict:
    """A new git worktree of the repository at `cwd` on a new `branch`, opened as its own Herdr workspace:
    {pane_id, cwd} of its shell, cwd being the worktree's folder. For a step that runs beside others."""
    if not BRANCH.match(branch):
        raise ValueError('Not a branch name Marumado makes.')
    src = get_source(source)
    if src.kind == 'machine':
        made = _remote(src, 'POST', 'agents/workspace', {'cwd': cwd, 'label': label[:60], 'branch': branch})
        if not made.get('worktree'):
            raise RuntimeError(f'The Marumado on {src.name} is too old for worktrees: update it.')
        return {'pane_id': made['pane_id'], 'cwd': made.get('cwd') or ''}
    made = _run(src, 'worktree', 'create', '--cwd', cwd, '--branch', branch, *(['--label', label[:60]] if label else []), '--no-focus')
    workspace = made['workspace']['workspace_id']
    pane = next((p for p in _run(src, 'pane', 'list')['panes'] if p.get('workspace_id') == workspace), None)
    if pane is None:
        raise RuntimeError(f'Herdr made the worktree for {branch} but opened no shell in it.')
    return {'pane_id': pane['pane_id'], 'cwd': made['worktree'].get('path') or pane.get('cwd') or ''}


def worktrees(cwd: str, source: 'int | Source' = ENV) -> list[dict]:
    """The git worktrees of the repository at `cwd`, as Herdr knows them: {branch, path, open_workspace_id…} each."""
    src = get_source(source)
    if src.kind == 'machine':
        raise RuntimeError(f"{src.name}'s worktrees are handled by its Marumado.")
    return _run(src, 'worktree', 'list', '--cwd', cwd).get('worktrees') or []


def remove_worktree(workspace: str, force: bool = False, source: 'int | Source' = ENV) -> None:
    """Remove the git worktree open as `workspace`, closing the workspace (and the agent in it). `force`: with changes
    not committed in it."""
    if not WORKSPACE_ID.match(workspace):
        raise ValueError('Not a Herdr workspace id.')
    _run(get_source(source), 'worktree', 'remove', '--workspace', workspace, *(['--force'] if force else []), text=True)


def launch_agent(name: str, kind: str, pane_id: str, source: 'int | Source' = ENV) -> bool:
    """Start a `kind` agent named `name` in the shell in `pane_id`. True when it is ready for input already;
    False when it is still starting (or stopped on a startup question): Herdr carries on without us."""
    src = get_source(source)
    if kind not in AGENT_KINDS:
        raise ValueError('Herdr cannot start that kind of agent.')
    if not AGENT_NAME.match(name):
        raise ValueError('Not a valid agent name.')
    if not PANE_ID.match(pane_id):
        raise ValueError('Not a Herdr pane id.')
    if src.kind == 'machine':
        return bool(_remote(src, 'POST', f'agents/{pane_id}/launch', {'name': name, 'kind': kind}, timeout=LAUNCH_WAIT + 20)['ready'])
    try:
        _run(src, 'agent', 'start', name, '--kind', kind, '--pane', pane_id, '--timeout', str(LAUNCH_WAIT * 1000),
             timeout=LAUNCH_WAIT + 10)
    except RuntimeError as exc:
        message = str(exc).lower()
        if 'not ready' in message or 'not_ready' in message or 'timed out' in message or 'did not answer' in message:
            return False
        raise
    return True


def free_name(base: str, source: 'int | Source' = ENV) -> str:
    """An agent name made from `base` (a project's name, say) that no agent in `source` has yet: `marumado`, `marumado-2`…"""
    src = get_source(source)
    stem = re.sub(r'[^a-z0-9_-]+', '-', base.lower()).strip('-_')[:26] or 'agent'
    if not stem[0].isalpha():
        stem = f'a-{stem}'[:26]
    taken = {a['name'] for a in _list(src)['agents'] if a.get('name')}
    name, n = stem, 2
    while name in taken:
        name, n = f'{stem}-{n}', n + 1
    return name


def start_agent(kind: str, cwd: str = '', label: str = '', source: 'int | Source' = ENV, workspace: str = '') -> dict:
    """Open a workspace in `cwd` (or a tab in `workspace`, an open one) and start a `kind` agent there, named after
    `label`. Answers once it is open ({pane_id, cwd}); the agent keeps starting in Herdr on a thread, so the browser
    can watch it start."""
    src = get_source(source)
    if kind not in AGENT_KINDS:
        raise ValueError('Herdr cannot start that kind of agent.')
    name = free_name(label or kind, src)
    opened = open_tab(workspace, cwd, label, src) if workspace else open_workspace(cwd, label, src)
    # Herdr opens a folder it can't find in its home folder, without a word; an agent there is no use to anyone.
    if cwd and opened['cwd'] and opened['cwd'].rstrip('/') != cwd.rstrip('/'):
        try:
            close(opened['pane_id'], src)
        except (RuntimeError, ValueError):
            pass
        raise ValueError(f"{cwd} isn't there for Herdr {src.where()}, so the agent would start in {opened['cwd']}. "
                         'If it is there under another path, add that folder in Agents → Sources.')

    def launch():
        try:
            launch_agent(name, kind, opened['pane_id'], src)
        except (RuntimeError, ValueError) as exc:
            log.warning('starting %s in %s %s failed: %s', kind, opened['pane_id'], src.where(), exc)

    threading.Thread(target=launch, name=f'marumado-start-{opened["pane_id"]}', daemon=True).start()
    return {**opened, 'name': name}


class Blocked(RuntimeError):
    """The agent is waiting on an approval or a question, so it can't take a prompt."""


def prompt_task(pane_id: str, text: str, source: 'int | Source' = ENV) -> bool:
    """Submit a task to an agent and wait for it to start on it (working, or blocked on a question).
    False when it was sent but no activity followed within a few seconds: the agent may still pick it up."""
    src = get_source(source)
    if not PANE_ID.match(pane_id):
        raise ValueError('Not a Herdr pane id.')
    if not text.strip() or len(text) > MAX_PROMPT:
        raise ValueError('The task is empty.' if not text.strip() else 'That task is too long to send.')
    if src.kind == 'machine':
        sent = _remote(src, 'POST', f'agents/{pane_id}/task', {'text': text}, timeout=40)
        if sent.get('blocked'):
            raise Blocked('The agent is waiting on a question.')
        return bool(sent.get('started'))
    try:
        _run(src, 'agent', 'prompt', pane_id, text, '--wait', '--until', 'working', '--until', 'blocked', '--timeout', '20000', timeout=30)
    except RuntimeError as exc:
        message = str(exc)
        if 'stalled' in message or 'timeout' in message.lower() or 'did not answer' in message:
            return False
        if 'blocked' in message:
            raise Blocked('The agent is waiting on a question.')
        raise
    return True


def close(pane_id: str, source: 'int | Source' = ENV) -> None:
    """Close a pane, and whatever runs in it (an agent too)."""
    src = get_source(source)
    if not PANE_ID.match(pane_id):
        raise ValueError('Not a Herdr pane id.')
    if src.kind == 'machine':
        _remote(src, 'POST', f'agents/{pane_id}/close')
        return
    _run(src, 'pane', 'close', pane_id)


class TimedOut(RuntimeError):
    """A command run by execute() didn't end in the time it was given."""


RUN_LINES = 3000  # how much of a command's output execute() reads back from a terminal


def _contained() -> bool:
    """Whether Marumado runs in a container beside the Herdr it asks: there it can't write the projects' folders (they
    are mounted read-only) nor run their tools."""
    return bool(env('HERDR_SOCKET')) or Path('/.dockerenv').exists()


def execute(source: 'int | Source', cwd: str, script: str, timeout: float = 60, near: str = '') -> tuple[int, str]:
    """Run the sh `script` in the folder `cwd` where the agents of `source` run, and wait for it to end: (its exit
    code, what it printed). Raises TimedOut past `timeout` seconds, RuntimeError when it can't be run.
    In a VM or on an SSH host, or with Marumado on the same machine as Herdr, that is a plain shell. Marumado in a
    container runs it in a Herdr terminal of its own instead, opened beside pane `near` (or in a new workspace) and
    closed after: there, it runs with the owner's tools and rights, as the agents do."""
    src = get_source(source)
    if src.kind == 'machine':
        raise RuntimeError(f"Commands can't be run on {src.name} from here yet: use the Marumado there.")
    nonce = secrets.token_hex(6)
    # The markers around what it prints are put together as it runs, so the command as typed in a terminal (which
    # shows it, maybe wrapped) never holds them.
    start, marker = f'__marumado_{nonce}_start__', re.compile(rf'__marumado_{nonce}_(\d+)__')
    q = shlex.quote
    full = (f'printf "__marumado_%s_start__\\n" {nonce}; '
            f'( cd {q(cwd)} 2>/dev/null || {{ echo {q(f"No folder {cwd} where Herdr runs.")}; exit 97; }}; {script} ) </dev/null 2>&1; '
            f'printf "\\n__marumado_%s_%s__\\n" {nonce} $?')
    if any(_elsewhere(src)) or not _contained():
        try:
            out = shell(src, full, timeout=timeout).decode(errors='replace')
        except RuntimeError as exc:
            if 'in time' in str(exc):
                raise TimedOut(f'It took longer than {_duration(timeout)}.')
            raise
    else:
        out = _in_terminal(src, full, marker, timeout, near)
    m = marker.search(out)
    if not m:
        raise RuntimeError('It ended without saying how (its exit code was lost).')
    out = out[:m.start()]
    begins = out.rfind(start)
    return int(m.group(1)), (out[begins + len(start):] if begins >= 0 else out).strip('\n')


def _duration(seconds: float) -> str:
    return f'{int(seconds // 60)} minutes' if seconds >= 120 else f'{int(seconds)} seconds'


def _in_terminal(src: Source, full: str, marker: re.Pattern, timeout: float, near: str) -> str:
    try:
        pane = new_terminal(near, src)['pane_id']
    except RuntimeError:
        if not near:
            raise
        pane = new_terminal('', src)['pane_id']  # the pane it was to go beside was closed meanwhile
    try:
        _run(src, 'pane', 'run', pane, 'sh -c ' + shlex.quote(full), text=True)  # sh, whatever the owner's shell is
        try:
            _run(src, 'pane', 'wait-output', pane, '--regex', marker.pattern, '--source', 'recent-unwrapped', '--lines', str(RUN_LINES),
                 '--timeout', str(int(timeout * 1000)), text=True, timeout=timeout + 10)
        except RuntimeError as exc:
            if any(w in str(exc).lower() for w in ('timeout', 'timed out', 'in time')):
                raise TimedOut(f'It took longer than {_duration(timeout)}.')
            raise
        return _run(src, 'pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', str(RUN_LINES), text=True)
    finally:
        try:
            close(pane, src)
        except (RuntimeError, ValueError):
            pass


def terminal_command(pane_id: str, cols: int, rows: int, control: bool, takeover: bool = False,
                     source: 'int | Source' = ENV) -> tuple[list[str], dict | None]:
    """`herdr terminal session control|observe`: JSON frames of ANSI on stdout, JSON commands on stdin."""
    src = get_source(source)
    if not PANE_ID.match(pane_id):
        raise ValueError('Not a Herdr pane id.')
    if src.kind == 'machine':
        raise RuntimeError(f"{src.name}'s terminal is relayed through its Marumado.")
    args = ['terminal', 'session', 'control' if control else 'observe', pane_id, '--cols', str(cols), '--rows', str(rows)]
    if control and takeover:
        args.append('--takeover')
    return _command(src, tuple(args), interactive=control)


def pane_size(pane_id: str, source: 'int | Source' = ENV) -> tuple[int, int] | None:
    """The pane's size in Herdr's own layout (columns, rows), which the live terminal keeps to."""
    src = get_source(source)
    if not PANE_ID.match(pane_id):
        raise ValueError('Not a Herdr pane id.')
    if src.kind == 'machine':
        return None
    try:
        layout = _run(src, 'pane', 'layout', '--pane', pane_id)['layout']
        rect = next(p['rect'] for p in layout['panes'] if p['pane_id'] == pane_id)
        return int(rect['width']), int(rect['height'])
    except (RuntimeError, ValueError, KeyError, TypeError, StopIteration):
        return None
