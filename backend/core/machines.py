"""Other machines, each running its own Marumado on its own localhost, reached through SSH tunnels.

One thread per machine keeps `ssh -N -L <free port>:127.0.0.1:<its port> <target>` running (reconnecting
with a growing pause) and samples the machine's /api/system every few seconds for the Machines module.
The API passes /api/machines/<id>/<path> through the tunnel (views.machine_proxy, and terminal.py for the
live agent terminal), so every module can show any machine. Nothing is opened to the network: the other
Marumado stays bound to 127.0.0.1 and SSH key login is the only way in.
"""
import ctypes
import os
import re
import signal
import socket
import subprocess
import threading
import time
from collections import deque

import httpx

from . import sshhome

SAMPLE_SECONDS = 5
CONNECT_SECONDS = 20
MAX_PAUSE = 60
# What Marumado's own permission check answers when the token is wrong (rest_framework's default).
TOKEN_REFUSED = 'You do not have permission to perform this action.'
SSH_TARGET = re.compile(r'^[A-Za-z0-9_.@%+\[\]:/-]+$')  # also ssh://user@host:port

_lock = threading.Lock()
_tunnels: dict[int, 'Tunnel'] = {}


class Unavailable(Exception):
    """The machine can't be reached right now; the message says why, in plain words."""


class StillConnecting(Unavailable):
    """ssh hasn't opened the tunnel yet."""


def valid_target(target: str) -> bool:
    return bool(SSH_TARGET.match(target)) and not target.startswith('-')


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def _die_with_parent():
    """Linux: ssh gets SIGTERM when the thread that started it ends, so no tunnel outlives Marumado."""
    try:
        ctypes.CDLL(None).prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except (OSError, AttributeError):
        pass


def _ssh_error(lines: list[str], target: str) -> str:
    text = ' '.join(lines)
    reached = re.search(r'connect to host \S+ port \d+: (.+)', text)
    if reached:
        return f"Couldn't reach {target} over SSH ({reached.group(1).rstrip('.')}). Is it on, and is the address and SSH port right?"
    if 'Could not resolve hostname' in text:
        return f"Couldn't find {target}: the host name doesn't resolve. Check the SSH target."
    if 'Permission denied' in text:
        return f'SSH refused the login to {target}{_login_detail(target)}. Marumado needs key login (no password prompt).'
    if 'Host key verification failed' in text:
        return f"{target}'s host key isn't trusted yet. Connect once with `ssh {target}` from this machine to trust it."
    if 'open failed' in text or 'connect failed' in text:
        return f"Connected to {target}, but nothing listens on Marumado's port there. Is Marumado running on it?"
    meaningful = [ln for ln in lines if not ln.startswith(('Warning:', '**'))]
    return (meaningful or lines or ['SSH stopped without saying why.'])[-1]


