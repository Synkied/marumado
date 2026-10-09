"""Host monitoring. One background thread samples the machine; API views read its cache.

Sampling up front keeps requests fast and makes per-process CPU % meaningful
(psutil needs two readings of the same Process object to compute it).
"""

import os
import platform
import signal
import socket
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor

import httpx
import psutil
from django.conf import settings
from django.db import close_old_connections

_lock = threading.Lock()
_started = False
_state: dict = {
    'history': deque(maxlen=settings.MARUMADO_HISTORY_POINTS),
    'system': None,
    'processes': [],
    'ports': [],
    'docker': {'available': False, 'error': 'Not sampled yet', 'containers': []},
}
_procs: dict[int, psutil.Process] = {}
# Each process's last few minutes of CPU and memory, for its detail view.
PROC_HISTORY_POINTS = 90
_proc_history: dict[int, deque] = {}
_docker_client = None


# ---------------------------------------------------------------- system

def _temperatures() -> list[dict]:
    try:
        temps = psutil.sensors_temperatures() or {}
    except (AttributeError, OSError):
        return []
    out = []
    for chip, readings in temps.items():
        for r in readings:
            if r.current:
                out.append({'chip': chip, 'label': r.label or chip, 'current': r.current, 'high': r.high})
    return out[:16]


def _disks() -> list[dict]:
    out, seen = [], set()
    for part in psutil.disk_partitions(all=False):
        if part.device in seen or part.fstype in ('squashfs', 'tmpfs', 'overlay'):
            continue
        try:
            u = psutil.disk_usage(part.mountpoint)
        except (PermissionError, OSError):
            continue
        seen.add(part.device)
        out.append({
            'device': part.device, 'mount': part.mountpoint, 'fstype': part.fstype,
            'total': u.total, 'used': u.used, 'free': u.free, 'percent': u.percent,
        })
    if not out:  # containers often only expose an overlay root
        u = psutil.disk_usage('/')
        out.append({'device': '/', 'mount': '/', 'fstype': '', 'total': u.total,
                    'used': u.used, 'free': u.free, 'percent': u.percent})
    return out


def _battery():
    try:
        b = psutil.sensors_battery()
    except (AttributeError, OSError):
        return None
    if b is None:
        return None
    return {'percent': b.percent, 'plugged': b.power_plugged, 'secs_left': b.secsleft if b.secsleft > 0 else None}


class _Rates:
    """Turns cumulative counters into per-second rates."""

    def __init__(self):
        self.last: dict[str, tuple[float, float]] = {}

    def __call__(self, key: str, value: float, now: float) -> float:
        prev = self.last.get(key)
        self.last[key] = (now, value)
        if not prev or now <= prev[0]:
            return 0.0
        return max(0.0, (value - prev[1]) / (now - prev[0]))


_rate = _Rates()


def _sample_system(now: float) -> dict:
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    net = psutil.net_io_counters()
    dio = psutil.disk_io_counters()
    per_core = psutil.cpu_percent(percpu=True)
    cpu = sum(per_core) / len(per_core) if per_core else 0.0
    freq = psutil.cpu_freq()
    try:
        load = os.getloadavg()
    except OSError:
        load = (0, 0, 0)
    nics = []
    for name, st in psutil.net_if_stats().items():
        if name == 'lo':
            continue
        c = psutil.net_io_counters(pernic=True).get(name)
        nics.append({
            'name': name, 'up': st.isup, 'speed_mbps': st.speed,
            'rx_rate': _rate(f'nic:{name}:rx', c.bytes_recv, now) if c else 0,
            'tx_rate': _rate(f'nic:{name}:tx', c.bytes_sent, now) if c else 0,
        })
    return {
        'time': now,
        'host': {
            'hostname': socket.gethostname(),
            'os': f'{platform.system()} {platform.release()}',
            'arch': platform.machine(),
            'boot_time': psutil.boot_time(),
            'cpu_model': _cpu_model(),
            'cores_logical': psutil.cpu_count(),
            'cores_physical': psutil.cpu_count(logical=False),
        },
        'cpu': {
            'percent': round(cpu, 1),
            'per_core': per_core,
            'freq_mhz': round(freq.current) if freq else None,
            'load': [round(x, 2) for x in load],
        },
        'memory': {
            'total': vm.total, 'used': vm.total - vm.available, 'available': vm.available,
            # Linux's page cache and buffers: counted in neither used nor really free, the kernel gives them back.
            'cached': getattr(vm, 'cached', 0) + getattr(vm, 'buffers', 0),
            'percent': vm.percent, 'swap_total': sw.total, 'swap_used': sw.used, 'swap_percent': sw.percent,
        },
        'net': {
            'rx_rate': _rate('net:rx', net.bytes_recv, now),
            'tx_rate': _rate('net:tx', net.bytes_sent, now),
            'rx_total': net.bytes_recv, 'tx_total': net.bytes_sent,
            'interfaces': nics,
        },
        'disk_io': {
            'read_rate': _rate('disk:r', dio.read_bytes, now) if dio else 0,
            'write_rate': _rate('disk:w', dio.write_bytes, now) if dio else 0,
        },
        'disks': _disks(),
        'temperatures': _temperatures(),
        'battery': _battery(),
    }


