import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from django.http import HttpResponse
from rest_framework import status, viewsets
from rest_framework.decorators import action, api_view
from rest_framework.response import Response

from . import discovery, herdr, machines, monitor, opener, overview
from .models import Machine, Project, ScanRoot, Skill, UptimeCheck
from .serializers import MachineSerializer, ProjectSerializer, SkillSerializer, UptimeCheckSerializer

RECENT_CHECKS = 30


def _runtime(projects: list[Project]) -> dict[int, dict]:
    """Which ports and containers belong to which project."""
    out = {p.id: {'ports': [], 'containers': []} for p in projects}
    for port in monitor.snapshot('ports'):
        p = discovery.project_for_path(port['cwd'], projects)
        if p:
            out[p.id]['ports'].append({k: port[k] for k in ('port', 'address', 'pid', 'process')})
    for c in monitor.snapshot('docker')['containers']:
        p = discovery.project_for_path(c['working_dir'], projects)
        if p:
            out[p.id]['containers'].append({k: c[k] for k in ('id', 'name', 'status', 'health', 'ports')})
    return out


def _with_status(projects: list[Project]) -> list[dict]:
    runtime = _runtime(projects)
    rows = []
    for p in projects:
        data = ProjectSerializer(p).data
        checks = {'local': [], 'online': []}
        for c in p.recent_checks:
            if len(checks[c.target]) < RECENT_CHECKS:
                checks[c.target].append(c)
        data['status'] = {
            t: {
                'latest': UptimeCheckSerializer(cs[0]).data if cs else None,
                'latency': [c.latency_ms for c in reversed(cs)],
                'uptime_percent': round(sum(c.ok for c in cs) / len(cs) * 100, 1) if cs else None,
            }
            for t, cs in checks.items()
        }
        rt = runtime[p.id]
        data['running'] = bool(rt['ports'] or any(c['status'] == 'running' for c in rt['containers']))
        data['runtime'] = rt
        port = next((x['port'] for x in rt['ports']), None) or next(
            (b['host_port'] for c in rt['containers'] for b in c['ports']), None)
        data['suggested_local_url'] = f'http://localhost:{port}' if port and not p.local_url else ''
        rows.append(data)
    return rows


class ProjectViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectSerializer

    def get_queryset(self):
        qs = Project.objects.all()
        if self.request.query_params.get('hidden') != '1' and self.action == 'list':
            qs = qs.filter(hidden=False)
        return qs

    def _load(self, projects):
        projects = list(projects)
        since = datetime.now(timezone.utc) - timedelta(hours=6)
        recent = UptimeCheck.objects.filter(project__in=projects, checked_at__gte=since).order_by('-checked_at')
        by_project: dict[int, list] = {}
        for c in recent:
            by_project.setdefault(c.project_id, []).append(c)
        for p in projects:
            p.recent_checks = by_project.get(p.id, [])
        return _with_status(projects)

    def list(self, request):
        return Response(self._load(self.get_queryset()))

    def retrieve(self, request, pk=None):
        return Response(self._load([self.get_object()])[0])

    def destroy(self, request, pk=None):
        project = self.get_object()
        if project.source == Project.SOURCE_SCAN and project.path:
            # A rescan would bring it back, so hide it instead.
            project.hidden = True
            project.save(update_fields=['hidden', 'updated_at'])
        else:
            project.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=['post'])
    def scan(self, request):
        return Response(discovery.scan())

    @action(detail=True, methods=['post'])
    def check(self, request, pk=None):
        monitor.run_uptime_checks([self.get_object()])
        return self.retrieve(request, pk)

    @action(detail=True, methods=['get'])
    def history(self, request, pk=None):
        checks = self.get_object().checks.all()[:200]
        return Response(UptimeCheckSerializer(checks, many=True).data)


class SkillViewSet(viewsets.ModelViewSet):
    serializer_class = SkillSerializer
    queryset = Skill.objects.all()


class MachineViewSet(viewsets.ModelViewSet):
    """The machines Marumado shows, this one first. Saving or removing one starts or stops its tunnel."""

    serializer_class = MachineSerializer
    queryset = Machine.objects.all()

    def list(self, request):
        return Response([machines.local_status(monitor.snapshot('system'), overview.digest()), *machines.statuses()])

    def retrieve(self, request, pk=None):
        machine = self.get_object()
        tunnel = machines.get(machine.id)
        return Response(tunnel.status() if tunnel else {**MachineSerializer(machine).data, 'state': 'connecting'})

    def perform_create(self, serializer):
        serializer.save()
        machines.sync()

    def perform_update(self, serializer):
        serializer.save()
        machines.sync()

    def perform_destroy(self, instance):
        instance.delete()
        machines.sync()


