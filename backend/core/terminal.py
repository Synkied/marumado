"""Live Herdr terminal over a WebSocket: /api/agents/<pane_id>/terminal?source=<id>&takeover=1[&cols=&rows=]

The browser gets Herdr's own messages untouched (`terminal.frame` with base64 ANSI, `terminal.closed`),
plus `{"type": "error", "message": ...}` when the stream can't start. It may send `terminal.input`,
`terminal.scroll` and `terminal.mouse` (both at a 0-based `column` and `row`); those are checked and
passed to Herdr only in control mode.

The stream normally runs at the pane's size in Herdr's layout, never the browser's: attaching at another
size would resize the real terminal under the Herdr TUI. The browser scales its text to fit instead.
Phones are the exception (control mode, `cols` and `rows` given): the pane takes the phone's size while
it watches, follows its `terminal.resize` messages, and gets its layout size back when the phone leaves.
"""
import asyncio
import json
import re
from http.cookies import SimpleCookie
from importlib import import_module
from urllib.parse import parse_qs, urlencode, urlsplit

from django.conf import settings

from . import auth, herdr, machines

PATH = re.compile(r'^/api/agents/(?P<pane>w[0-9A-Za-z]+:p[0-9A-Za-z]+)/terminal$')
# The same terminal on another machine, relayed through its tunnel to its own Marumado.
REMOTE_PATH = re.compile(r'^/api/machines/(?P<machine>\d+)/(?P<rest>agents/w[0-9A-Za-z]+:p[0-9A-Za-z]+/terminal)$')
MAX_INPUT = 64 * 1024
FOLLOW_SECONDS = 3
MOUSE_ACTIONS = ('down', 'up', 'drag')
MOUSE_BUTTONS = ('left', 'middle', 'right')


def _clamp(value, low: int, high: int, default: int) -> int:
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


def _headers(scope) -> dict[str, str]:
    return {k.decode('latin-1').lower(): v.decode('latin-1') for k, v in scope['headers']}


def _same_origin(scope) -> bool:
    """Browsers let any page open a WebSocket to localhost, so only accept Marumado's own pages."""
    headers = _headers(scope)
    origin = headers.get('origin')
    return origin is None or urlsplit(origin).netloc == headers.get('host', '')


def _authorized(scope) -> bool:
    """A logged-in browser (session cookie), or another Marumado relaying with `Authorization: Bearer`. Raises auth.Locked."""
    headers = _headers(scope)
    address = (scope.get('client') or ('',))[0]
    given = auth.bearer(headers.get('authorization', ''))
    if given is not None:
        return auth.try_token(address, given)
    auth.check_locked(address)
    morsel = SimpleCookie(headers.get('cookie', '')).get(settings.SESSION_COOKIE_NAME)
    if morsel is None:
        return False
    session = import_module(settings.SESSION_ENGINE).SessionStore(morsel.value)
    return auth.session_ok(session)


def _command(message: dict, fit: bool) -> dict | None:
    """The browser's message, reduced to a command Herdr accepts, or None to drop it."""
    kind = message.get('type')
    if kind == 'terminal.resize' and fit:
        return {'type': kind, 'cols': _clamp(message.get('cols'), 20, 400, 80), 'rows': _clamp(message.get('rows'), 8, 200, 24)}
    if kind == 'terminal.input' and isinstance(message.get('text'), str) and 0 < len(message['text']) <= MAX_INPUT:
        return {'type': kind, 'text': message['text']}
    if kind == 'terminal.scroll' and message.get('direction') in ('up', 'down'):
        command = {'type': kind, 'direction': message['direction'], 'lines': _clamp(message.get('lines'), 1, 200, 3)}
        # Where the pointer is, so an app that tracks the mouse scrolls the panel under it rather than the top-left one.
        if 'column' in message and 'row' in message:
            command.update(_cell(message))
        return command
    # A click for an app that tracks the mouse; Herdr drops it for one that doesn't.
    if kind == 'terminal.mouse' and message.get('action') in MOUSE_ACTIONS and message.get('button') in MOUSE_BUTTONS:
        return {'type': kind, 'action': message['action'], 'button': message['button'], **_cell(message)}
    return None