_cpu_model_cache = None


def _cpu_model() -> str:
    global _cpu_model_cache
    if _cpu_model_cache is None:
        _cpu_model_cache = platform.processor() or ''
        try:
            with open('/proc/cpuinfo') as f:
                for line in f:
                    if line.startswith('model name'):
                        _cpu_model_cache = line.split(':', 1)[1].strip()
                        break
        except OSError:
            pass
    return _cpu_model_cache


# ---------------------------------------------------------------- processes & ports

def _is_kernel_thread(pid: int, ppid: int) -> bool:
    # Linux kernel threads are kthreadd (pid 2) and its children; they have no command line of their own.
    return platform.system() == 'Linux' and (pid == 2 or ppid == 2)


def _sample_processes(now: float) -> list[dict]:
    alive = set()
    rows = []
    total_mem = psutil.virtual_memory().total
    for p in psutil.process_iter():
        pid = p.pid
        alive.add(pid)
        proc = _procs.setdefault(pid, p)
        try:
            with proc.oneshot():
                cpu = proc.cpu_percent(None)
                mem = proc.memory_info().rss
                times = proc.cpu_times()
                try:
                    cwd = proc.cwd()
                except (psutil.AccessDenied, psutil.ZombieProcess, OSError):
                    cwd = ''
                try:
                    cmd = ' '.join(proc.cmdline())[:400]
                except (psutil.AccessDenied, psutil.ZombieProcess):
                    cmd = ''
                ppid = proc.ppid()
                rows.append({
                    'pid': pid, 'ppid': ppid, 'name': proc.name(),
                    'user': _safe(proc.username), 'status': proc.status(),
                    'cpu': round(cpu, 1), 'rss': mem, 'mem_percent': round(mem / total_mem * 100, 2),
                    'threads': proc.num_threads(), 'started': proc.create_time(),
                    'cpu_time': round(times.user + times.system, 2),
                    'nice': _safe(proc.nice),
                    'kernel': _is_kernel_thread(pid, ppid),
                    'cwd': cwd, 'cmdline': cmd,
                })
        except (psutil.NoSuchProcess, psutil.ZombieProcess, psutil.AccessDenied):
            continue
    for pid in list(_procs):
        if pid not in alive:
            del _procs[pid]
    with _lock:  # requests read the history while this thread writes it
        for r in rows:
            hist = _proc_history.get(r['pid'])
            if hist is None:
                hist = _proc_history[r['pid']] = deque(maxlen=PROC_HISTORY_POINTS)
            hist.append((now, r['cpu'], r['rss']))
        for pid in list(_proc_history):
            if pid not in alive:
                del _proc_history[pid]
    return rows


def process_history(pid: int) -> list[tuple[float, float, int]]:
    with _lock:
        return list(_proc_history.get(pid, ()))


def process_detail(pid: int) -> dict:
    """What the list doesn't carry, read now: open files, I/O and the full command line."""
    proc = psutil.Process(pid)
    out: dict = {'pid': pid}
    with proc.oneshot():
        try:
            out['cmdline'] = proc.cmdline()
        except (psutil.AccessDenied, psutil.ZombieProcess):
            out['cmdline'] = []
        out['exe'] = _safe(proc.exe)
        try:
            io = proc.io_counters()
            out['io'] = {'read': io.read_bytes, 'write': io.write_bytes}
        except (psutil.AccessDenied, AttributeError, OSError):
            out['io'] = None
        try:
            out['fds'] = proc.num_fds()
        except (psutil.AccessDenied, AttributeError, OSError):
            out['fds'] = None
        try:
            out['children'] = [c.pid for c in proc.children()]
        except psutil.Error:
            out['children'] = []
        try:
            mi = proc.memory_info()
            out['vms'] = mi.vms
        except psutil.Error:
            out['vms'] = None
    return out


def _safe(fn):
    try:
        return fn()
    except (psutil.AccessDenied, psutil.NoSuchProcess, KeyError):
        return ''


