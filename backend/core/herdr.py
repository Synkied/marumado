"""The coding agents running in Herdr (https://herdr.dev): list them, read them, and stream their terminal.

Listing and reading never touch an agent. The live terminal (core/terminal.py) types into it only in
`control` mode (as does send(), the phone-sized prompt box), which MARUMADO_HERDR_TERMINAL can turn down to `observe` or `off`.
"""
import json
import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path

from marumado.settings import env

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


def where() -> str:
    """A short description of where Marumado looks for Herdr."""
    if env('HERDR_SMOLVM'):
        return f"in the smolvm machine {env('HERDR_SMOLVM')}"
    if env('HERDR_EXEC'):
        return f"through {env('HERDR_EXEC').strip()}"
    if env('HERDR_SSH'):
        return f"over SSH on {env('HERDR_SSH')}"
    return 'on this machine'


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


def _command(args: tuple[str, ...], interactive: bool = False) -> tuple[list[str], dict | None]:
    """The command line that runs `herdr <args>` wherever Herdr lives. `interactive` keeps stdin connected."""
    target = env('HERDR_SSH')
    if env('HERDR_SMOLVM') or env('HERDR_EXEC') or target:
        binary = shlex.quote(env('HERDR_BIN')) if env('HERDR_BIN') else '"$(command -v herdr || echo "$HOME/.local/bin/herdr")"'
        # VM exec tools may start commands with a bare environment.
        remote = 'export HOME="${HOME:-/root}" PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"; ' + ' '.join([binary, *map(shlex.quote, args)])
        if env('HERDR_SMOLVM'):
            prefix, environ = _smolvm(env('HERDR_SMOLVM'), interactive)
            return [*prefix, 'sh', '-c', remote], environ
        if env('HERDR_EXEC'):
            return [*shlex.split(env('HERDR_EXEC')), 'sh', '-c', remote], None
        ssh = ['ssh', '-o', 'BatchMode=yes', '-o', f'ConnectTimeout={TIMEOUT - 1}', target, remote]
        return ssh, None
    binary = env('HERDR_BIN') or shutil.which('herdr')
    if not binary:
        default = Path.home() / '.local' / 'bin' / 'herdr'
        binary = str(default) if default.exists() else None
    if not binary:
        raise RuntimeError('Herdr is not installed on this machine. If it runs elsewhere, set MARUMADO_HERDR_SMOLVM, MARUMADO_HERDR_EXEC or MARUMADO_HERDR_SSH.')
    extra = {'HERDR_SOCKET_PATH': env('HERDR_SOCKET')} if env('HERDR_SOCKET') else {}
    return [binary, *args], {**os.environ, **extra}


def _run(*args: str, text: bool = False):
    cmd, environ = _command(args)
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT + 4, env=environ)
    except FileNotFoundError:
        raise RuntimeError(f'{cmd[0]} is not installed.')
    except subprocess.TimeoutExpired:
        raise RuntimeError(f'Herdr did not answer in time ({where()}).')
    if out.returncode != 0:
        try:
            message = json.loads(out.stderr)['error']['message']
        except (ValueError, KeyError, TypeError):
            message = out.stderr.strip().splitlines()[-1] if out.stderr.strip() else 'Herdr returned an error.'
        if out.returncode == 255 and env('HERDR_SSH'):
            raise RuntimeError(f"SSH to {env('HERDR_SSH')} failed: {message}")
        raise RuntimeError(f'Herdr is not running {where()} ({message}).' if 'socket' in message.lower() or 'server' in message.lower() else message)
    return out.stdout if text else json.loads(out.stdout)['result']


