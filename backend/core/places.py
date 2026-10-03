"""Where each project runs on the other machines: their Marumados list what runs there by Compose project or folder
(overview.places), and this one matches those to its own projects by name (discovery.project_by_name).

Projects live on the Marumado you open. The other machines are places they run, not hubs of their own.
"""
from . import discovery, machines
from .models import Project


def by_project(projects: list[Project]) -> dict[int, list[dict]]:
    """{project id: [one entry per machine where it runs or is deployed]}, from the machines that answer."""
    out: dict[int, list[dict]] = {p.id: [] for p in projects}
    for tunnel in machines.tunnels():
        overview = tunnel.overview if tunnel.state == 'up' else None
        for g in (overview or {}).get('places') or []:
            p = discovery.project_by_name(g.get('dir', ''), g.get('compose', ''), projects)
            if p is None:
                continue
            containers = g.get('containers') or []
            out[p.id].append({
                'machine': tunnel.id,
                'machine_name': tunnel.name,
                'dir': g.get('dir', ''),
                'compose': g.get('compose', ''),
                'containers': containers,
                'ports': g.get('ports') or [],
                'running': bool(g.get('ports')) or any(c.get('status') == 'running' for c in containers),
            })
    return out


def folder_on(project: Project | None, machine_id: int) -> str:
    """The project's folder on another machine, as that machine's Marumado reports it; '' when unknown."""
    if project is None:
        return ''
    found = by_project([project]).get(project.id, [])
    return next((p['dir'] for p in found if p['machine'] == machine_id and p['dir']), '')