def _cell(message: dict) -> dict:
    return {'column': _clamp(message.get('column'), 0, 400, 0), 'row': _clamp(message.get('row'), 0, 200, 0)}


async def _refuse(send, message: str):
    await send({'type': 'websocket.send', 'text': json.dumps({'type': 'error', 'message': message})})
    await send({'type': 'websocket.close', 'code': 1008})


async def handle(scope, receive, send):
    if (await receive())['type'] != 'websocket.connect':
        return
    match = PATH.match(scope['path'])
    remote = REMOTE_PATH.match(scope['path'])
    if not (match or remote) or not _same_origin(scope):
        await send({'type': 'websocket.close', 'code': 1008})
        return
    query = {k: v[-1] for k, v in parse_qs(scope.get('query_string', b'').decode()).items()}
    await send({'type': 'websocket.accept'})

    try:
        authorized = await asyncio.to_thread(_authorized, scope)
    except auth.Locked as exc:
        return await _refuse(send, str(exc))
    if not authorized:
        return await _refuse(send, 'Log in to this Marumado again: its access token is needed.')
    if remote:
        return await _relay(int(remote['machine']), remote['rest'], query, receive, send)
    mode = herdr.terminal_mode()
    if mode == 'off':
        return await _refuse(send, 'The live terminal is turned off (MARUMADO_HERDR_TERMINAL=off).')
    control = mode == 'control'
    pane = match['pane']
    fit = control and 'cols' in query and 'rows' in query
    try:
        # Resolved once, off the event loop (it may read the database); every call below reuses it.
        source = await asyncio.to_thread(herdr.get_source, query.get('source'))
    except ValueError as exc:
        return await _refuse(send, str(exc))
    if source.kind == 'machine':
        # Another machine's Herdr: its own Marumado runs the terminal, relayed through its tunnel.
        return await _relay(int(source.target), f'agents/{pane}/terminal', {**query, 'source': '0'}, receive, send, typing=control)
    try:
        size = await asyncio.to_thread(herdr.pane_size, pane, source) or (120, 40)
        attach = (_clamp(query['cols'], 20, 400, 80), _clamp(query['rows'], 8, 200, 24)) if fit else size
        cmd, environ = herdr.terminal_command(pane, *attach, control, takeover=query.get('takeover') == '1', source=source)
        proc = await asyncio.create_subprocess_exec(
            *cmd, env=environ, limit=64 * 1024 * 1024,
            stdin=asyncio.subprocess.PIPE if control else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    except (RuntimeError, ValueError, OSError) as exc:
        return await _refuse(send, str(exc))

    async def pump_out():
        assert proc.stdout
        async for line in proc.stdout:
            if line.strip():
                await send({'type': 'websocket.send', 'text': line.decode('utf-8', 'replace')})
        # Herdr ended without a terminal.closed: tell the browser why.
        err = (await proc.stderr.read()).decode('utf-8', 'replace').strip() if proc.stderr else ''
        try:
            err = json.loads(err)['error']['message']
        except (ValueError, KeyError, TypeError):
            err = err.splitlines()[-1] if err else ''
        if err:
            await send({'type': 'websocket.send', 'text': json.dumps({'type': 'error', 'message': err})})

    async def pump_in():
        while True:
            event = await receive()
            if event['type'] == 'websocket.disconnect':
                return
            if not control or proc.stdin is None or not event.get('text'):
                continue
            try:
                command = _command(json.loads(event['text']), fit)
            except (ValueError, AttributeError):
                command = None
            if command:
                try:
                    proc.stdin.write(json.dumps(command).encode() + b'\n')
                    await proc.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    return

    async def follow_layout():
        """Keep to the pane's size when the Herdr TUI is resized or its splits move."""
        nonlocal size
        while control and not fit and proc.stdin:
            await asyncio.sleep(FOLLOW_SECONDS)
            now = await asyncio.to_thread(herdr.pane_size, pane, source)
            if now and now != size:
                size = now
                try:
                    proc.stdin.write(json.dumps({'type': 'terminal.resize', 'cols': now[0], 'rows': now[1]}).encode() + b'\n')
                    await proc.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    return

    herdr.watch(source.id, pane)
    out_task, in_task = asyncio.create_task(pump_out()), asyncio.create_task(pump_in())
    follow_task = asyncio.create_task(follow_layout())
    try:
        done, _ = await asyncio.wait({out_task, in_task}, return_when=asyncio.FIRST_COMPLETED)
        browser_left = in_task in done
    finally:
        herdr.unwatch(source.id, pane)
        in_task.cancel()
        out_task.cancel()
        follow_task.cancel()
        if proc.stdin and not proc.stdin.is_closing():
            if fit:
                # Give the pane back its size in the Herdr TUI before letting go.
                try:
                    size = await asyncio.wait_for(asyncio.to_thread(herdr.pane_size, pane, source), 3) or size
                    proc.stdin.write(json.dumps({'type': 'terminal.resize', 'cols': size[0], 'rows': size[1]}).encode() + b'\n')
                    await asyncio.wait_for(proc.stdin.drain(), 2)
                except (BrokenPipeError, ConnectionResetError, TimeoutError, RuntimeError, ValueError):
                    pass
            proc.stdin.close()  # Herdr detaches cleanly when its input ends.
        try:
            await asyncio.wait_for(proc.wait(), 2)
        except TimeoutError:
            proc.kill()
    if not browser_left:
        try:
            await send({'type': 'websocket.close', 'code': 1000})
        except Exception:
            pass  # the browser left meanwhile


async def _relay(machine_id: int, rest: str, query: dict, receive, send, typing: bool = True):
    """Pass the browser's terminal through to another machine's Marumado, which checks and runs it.
    `typing` False: what the browser sends is dropped, so this Marumado's observe mode holds there too."""
    from websockets.asyncio.client import connect
    from websockets.exceptions import ConnectionClosed, WebSocketException

    tunnel = machines.get(machine_id)
    if tunnel is None:
        return await _refuse(send, 'No such machine.')
    if not tunnel.local_port or tunnel.state != 'up':
        return await _refuse(send, tunnel.error or f'Still connecting to {tunnel.name}.')
    url = f'ws://127.0.0.1:{tunnel.local_port}/api/{rest}?{urlencode(query)}'
    headers = {'Authorization': f'Bearer {tunnel.token}'} if tunnel.token else None
    try:
        upstream = await connect(url, max_size=None, open_timeout=10, additional_headers=headers)
    except (OSError, TimeoutError, WebSocketException) as exc:
        return await _refuse(send, f"Couldn't open the terminal on {tunnel.name}: {exc}")

    async def pump_down():
        try:
            async for message in upstream:
                await send({'type': 'websocket.send', 'text': message if isinstance(message, str) else message.decode('utf-8', 'replace')})
        except ConnectionClosed:
            pass

    async def pump_up():
        while True:
            event = await receive()
            if event['type'] == 'websocket.disconnect':
                return
            if event.get('text') and typing:
                try:
                    await upstream.send(event['text'])
                except ConnectionClosed:
                    return

    down_task, up_task = asyncio.create_task(pump_down()), asyncio.create_task(pump_up())
    try:
        done, _ = await asyncio.wait({down_task, up_task}, return_when=asyncio.FIRST_COMPLETED)
        browser_left = up_task in done
    finally:
        down_task.cancel()
        up_task.cancel()
        await upstream.close()
    if not browser_left:
        try:
            await send({'type': 'websocket.close', 'code': 1000})
        except Exception:
            pass  # the browser left meanwhile