@api_view(['POST'])
def machine_retry(request, pk: int):
    """Reconnect to a machine now, instead of waiting for the next automatic try."""
    tunnel = machines.get(pk)
    if tunnel is None:
        return Response({'detail': 'No such machine.'}, status=404)
    tunnel.retry()
    return Response(tunnel.status())


@api_view(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
def machine_proxy(request, pk: int, rest: str):
    """/api/machines/<id>/<path>: the same call, answered by that machine's Marumado through its tunnel."""
    tunnel = machines.get(pk)
    if tunnel is None or rest.startswith('machines'):
        return Response({'detail': 'No such machine.'}, status=404)
    # This Marumado's own token stays here; the tunnel adds the other machine's.
    query = request._request.GET.copy()
    query.pop('token', None)
    try:
        res = tunnel.request(request.method, rest, query.urlencode(), request.body, request.content_type,
                             timeout=10 if request.method == 'GET' else 30)
    except machines.Unavailable as exc:
        return Response({'detail': str(exc), 'machine': tunnel.name}, status=503)
    if res.status_code == 204:
        return HttpResponse(status=204)
    return HttpResponse(res.content, status=res.status_code, content_type=res.headers.get('content-type', 'application/json'))


@api_view(['GET'])
def system(request):
    return Response(monitor.snapshot('system'))


@api_view(['GET'])
def history(request):
    points = monitor.snapshot('history')
    since = float(request.query_params.get('since', 0) or 0)
    return Response([p for p in points if p['t'] > since])


@api_view(['GET'])
def processes(request):
    rows = monitor.snapshot('processes')
    sort = request.query_params.get('sort', 'cpu')
    if sort not in ('cpu', 'rss', 'pid', 'name', 'threads'):
        sort = 'cpu'
    q = request.query_params.get('q', '').lower()
    if q:
        rows = [r for r in rows if q in r['name'].lower() or q in r['cmdline'].lower() or q == str(r['pid'])]
    rows = sorted(rows, key=lambda r: r[sort], reverse=sort not in ('pid', 'name'))
    limit = min(int(request.query_params.get('limit', 100)), 1000)
    projects = list(Project.objects.exclude(path=''))
    out = []
    for r in rows[:limit]:
        p = discovery.project_for_path(r['cwd'], projects)
        out.append({**r, 'project': {'id': p.id, 'name': p.name} if p else None})
    return Response({'total': len(rows), 'processes': out})


@api_view(['POST'])
def kill(request, pid: int):
    force = bool(request.data.get('force'))
    try:
        monitor.kill_process(pid, force=force)
    except ProcessLookupError:
        return Response({'detail': 'No such process'}, status=404)
    except PermissionError as exc:
        return Response({'detail': str(exc) or 'Permission denied'}, status=403)
    return Response({'ok': True, 'signal': 'SIGKILL' if force else 'SIGTERM'})


@api_view(['GET'])
def ports(request):
    projects = list(Project.objects.exclude(path=''))
    out = []
    for r in monitor.snapshot('ports'):
        p = discovery.project_for_path(r['cwd'], projects)
        out.append({**r, 'project': {'id': p.id, 'name': p.name} if p else None})
    return Response(out)


@api_view(['GET'])
def docker(request):
    data = monitor.snapshot('docker')
    projects = list(Project.objects.exclude(path=''))
    containers = []
    for c in data['containers']:
        p = discovery.project_for_path(c['working_dir'], projects)
        containers.append({**c, 'project': {'id': p.id, 'name': p.name} if p else None})
    return Response({**data, 'containers': containers})


@api_view(['POST'])
def docker_action(request, cid: str, verb: str):
    if verb not in ('start', 'stop', 'restart'):
        return Response({'detail': 'Unknown action'}, status=400)
    try:
        container = monitor.docker_client().containers.get(cid)
        getattr(container, verb)()
    except Exception as exc:
        return Response({'detail': str(exc)[:300]}, status=502)
    monitor.refresh_docker()
    return Response({'ok': True})


@api_view(['GET'])
def docker_logs(request, cid: str):
    tail = min(int(request.query_params.get('tail', 200)), 2000)
    try:
        container = monitor.docker_client().containers.get(cid)
        logs = container.logs(tail=tail, timestamps=True).decode(errors='replace')
    except Exception as exc:
        return Response({'detail': str(exc)[:300]}, status=502)
    return Response({'logs': logs})


@api_view(['GET'])
def overview_view(request):
    """This machine at a glance, for the home view (which reads every machine's)."""
    return Response(overview.digest())


def _roots_payload() -> dict:
    paths = list(Project.objects.filter(hidden=False).exclude(path='').values_list('path', flat=True))
    rows = []
    for r in discovery.roots():
        folder = Path(r['path'])
        rows.append({
            **r,
            'found': folder.is_dir(),
            'projects': sum(discovery.under(p, r['path']) and p != r['path'] for p in paths),
        })
    return {'roots': rows}


@api_view(['GET', 'POST'])
def roots(request):
    if request.method == 'GET':
        return Response(_roots_payload())
    raw = str(request.data.get('path', '')).strip()
    if not raw:
        return Response({'detail': 'Enter a folder path.'}, status=400)
    path = discovery.normalize(raw)
    if not os.path.isabs(path):
        return Response({'detail': 'Use a full path, starting with / (or ~).'}, status=400)
    if any(r['path'] == path for r in discovery.roots()):
        return Response({'detail': 'That folder is already scanned.'}, status=400)
    if not Path(path).is_dir():
        return Response({
            'detail': "Marumado can't see that folder. If it runs in Docker, add the folder (or a parent) "
                      'to MARUMADO_PROJECT_DIRS or MARUMADO_MOUNTS in .env and run make up.',
        }, status=400)
    ScanRoot.objects.create(path=path)
    scan = discovery.scan()
    return Response({**_roots_payload(), 'scan': scan}, status=201)


@api_view(['DELETE'])
def root_detail(request, pk: int):
    deleted, _ = ScanRoot.objects.filter(pk=pk).delete()
    if not deleted:
        return Response({'detail': 'No such folder (folders from .env are removed there).'}, status=404)
    scan = discovery.scan()
    return Response({**_roots_payload(), 'scan': scan})


@api_view(['GET', 'POST'])
def open_folder(request):
    """GET: can folders be opened here? POST: open a project or scan folder in the file manager."""
    reason = opener.unavailable_reason()
    if request.method == 'GET':
        return Response({'available': not reason, 'reason': reason, 'url': opener.url_template()})
    if reason:
        return Response({'detail': reason}, status=409)
    path = discovery.normalize(str(request.data.get('path', '')))
    known = {r['path'] for r in discovery.roots()} | set(Project.objects.exclude(path='').values_list('path', flat=True))
    if path not in known:
        return Response({'detail': 'Only project and scan folders can be opened.'}, status=404)
    if not Path(path).is_dir():
        return Response({'detail': "That folder doesn't exist any more."}, status=404)
    opener.open_folder(path)
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['GET'])
def agents(request):
    return Response(herdr.agents())


@api_view(['POST'])
def agent_input(request, pane_id: str):
    """Type a prompt or a few keys into an agent (MARUMADO_HERDR_TERMINAL=control only)."""
    if herdr.terminal_mode() != 'control':
        return Response({'detail': 'Typing into agents is turned off (MARUMADO_HERDR_TERMINAL).'}, status=403)
    keys = request.data.get('keys') or []
    text = request.data.get('text') or ''
    if not isinstance(keys, list) or not all(isinstance(k, str) for k in keys) or not isinstance(text, str):
        return Response({'detail': 'Send text or a list of keys.'}, status=400)
    try:
        herdr.send(pane_id, text, tuple(keys))
    except ValueError as exc:
        return Response({'detail': str(exc)}, status=400)
    except RuntimeError as exc:
        return Response({'detail': str(exc)}, status=502)
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['GET'])
def agent_output(request, pane_id: str):
    try:
        return Response({'output': herdr.read(pane_id, int(request.query_params.get('lines', 80)))})
    except ValueError as exc:
        return Response({'detail': str(exc)}, status=400)
    except RuntimeError as exc:
        return Response({'detail': str(exc)}, status=502)