def _sample_ports(proc_by_pid: dict[int, dict]) -> list[dict]:
    try:
        conns = psutil.net_connections(kind='inet')
    except (psutil.AccessDenied, OSError):
        # macOS needs root for the global table; fall back to the processes we can see.
        conns = []
        for pid in proc_by_pid:
            try:
                conns += [c._replace(pid=pid) for c in psutil.Process(pid).net_connections(kind='inet')]
            except (psutil.Error, OSError):
                continue
    seen, out = set(), []
    for c in conns:
        if c.status != psutil.CONN_LISTEN or not c.laddr:
            continue
        key = (c.laddr.port, c.pid, c.type)
        if key in seen:
            continue
        seen.add(key)
        proc = proc_by_pid.get(c.pid or -1, {})
        out.append({
            'port': c.laddr.port, 'address': c.laddr.ip,
            'proto': 'tcp' if c.type == socket.SOCK_STREAM else 'udp',
            'pid': c.pid, 'process': proc.get('name', ''), 'cwd': proc.get('cwd', ''),
            'cmdline': proc.get('cmdline', ''),
        })
    out.sort(key=lambda r: r['port'])
    return out


def kill_process(pid: int, force: bool = False) -> None:
    if pid in (0, 1, os.getpid()):
        raise PermissionError('Refusing to signal this process')
    os.kill(pid, signal.SIGKILL if force else signal.SIGTERM)


# ---------------------------------------------------------------- docker

def docker_client():
    global _docker_client
    if _docker_client is None:
        import docker
        _docker_client = docker.from_env(timeout=5)
    return _docker_client


def _container_row(c, stats: dict | None) -> dict:
    labels = c.labels or {}
    ports = []
    for container_port, binds in (c.attrs.get('NetworkSettings', {}).get('Ports') or {}).items():
        for b in binds or []:
            ports.append({'host_port': int(b['HostPort']), 'host_ip': b.get('HostIp', ''), 'container_port': container_port})
    row = {
        'id': c.short_id, 'name': c.name, 'image': (c.image.tags or [c.attrs['Config']['Image']])[0] if c.image else c.attrs['Config']['Image'],
        'status': c.status, 'state': c.attrs.get('State', {}).get('Status', c.status),
        'health': (c.attrs.get('State', {}).get('Health') or {}).get('Status'),
        'started_at': c.attrs.get('State', {}).get('StartedAt'),
        'compose_project': labels.get('com.docker.compose.project', ''),
        'compose_service': labels.get('com.docker.compose.service', ''),
        'working_dir': labels.get('com.docker.compose.project.working_dir', ''),
        'ports': ports, 'cpu': None, 'mem': None, 'mem_limit': None,
    }
    if stats:
        try:
            cpu_delta = stats['cpu_stats']['cpu_usage']['total_usage'] - stats['precpu_stats']['cpu_usage']['total_usage']
            sys_delta = stats['cpu_stats'].get('system_cpu_usage', 0) - stats['precpu_stats'].get('system_cpu_usage', 0)
            ncpu = stats['cpu_stats'].get('online_cpus') or 1
            row['cpu'] = round(cpu_delta / sys_delta * ncpu * 100, 1) if sys_delta > 0 else 0.0
            row['mem'] = stats['memory_stats'].get('usage')
            row['mem_limit'] = stats['memory_stats'].get('limit')
        except (KeyError, TypeError):
            pass
    return row


def _sample_docker() -> dict:
    try:
        client = docker_client()
        containers = client.containers.list(all=True)
    except Exception as exc:  # docker missing, socket denied, daemon down...
        global _docker_client
        _docker_client = None
        msg = str(exc)
        if 'FileNotFoundError' in msg or 'No such file' in msg or 'API version' in msg:
            msg = 'Docker is not installed or its daemon is not running.'
        elif 'Permission' in msg:
            msg = 'No permission to read the Docker socket. Add this user to the docker group.'
        return {'available': False, 'error': msg[:200], 'containers': []}
    running = [c for c in containers if c.status == 'running']

    def stats(c):
        try:
            return c.stats(stream=False)
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=8) as pool:
        stat_by_id = dict(zip([c.id for c in running], pool.map(stats, running)))
    rows = [_container_row(c, stat_by_id.get(c.id)) for c in containers]
    rows.sort(key=lambda r: (r['status'] != 'running', r['name']))
    return {'available': True, 'error': '', 'containers': rows}


# ---------------------------------------------------------------- uptime