def agents() -> dict:
    """Every live agent with its state and what its terminal says it is doing."""
    try:
        listed = _run('agent', 'list')['agents']
        workspaces = {w['workspace_id']: w.get('label') or '' for w in _run('workspace', 'list')['workspaces']}
    except (RuntimeError, ValueError, KeyError, OSError) as exc:
        return {'available': False, 'error': str(exc), 'where': where(), 'terminal': terminal_mode(), 'agents': []}
    rows = []
    for a in listed:
        rows.append({
            'pane_id': a['pane_id'],
            'name': a.get('name') or '',
            'kind': a.get('agent') or 'agent',
            'status': a.get('agent_status') or 'unknown',
            'title': a.get('terminal_title_stripped') or '',
            'cwd': a.get('foreground_cwd') or a.get('cwd') or '',
            'workspace': workspaces.get(a.get('workspace_id'), ''),
            'focused': bool(a.get('focused')),
        })
    return {'available': True, 'error': '', 'where': where(), 'terminal': terminal_mode(), 'agents': rows}


def read(pane_id: str, lines: int = 80) -> str:
    """The agent's recent terminal output, as plain text."""
    if not PANE_ID.match(pane_id):
        raise ValueError('Not a Herdr pane id.')
    lines = str(max(10, min(lines, 400)))
    try:
        out = _run('agent', 'read', pane_id, '--source', 'recent-unwrapped', '--lines', lines, text=True)
    except RuntimeError as exc:
        # Full-screen agents' history can only be scrolled back while idle; show the screen meanwhile.
        if 'source visible' not in str(exc) and 'alternate-screen' not in str(exc):
            raise
        out = _run('agent', 'read', pane_id, '--source', 'visible', text=True)
    return '\n'.join(line.rstrip() for line in out.splitlines()).strip('\n')


KEYS = frozenset({'esc', 'tab', 'shift+tab', 'enter', 'up', 'down', 'left', 'right', 'backspace', 'space', 'ctrl+c', 'ctrl+d', 'y', 'n', *'0123456789'})
MAX_PROMPT = 16 * 1024


def send(pane_id: str, text: str = '', keys: tuple[str, ...] = ()) -> None:
    """Type into an agent, for screens too small for the live terminal: a prompt (submitted with Enter) or a few keys."""
    if not PANE_ID.match(pane_id):
        raise ValueError('Not a Herdr pane id.')
    if keys:
        if len(keys) > 16 or not set(keys) <= KEYS:
            raise ValueError('Unknown key.')
        _run('pane', 'send-keys', pane_id, *keys, text=True)
        return
    if not text.strip() or len(text) > MAX_PROMPT:
        raise ValueError('Write a prompt first.' if not text.strip() else 'That prompt is too long.')
    try:
        _run('agent', 'prompt', pane_id, text, text=True)
    except RuntimeError as exc:
        if 'blocked' in str(exc):
            raise RuntimeError('The agent is waiting on a question: answer it with the keys.')
        if 'not found' not in str(exc) and 'not ready' not in str(exc) and 'foreground' not in str(exc):
            raise
        # Not a recognised agent (a plain shell, say): type the text and press Enter.
        _run('pane', 'send-text', pane_id, text, text=True)
        _run('pane', 'send-keys', pane_id, 'enter', text=True)


def terminal_command(pane_id: str, cols: int, rows: int, control: bool, takeover: bool = False) -> tuple[list[str], dict | None]:
    """`herdr terminal session control|observe`: JSON frames of ANSI on stdout, JSON commands on stdin."""
    if not PANE_ID.match(pane_id):
        raise ValueError('Not a Herdr pane id.')
    args = ['terminal', 'session', 'control' if control else 'observe', pane_id, '--cols', str(cols), '--rows', str(rows)]
    if control and takeover:
        args.append('--takeover')
    return _command(tuple(args), interactive=control)


def pane_size(pane_id: str) -> tuple[int, int] | None:
    """The pane's size in Herdr's own layout (columns, rows), which the live terminal keeps to."""
    if not PANE_ID.match(pane_id):
        raise ValueError('Not a Herdr pane id.')
    try:
        layout = _run('pane', 'layout', '--pane', pane_id)['layout']
        rect = next(p['rect'] for p in layout['panes'] if p['pane_id'] == pane_id)
        return int(rect['width']), int(rect['height'])
    except (RuntimeError, ValueError, KeyError, TypeError, StopIteration):
        return None
