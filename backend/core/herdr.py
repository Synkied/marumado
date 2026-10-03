"""The coding agents (and plain terminals) running in Herdr (https://herdr.dev): list them, read them, open a terminal, and stream it.
Herdr may run in several places at once (sources: the one set in .env, plus VMs and servers added in the app).

Listing and reading never touch an agent. The live terminal (core/terminal.py) types into it only in
`control` mode (as does send(), the phone-sized prompt box), which MARUMADO_HERDR_TERMINAL can turn down to `observe` or `off`.
"""
import json
import logging
import os
import re
import shlex
import shutil
import signal
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from marumado.settings import env

from . import sshhome

log = logging.getLogger(__name__)

PANE_ID = re.compile(r'^w\d+:p\d+$')
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


def _env_source() -> Source:
    name = env('HERDR_SMOLVM') or env('HERDR_SSH') or ('VM' if env('HERDR_EXEC') else 'This machine')
    return Source(ENV, name, 'env')


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
    added = [Source(s.id, s.name, s.kind, s.target) for s in AgentSource.objects.all()]
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
    return Source(found.id, found.name, found.kind, found.target)


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


def _command(src: Source, args: tuple[str, ...], interactive: bool = False) -> tuple[list[str], dict | None]:
    """The command line that runs `herdr <args>` wherever `src` is. `interactive` keeps stdin connected."""
    smolvm = src.target if src.kind == 'smolvm' else env('HERDR_SMOLVM') if src.kind == 'env' else ''
    ssh = src.target if src.kind == 'ssh' else env('HERDR_SSH') if src.kind == 'env' else ''
    exec_ = env('HERDR_EXEC') if src.kind == 'env' else ''
    if smolvm or exec_ or ssh:
        # MARUMADO_HERDR_BIN names the binary on the .env source only; sources added in the app find it themselves.
        given = env('HERDR_BIN') if src.kind == 'env' else ''
        binary = shlex.quote(given) if given else '"$(command -v herdr || echo "$HOME/.local/bin/herdr")"'
        # VM exec tools may start commands with a bare environment.
        remote = 'export HOME="${HOME:-/root}" PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"; ' + ' '.join([binary, *map(shlex.quote, args)])
        if smolvm:
            prefix, environ = _smolvm(smolvm, interactive)
            return [*prefix, 'sh', '-c', remote], environ
        if exec_:
            return [*shlex.split(exec_), 'sh', '-c', remote], None
        return _ssh(ssh, remote), None
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


_failed_lock = threading.Lock()
_failed: dict[Source, tuple[float, str]] = {}


def _list(src: Source) -> dict:
    """One source's panes, or why it can't be reached."""
    with _failed_lock:
        failed = _failed.get(src)
    if failed and time.monotonic() - failed[0] < RETRY_SECONDS:
        return {'available': False, 'error': failed[1], 'agents': []}
    if src.kind == 'machine':
        return _list_machine(src)
    try:
        # Every pane, so plain shells (from New terminal, say) can be watched too.
        listed = _run(src, 'pane', 'list')['panes']
        workspaces = {w['workspace_id']: w.get('label') or '' for w in _run(src, 'workspace', 'list')['workspaces']}
    except (RuntimeError, ValueError, KeyError, OSError) as exc:
        with _failed_lock:
            _failed[src] = (time.monotonic(), str(exc))
        return {'available': False, 'error': str(exc), 'agents': []}
    with _failed_lock:
        _failed.pop(src, None)
    rows = []
    for a in listed:
        rows.append({
            'pane_id': a['pane_id'],
            'source': src.id,
            'name': a.get('name') or '',
            'kind': a.get('agent') or 'terminal',
            'status': a.get('agent_status') or 'unknown',
            'title': a.get('terminal_title_stripped') or '',
            'cwd': a.get('foreground_cwd') or a.get('cwd') or '',
            'workspace': workspaces.get(a.get('workspace_id'), ''),
            'focused': bool(a.get('focused')),
        })
    return {'available': True, 'error': '', 'agents': rows}


def _list_machine(src: Source) -> dict:
    """The agents of another machine's own Herdr (its .env source), as its Marumado lists them."""
    try:
        data = _remote(src, 'GET', 'agents', query='machines=0')
        own = next((s for s in data.get('sources') or [] if s['id'] == ENV), None)
        available = own['available'] if own else data['available']
        error = (own['error'] if own else data.get('error', '')) or ''
        rows = [{**a, 'source': src.id} for a in data['agents'] if a.get('source', ENV) == ENV]
    except (RuntimeError, ValueError, KeyError, TypeError) as exc:
        with _failed_lock:
            _failed[src] = (time.monotonic(), str(exc))
        return {'available': False, 'error': str(exc), 'agents': []}
    with _failed_lock:
        _failed.pop(src, None)
    return {'available': available, 'error': error, 'agents': rows if available else []}


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
                     'error': one['error'], 'agents': len(one['agents'])} for s, one in zip(every, listed)],
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


def new_terminal(near: str = '', source: 'int | Source' = ENV) -> dict:
    """Open a shell in a new Herdr tab: beside pane `near` (its workspace and folder), or in a new workspace."""
    src = get_source(source)
    if near and not PANE_ID.match(near):
        raise ValueError('Not a Herdr pane id.')
    if src.kind == 'machine':
        return {'pane_id': _remote(src, 'POST', 'agents/terminal', {'near': near})['pane_id']}
    if near:
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