def check_url(url: str) -> dict:
    start = time.perf_counter()
    try:
        r = httpx.get(url, timeout=8, follow_redirects=True, headers={'User-Agent': 'Marumado uptime check'})
        return {'ok': r.status_code < 500, 'status_code': r.status_code,
                'latency_ms': round((time.perf_counter() - start) * 1000, 1), 'error': ''}
    except httpx.HTTPError as exc:
        return {'ok': False, 'status_code': None, 'latency_ms': None, 'error': (type(exc).__name__ + ': ' + str(exc))[:300]}


def run_uptime_checks(projects=None) -> int:
    from .models import Project, UptimeCheck

    if projects is None:
        projects = list(Project.objects.filter(hidden=False))
    jobs = [(p, t, getattr(p, f'{t}_url')) for p in projects for t in ('local', 'online') if getattr(p, f'{t}_url')]
    if not jobs:
        return 0
    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(lambda j: check_url(j[2]), jobs))
    UptimeCheck.objects.bulk_create(
        UptimeCheck(project=p, target=t, url=url, **res) for (p, t, url), res in zip(jobs, results)
    )
    # Keep the last 500 checks per project/target.
    for p, t, _ in jobs:
        stale = UptimeCheck.objects.filter(project=p, target=t).values_list('id', flat=True)[500:]
        UptimeCheck.objects.filter(id__in=list(stale)).delete()
    return len(jobs)


# ---------------------------------------------------------------- loop

def _forever(name: str, interval, step):
    """Run `step` every `interval()` seconds; never let an error kill the thread."""
    while True:
        began = time.time()
        try:
            step(began)
        except Exception as exc:
            print(f'[marumado] {name} error: {exc!r}')
        finally:
            close_old_connections()
        time.sleep(max(0.2, interval() - (time.time() - began)))


def _fast_step(now: float):
    system = _sample_system(now)
    processes = _sample_processes(now)
    system['process_count'] = len(processes)
    states: dict[str, int] = {}
    for p in processes:
        states[p['status']] = states.get(p['status'], 0) + 1
    system['tasks'] = {
        'total': len(processes),
        'threads': sum(p['threads'] for p in processes),
        'kernel': sum(1 for p in processes if p['kernel']),
        'states': states,
    }
    point = {
        't': now, 'cpu': system['cpu']['percent'], 'mem': system['memory']['percent'],
        'rx': system['net']['rx_rate'], 'tx': system['net']['tx_rate'],
        'dr': system['disk_io']['read_rate'], 'dw': system['disk_io']['write_rate'],
    }
    with _lock:
        _state['system'] = system
        _state['processes'] = processes
        _state['history'].append(point)


def _slow_step(now: float):
    # Ports and Docker are heavier (docker stats alone takes ~1-2s), so they get their own thread.
    with _lock:
        processes = _state['processes']
    ports = _sample_ports({p['pid']: p for p in processes})
    with _lock:
        _state['ports'] = ports
    refresh_docker()


_rescanned = False


def _rescan_step(now: float):
    # `serve` already scans on start; after that, rescan so Momentum stays current.
    global _rescanned
    if _rescanned:
        from . import discovery
        discovery.scan()
    _rescanned = True


def _tasks_step(now: float):
    from . import checks, plans, tasks
    tasks.watch(now)
    # A step whose agent just finished is checked before the steps under it can start.
    checks.run_due()
    # Then the plans: those whose start time has come, and a step whose agent just finished can go now.
    plans.start_due()
    plans.advance()
    plans.archive_done()


def ensure_started():
    global _started
    if _started:
        return
    with _lock:
        if _started:
            return
        _started = True
    psutil.cpu_percent(percpu=True)  # prime the CPU counters
    loops = [
        ('sampler', lambda: settings.MARUMADO_SAMPLE_SECONDS, _fast_step),
        ('ports+docker', lambda: 5, _slow_step),
        ('uptime', lambda: settings.MARUMADO_UPTIME_SECONDS, lambda now: run_uptime_checks()),
        ('rescan', lambda: 3600, _rescan_step),
        ('tasks', lambda: 4, _tasks_step),
    ]
    from . import machines
    machines.sync()
    for name, interval, step in loops:
        threading.Thread(target=_forever, args=(name, interval, step), name=f'marumado-{name}', daemon=True).start()
    # Give the first sample a moment so the first request isn't empty.
    for _ in range(30):
        if _state['system'] is not None:
            break
        time.sleep(0.1)


def snapshot(key: str):
    with _lock:
        value = _state[key]
        return list(value) if isinstance(value, deque) else value


def refresh_docker():
    dock = _sample_docker()
    with _lock:
        _state['docker'] = dock
    return dock
