"""This machine at a glance, for the home view: a few counts per module and the things that need attention.

Every Marumado serves its own at /api/overview; the one you open reads the others' through their tunnels
(machines.Tunnel), so the home view shows every machine side by side.
"""
import threading
import time

from django.db.models import OuterRef, Subquery

from . import discovery, herdr, monitor
from .models import Project, UptimeCheck

# Listing agents runs Herdr (possibly over SSH), so it is shared between requests for a few seconds.
AGENTS_SECONDS = 8

_agents_lock = threading.Lock()
_agents: tuple[float, dict] | None = None


def _cached_agents() -> dict:
    global _agents
    with _agents_lock:
        if _agents and time.time() - _agents[0] < AGENTS_SECONDS:
            return _agents[1]
        data = herdr.agents()
        _agents = (time.time(), data)
        return data


def _agents_digest() -> dict:
    data = _cached_agents()
    live = data['agents']
    blocked = []
    for a in live:
        if a['status'] == 'blocked':
            where = next((part for part in reversed(a['cwd'].split('/')) if part), a['cwd'])
            label = a['title'] if a['title'] and a['title'] != a['kind'] else a['name'] or a['kind']
            blocked.append({'pane_id': a['pane_id'], 'label': label, 'where': where})
    return {
        'available': data['available'],
        'total': len(live),
        'working': sum(a['status'] == 'working' for a in live),
        'blocked': blocked,
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
    }
