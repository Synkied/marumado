"""This machine at a glance, for the home view: a few counts per module and the things that need attention.

Every Marumado serves its own at /api/overview; the one you open reads the others' through their tunnels
(machines.Tunnel), so the home view shows every machine side by side.
"""
import threading
import time

from django.db.models import OuterRef, Subquery

from . import discovery, herdr, monitor
from .models import Project, Task, UptimeCheck

# Listing agents runs Herdr (possibly over SSH), so it is shared between requests for a few seconds.
AGENTS_SECONDS = 8

_agents_lock = threading.Lock()
_agents: tuple[float, dict] | None = None


def _cached_agents() -> dict:
    global _agents
    with _agents_lock:
        if _agents and time.time() - _agents[0] < AGENTS_SECONDS:
            return _agents[1]
        data = herdr.agents(include_machines=False)
        _agents = (time.time(), data)
        return data


def _agents_digest() -> dict:
    """This machine's agents: not those of other machines it reaches through their Marumado."""
    data = _cached_agents()
    live = [a for a in data['agents'] if a['kind'] != 'terminal']
    names = {s['id']: s['name'] for s in data['sources']}
    blocked = []
    for a in live:
        if a['status'] == 'blocked':
            where = next((part for part in reversed(a['cwd'].split('/')) if part), a['cwd'])
            label = a['title'] if a['title'] and a['title'] != a['kind'] else a['name'] or a['kind']
            blocked.append({'pane_id': a['pane_id'], 'source': a['source'], 'source_name': names.get(a['source'], ''),
                            'label': label, 'where': where})
    return {
        'available': data['available'],
        'total': len(live),
        'working': sum(a['status'] == 'working' for a in live),
        'blocked': blocked,
        'sources': len(data['sources']),
        'unreachable': [s['name'] for s in data['sources'] if not s['available']],
    }


def _urls_digest(projects: list[Project]) -> dict:
    """Live (online) URLs, judged by their latest check, as the URLs module does."""
    latest = UptimeCheck.objects.filter(project=OuterRef('pk'), target='online').order_by('-checked_at')
    rows = (Project.objects.filter(pk__in=[p.pk for p in projects]).exclude(online_url='')
            .annotate(ok=Subquery(latest.values('ok')[:1]), code=Subquery(latest.values('status_code')[:1]),
                      error=Subquery(latest.values('error')[:1])))
    checked = [r for r in rows if r.ok is not None]
    down = [
        {'id': r.id, 'name': r.name, 'detail': f'HTTP {r.code}' if r.code else (r.error or '').split(':')[0] or 'No response'}
        for r in checked if not r.ok
    ]
    return {'checked': len(checked), 'up': len(checked) - len(down), 'down': down}


def _tasks_digest() -> dict:
    states = list(Task.objects.exclude(state=Task.DONE).values_list('state', flat=True))
    return {
        'open': len(states),
        'working': sum(s in (Task.WORKING, Task.STARTING) for s in states),
        'blocked': sum(s == Task.BLOCKED for s in states),
        'failed': sum(s == Task.FAILED for s in states),
    }


MAX_PLACES = 100


def places(dock: dict, ports: list[dict]) -> list[dict]:
    """What runs here, by Compose project or folder: for the Marumado that shows this machine, which matches each
    to one of its own projects (core/places.py). This machine needn't have the project's code to run it."""
    groups: dict[str, dict] = {}
    for c in dock['containers']:
        key = c['compose_project'] or c['working_dir']
        if not key:
            continue
        g = groups.setdefault(key, {'compose': c['compose_project'], 'dir': c['working_dir'], 'containers': [], 'ports': set()})
        g['dir'] = g['dir'] or c['working_dir']
        g['containers'].append({'name': c['name'], 'service': c['compose_service'], 'status': c['status'], 'health': c['health']})
        g['ports'].update(b['host_port'] for b in c['ports'] if b.get('host_port'))
    for port in ports:
        cwd = port['cwd']
        if not cwd or cwd == '/':
            continue
        g = next((g for g in groups.values() if g['dir'] and discovery.under(cwd, g['dir'])), None)
        if g is None:
            g = groups.setdefault(cwd, {'compose': '', 'dir': cwd, 'containers': [], 'ports': set()})
        g['ports'].add(port['port'])
    out = [{**g, 'ports': sorted(g['ports'])} for g in groups.values()]
    return out[:MAX_PLACES]


def digest() -> dict:
    projects = list(Project.objects.filter(hidden=False))
    code = [p for p in projects if p.kind == Project.KIND_PROJECT and p.path]
    dock = monitor.snapshot('docker')
    ports = monitor.snapshot('ports')

    running = set()
    for port in ports:
        p = discovery.project_for_path(port['cwd'], code)
        if p:
            running.add(p.id)
    for c in dock['containers']:
        p = discovery.project_for_path(c['working_dir'], code) if c['status'] == 'running' else None
        if p:
            running.add(p.id)

    return {
        'time': time.time(),
        'projects': {'total': sum(p.kind == Project.KIND_PROJECT for p in projects), 'running': len(running)},
        'urls': _urls_digest(projects),
        'docker': {
            'available': dock['available'],
            'running': sum(c['status'] == 'running' for c in dock['containers']),
            'total': len(dock['containers']),
            'unhealthy': [c['name'] for c in dock['containers'] if c['health'] == 'unhealthy'],
        },
        'agents': _agents_digest(),
        'ports': len(ports),
        'places': places(dock, ports),
        'tasks': _tasks_digest(),
    }