def _login_detail(target: str) -> str:
    """Who ssh logged in as and with which keys, from `ssh -G`: the usual reason a login works by hand but not here."""
    try:
        out = subprocess.run(['ssh', '-G', '--', target], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ''
    user, keys = '', []
    for line in out.splitlines():
        key, _, value = line.partition(' ')
        if key == 'user':
            user = value
        elif key == 'identityfile':
            path = os.path.expanduser(value)
            if os.path.isfile(path):
                keys.append(os.path.basename(path))
    detail = f' as user {user}' if user else ''
    return detail + (f', with keys {", ".join(keys)}' if keys else ', and found no key to offer (only an ssh-agent?)')


def _summary(system: dict | None) -> dict | None:
    """The few numbers the Machines module shows for every machine."""
    if not system:
        return None
    disk = max(system.get('disks') or [], key=lambda d: d['percent'], default=None)
    return {
        'hostname': system['host']['hostname'],
        'os': system['host']['os'],
        'cores': system['host']['cores_logical'],
        'boot_time': system['host']['boot_time'],
        'cpu': system['cpu']['percent'],
        'load': system['cpu']['load'],
        'memory': system['memory']['percent'],
        'disk': {'mount': disk['mount'], 'percent': disk['percent']} if disk else None,
        'time': system['time'],
    }


class Tunnel:
    def __init__(self, machine):
        self.id = machine.id
        self.name = machine.name
        self.target = machine.ssh_target
        self.port = machine.port
        self.token = machine.token
        self.local_port: int | None = None
        self.state = 'connecting'  # connecting, up, down
        self.error = ''
        self.since = time.time()
        self.system: dict | None = None
        self._stop = threading.Event()
        self._wake = threading.Event()  # retry(): reconnect now
        self._proc: subprocess.Popen | None = None
        self._stderr: deque[str] = deque(maxlen=20)
        self._http = httpx.Client(timeout=10)

    @property
    def config(self) -> tuple:
        return (self.target, self.port, self.token)

    def start(self):
        threading.Thread(target=self._run, name=f'marumado-tunnel-{self.id}', daemon=True).start()

    def stop(self):
        self._stop.set()
        self._wake.set()
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()

    def retry(self):
        """Reconnect now instead of waiting out the pause, with a fresh ssh."""
        self._set('connecting')
        self._wake.set()
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()

    def _set(self, state: str, error: str = ''):
        if state != self.state:
            self.since = time.time()
        self.state, self.error = state, error

    def status(self) -> dict:
        return {
            'id': self.id, 'name': self.name, 'ssh_target': self.target, 'port': self.port,
            'has_token': bool(self.token), 'local': False,
            'state': self.state, 'error': self.error, 'since': self.since,
            'summary': _summary(self.system) if self.state == 'up' else None,
        }

    # ------------------------------------------------------------ the tunnel

    def _run(self):
        pause = 2
        while not self._stop.is_set():
            # A machine that is down stays down (with its reason) while it retries, instead of flickering.
            was_up = self._connect()
            if self._stop.is_set():
                break
            pause = 2 if was_up else min(pause * 2, MAX_PAUSE)
            if self._wake.is_set() or self._wake.wait(pause):
                self._wake.clear()
                pause = 2
        self._http.close()

    def _connect(self) -> bool:
        """Run one ssh tunnel until it ends. True if the machine answered at some point."""
        sshhome.prepare()
        port = _free_port()
        cmd = [
            'ssh', '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
            '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
            '-L', f'127.0.0.1:{port}:127.0.0.1:{self.port}', '--', self.target,
        ]
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                    text=True, errors='replace', preexec_fn=_die_with_parent)
        except FileNotFoundError:
            self._set('down', 'ssh is not installed on this machine.')
            return False
        self._proc, self.local_port = proc, port
        self._stderr.clear()
        threading.Thread(target=self._read_stderr, args=(proc,), daemon=True).start()

        was_up = False
        started = time.time()
        while proc.poll() is None and not self._wake.is_set():
            try:
                self.system = self._get('system').json()
                self._set('up')
                was_up = True
            except Unavailable as exc:
                # ssh opens the local port only once it is logged in; until then, keep waiting.
                if isinstance(exc, StillConnecting) and self.state != 'up' and time.time() - started < CONNECT_SECONDS:
                    self._wake.wait(0.5)
                    continue
                self.system = None
                self._set('down', str(exc))
            self._wake.wait(SAMPLE_SECONDS)
        if proc.poll() is None:
            proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        self.local_port, self.system = None, None
        if not self._wake.is_set():
            time.sleep(0.2)  # let the stderr reader catch the last line
            self._set('down', _ssh_error(list(self._stderr), self.target))
        return was_up

    def _read_stderr(self, proc: subprocess.Popen):
        for line in proc.stderr:
            if line.strip():
                self._stderr.append(line.strip())

    # ------------------------------------------------------------ requests through it

    def _get(self, path: str) -> httpx.Response:
        return self.request('GET', path, timeout=4)

    def request(self, method: str, path: str, query: str = '', body: bytes = b'', content_type: str = '',
                timeout: float = 10) -> httpx.Response:
        """Call the machine's own API at /api/<path>. Raises Unavailable when it can't be reached."""
        if not self.local_port:
            raise StillConnecting(self.error or f'Still connecting to {self.name}.')
        headers = {}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'
        if content_type and body:
            headers['Content-Type'] = content_type
        url = f'http://127.0.0.1:{self.local_port}/api/{path}' + (f'?{query}' if query else '')
        try:
            res = self._http.request(method, url, content=body or None, headers=headers, timeout=timeout)
        except httpx.ConnectError:
            raise StillConnecting(f'Still connecting to {self.name}.')
        except httpx.TimeoutException:
            raise Unavailable(f'{self.name} took too long to answer.')
        except httpx.HTTPError:
            raise Unavailable(f"Connected to {self.target}, but Marumado isn't answering on port {self.port} there. Is it running?")
        if res.status_code == 403 and _detail(res) == TOKEN_REFUSED:
            raise Unavailable(f"{self.name}'s Marumado refused the token. Set its MARUMADO_TOKEN in Machines.")
        return res


def _detail(res: httpx.Response) -> str:
    try:
        return str(res.json().get('detail', ''))
    except (ValueError, AttributeError):
        return ''


# ---------------------------------------------------------------- registry

def sync():
    """Start, restart or stop tunnels to match the saved machines."""
    from .models import Machine
    rows = {m.id: m for m in Machine.objects.all()}
    with _lock:
        for mid, tunnel in list(_tunnels.items()):
            m = rows.get(mid)
            if m is None or tunnel.config != (m.ssh_target, m.port, m.token):
                tunnel.stop()
                del _tunnels[mid]
            else:
                tunnel.name = m.name
        for mid, m in rows.items():
            if mid not in _tunnels:
                _tunnels[mid] = Tunnel(m)
                _tunnels[mid].start()


def get(machine_id: int) -> Tunnel | None:
    with _lock:
        return _tunnels.get(machine_id)


def statuses() -> list[dict]:
    with _lock:
        tunnels = sorted(_tunnels.values(), key=lambda t: t.name.lower())
    return [t.status() for t in tunnels]


def local_status(system: dict | None) -> dict:
    return {
        'id': 'local', 'name': 'This machine', 'ssh_target': '', 'port': None, 'has_token': False, 'local': True,
        'state': 'up', 'error': '', 'since': None, 'summary': _summary(system),
    }
