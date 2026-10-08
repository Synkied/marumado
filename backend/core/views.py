import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from django.http import HttpResponse
from rest_framework import status, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

import json

from . import auth, checks, discovery, files, herdr, land, machines, monitor, opener, overview, places, plans, pulse, tasks, transcripts
from .models import AgentSource, Machine, Plan, Project, ScanRoot, Skill, Task, UptimeCheck
from .serializers import AgentSourceSerializer, MachineSerializer, PlanSerializer, ProjectSerializer, SkillSerializer, TaskEventSerializer, TaskSerializer, UptimeCheckSerializer

RECENT_CHECKS = 30


@api_view(['GET', 'POST', 'DELETE'])
@permission_classes([AllowAny])
def auth_view(request):
    """GET: is this browser logged in. POST {token}: log in with the password or the access token. DELETE: log out."""
    if request.method == 'GET':
        return Response({'authenticated': auth.session_ok(request.session), 'password': bool(auth.password_hash())})
    if request.headers.get(auth.CSRF_HEADER) != '1':
        return Response({'detail': f'Missing the {auth.CSRF_HEADER} header.'}, status=403)
    if request.method == 'DELETE':
        request.session.flush()
        return HttpResponse(status=204)
    given = request.data.get('token') if isinstance(request.data, dict) else None
    try:
        ok = isinstance(given, str) and auth.try_login(request.META.get('REMOTE_ADDR', ''), given.strip())
    except auth.Locked as exc:
        return Response({'detail': str(exc)}, status=429)
    if not ok:
        return Response({'detail': "That isn't this Marumado's password or access token."}, status=403)
    auth.log_in(request.session)
    return HttpResponse(status=204)


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
    elsewhere = places.by_project(projects)
    rows = []
    context = {'folder_sources': herdr.folder_sources()}
    for p in projects:
        data = ProjectSerializer(p, context=context).data
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
        # Where else it runs: the other machines whose Marumado reports it (core/places.py).
        data['places'] = elsewhere[p.id]
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


class TaskViewSet(viewsets.ModelViewSet):
    """The to-do list. A task can be handed to a coding agent in Herdr, which Marumado then follows (core/tasks.py)."""

    serializer_class = TaskSerializer

    def get_queryset(self):
        """The list leaves archived tasks out; ?archived=1 lists only them."""
        qs = Task.objects.select_related('project')
        if self.action == 'list':
            qs = qs.filter(archived_at__isnull=self.request.query_params.get('archived') != '1')
        return qs

    def retrieve(self, request, pk=None):
        task = self.get_object()
        return Response({**TaskSerializer(task).data, 'events': TaskEventSerializer(task.events.all(), many=True).data})

    def perform_create(self, serializer):
        task = serializer.save()
        tasks.event(task, 'created', 'Added to the list')

    @action(detail=True, methods=['post'])
    def assign(self, request, pk=None):
        """{pane_id, source}: give it to that open agent. {kind, source}: start a new agent of that kind in the project's folder,
        in that source (where Herdr runs; 0, the default, is the one set in .env)."""
        if herdr.terminal_mode() != 'control':
            return Response({'detail': 'Giving tasks to agents is turned off (MARUMADO_HERDR_TERMINAL).'}, status=403)
        task = self.get_object()
        if task.live:
            return Response({'detail': 'An agent is already on it. Mark it done or move it back to do first.'}, status=409)
        pane_id, kind, source = request.data.get('pane_id') or '', request.data.get('kind') or '', request.data.get('source') or 0
        if not isinstance(pane_id, str) or not isinstance(kind, str) or not isinstance(source, int):
            return Response({'detail': 'Send pane_id or kind, and the source.'}, status=400)
        try:
            tasks.assign(task, pane_id, kind, source)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=400)
        except RuntimeError as exc:
            return Response({'detail': str(exc)}, status=502)
        return self.retrieve(request, pk)

    @action(detail=True, methods=['post'])
    def follow(self, request, pk=None):
        """{pane_id, source}: the task is what that agent is already doing. Nothing is sent to it; it is followed from now on."""
        task = self.get_object()
        if task.live:
            return Response({'detail': 'An agent is already on it.'}, status=409)
        pane_id, source = request.data.get('pane_id') or '', request.data.get('source') or 0
        if not isinstance(pane_id, str) or not isinstance(source, int):
            return Response({'detail': 'Send pane_id and the source.'}, status=400)
        try:
            tasks.follow(task, pane_id, source)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=400)
        except RuntimeError as exc:
            return Response({'detail': str(exc)}, status=502)
        return self.retrieve(request, pk)

    @action(detail=True, methods=['get'])
    def trace(self, request, pk=None):
        """What the agent thought and did for this task, from step `from` on (core/transcripts.py)."""
        try:
            start = max(0, int(request.query_params.get('from', 0)))
        except ValueError:
            start = 0
        try:
            return Response(tasks.trace(self.get_object(), start))
        except ValueError as exc:
            return Response({'found': False, 'reason': str(exc), 'steps': [], 'total': 0})
        except RuntimeError as exc:
            return Response({'detail': str(exc)}, status=502)

    @action(detail=True, methods=['post'])
    def done(self, request, pk=None):
        tasks.mark_done(self.get_object())
        return self.retrieve(request, pk)

    @action(detail=True, methods=['post'])
    def review(self, request, pk=None):
        tasks.to_review(self.get_object())
        return self.retrieve(request, pk)

    @action(detail=True, methods=['post'])
    def reopen(self, request, pk=None):
        tasks.reopen(self.get_object())
        return self.retrieve(request, pk)

    @action(detail=True, methods=['post'])
    def archive(self, request, pk=None):
        try:
            tasks.archive(self.get_object())
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=400)
        return self.retrieve(request, pk)

    @action(detail=True, methods=['post'])
    def restore(self, request, pk=None):
        tasks.restore(self.get_object())
        return self.retrieve(request, pk)

    @action(detail=False, methods=['post'], url_path='archive-done')
    def archive_done(self, request):
        """Archive every done task at once."""
        done = list(Task.objects.filter(state=Task.DONE, archived_at__isnull=True))
        for task in done:
            tasks.archive(task)
        return Response({'archived': len(done)})

    @action(detail=True, methods=['post'])
    def go(self, request, pk=None):
        """The owner's go for a plan's step that asks for it before starting."""
        task = self.get_object()
        if not task.plan_id or task.state != Task.QUEUED:
            return Response({'detail': 'Only a queued step of a plan waits for a go.'}, status=400)
        plans.go(task)
        plans.advance()
        return self.retrieve(request, pk)


    # ---- reviewing and landing the agent's work (core/land.py), and its plan's check (core/checks.py)

    def _do(self, request, pk, work):
        try:
            said = work(self.get_object())
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=400)
        except herdr.TimedOut as exc:
            return Response({'detail': str(exc)}, status=504)
        except RuntimeError as exc:
            return Response({'detail': str(exc)}, status=502)
        task = self.get_object()
        return Response({**TaskSerializer(task).data, 'events': TaskEventSerializer(task.events.all(), many=True).data,
                         'said': said if isinstance(said, str) else ''})

    @action(detail=True, methods=['get'])
    def work(self, request, pk=None):
        """What the agent's work is: its branch or the project's folder, its commits and changed files. `?path=`: one
        file's diff."""
        task = self.get_object()
        try:
            path = request.query_params.get('path')
            return Response(land.diff(task, path) if path is not None else land.review(task))
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=400)
        except RuntimeError as exc:
            return Response({'detail': str(exc)}, status=502)

    @action(detail=True, methods=['post'])
    def merge(self, request, pk=None):
        """{clean_up}: merge its branch into the project's (then remove its worktree and branch, by default)."""
        return self._do(request, pk, lambda t: land.merge(t, clean_up=request.data.get('clean_up', True) is not False))

    @action(detail=True, methods=['post'])
    def pr(self, request, pk=None):
        """Push its branch and open a pull request for it."""
        return self._do(request, pk, land.pull_request)

    @action(detail=True, methods=['post'])
    def discard(self, request, pk=None):
        """Throw its branch and worktree away; the task goes back to To do."""
        return self._do(request, pk, land.discard)

    @action(detail=True, methods=['post'])
    def feedback(self, request, pk=None):
        """{text}: send it back to its agent with what to change."""
        text = request.data.get('text')
        if not isinstance(text, str) or not text.strip():
            return Response({'detail': 'Write what to change.'}, status=400)
        if herdr.terminal_mode() != 'control':
            return Response({'detail': 'Giving tasks to agents is turned off (MARUMADO_HERDR_TERMINAL).'}, status=403)
        return self._do(request, pk, lambda t: tasks.send_back(t, text.strip()))

    @action(detail=True, methods=['post'])
    def check(self, request, pk=None):
        """Run its plan's check again."""
        return self._do(request, pk, checks.again)


class PlanViewSet(viewsets.ModelViewSet):
    """Steps for agents to take over on their own, in order or side by side (core/plans.py)."""

    serializer_class = PlanSerializer

    def get_queryset(self):
        """The list leaves archived plans out; ?archived=1 lists only them."""
        qs = Plan.objects.select_related('project').prefetch_related('steps__project')
        if self.action == 'list':
            qs = qs.filter(archived_at__isnull=self.request.query_params.get('archived') != '1')
        return qs

    def perform_destroy(self, instance):
        plans.dissolve(instance)
        instance.delete()

    def perform_update(self, serializer):
        had = serializer.instance.check_command.strip()
        plan = serializer.save()
        if plan.check_command.strip() and not had:
            checks.skip_finished(plan)

    @action(detail=True, methods=['post'])
    def arrange(self, request, pk=None):
        """{rows: [[task id, …], …]}: the steps, row by row; a row's steps run side by side. Tasks named join the
        plan; its steps left out go back to the ideas."""
        layout = request.data.get('rows')
        if not isinstance(layout, list) or not all(isinstance(r, list) and all(isinstance(i, int) for i in r) for r in layout):
            return Response({'detail': 'Send rows: lists of task ids.'}, status=400)
        try:
            plans.arrange(self.get_object(), layout)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=400)
        return Response(PlanSerializer(self.get_object()).data)

    @action(detail=True, methods=['post'])
    def add(self, request, pk=None):
        """{prompt, title?, row?, ask?}: a new step, beside the steps of `row` (an index), or in a new row at the end;
        `ask`: it waits for the owner's go when its turn comes. Without a title, one is made from the prompt."""
        plan = self.get_object()
        made = TaskSerializer(data={'title': request.data.get('title', ''), 'prompt': request.data.get('prompt', ''), 'project': plan.project_id,
                                    'ask': bool(request.data.get('ask'))})
        made.is_valid(raise_exception=True)
        layout = [[t.id for t in row] for row in plans.rows(plan)]
        task = made.save()
        tasks.event(task, 'created', f'Added to “{plan.title}”')
        row = request.data.get('row')
        if isinstance(row, int) and 0 <= row < len(layout):
            layout[row].append(task.id)
        else:
            layout.append([task.id])
        plans.arrange(plan, layout)
        return Response(PlanSerializer(self.get_object()).data, status=201)

    @action(detail=True, methods=['post'])
    def start(self, request, pk=None):
        if herdr.terminal_mode() != 'control':
            return Response({'detail': 'Giving tasks to agents is turned off (MARUMADO_HERDR_TERMINAL).'}, status=403)
        plan = self.get_object()
        if not plan.steps.exists():
            return Response({'detail': 'Add a step first.'}, status=400)
        plans.start(plan)
        plans.advance()
        return Response(PlanSerializer(self.get_object()).data)

    @action(detail=True, methods=['post'])
    def pause(self, request, pk=None):
        plans.pause(self.get_object())
        return Response(PlanSerializer(self.get_object()).data)

    @action(detail=True, methods=['post'])
    def archive(self, request, pk=None):
        try:
            plans.archive(self.get_object())
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=400)
        return Response(PlanSerializer(self.get_object()).data)

    @action(detail=True, methods=['post'])
    def restore(self, request, pk=None):
        plans.restore(self.get_object())
        return Response(PlanSerializer(self.get_object()).data)


class MachineViewSet(viewsets.ModelViewSet):
    """The machines Marumado shows, this one first. Saving or removing one starts or stops its tunnel."""

    serializer_class = MachineSerializer
    queryset = Machine.objects.all()

    def list(self, request):
        return Response([machines.local_status(monitor.snapshot('system'), overview.digest(), monitor.snapshot('history')), *machines.statuses()])

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
        Project.objects.filter(agent_source=herdr.MACHINE_BASE + instance.id).update(agent_source=None)
        herdr.forget_folder_source(herdr.MACHINE_BASE + instance.id)
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
    content = res.content
    if request.method == 'GET' and res.status_code == 200 and rest in ('ports', 'docker', 'processes'):
        content = _as_our_projects(rest, content)
    return HttpResponse(content, status=res.status_code, content_type=res.headers.get('content-type', 'application/json'))


def _as_our_projects(rest: str, content: bytes) -> bytes:
    """Another machine's ports, containers or processes name its own projects (which it rarely has); projects live
    here, so each row is linked to one of ours instead, by its folder or Compose project name."""
    try:
        data = json.loads(content)
    except ValueError:
        return content
    projects = list(Project.objects.filter(kind=Project.KIND_PROJECT))
    ref = lambda p: {'id': p.id, 'name': p.name} if p else None  # noqa: E731
    if rest == 'ports' and isinstance(data, list):
        for r in data:
            r['project'] = ref(discovery.project_by_name(r.get('cwd') or '', '', projects))
    elif rest == 'docker' and isinstance(data, dict):
        for c in data.get('containers') or []:
            c['project'] = ref(discovery.project_by_name(c.get('working_dir') or '', c.get('compose_project') or '', projects))
    elif rest == 'processes' and isinstance(data, dict):
        for r in data.get('processes') or []:
            r['project'] = ref(discovery.project_by_name(r.get('cwd') or '', '', projects))
    return json.dumps(data).encode()


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
    defaults = herdr.folder_sources()
    for r in discovery.roots():
        folder = Path(r['path'])
        rows.append({
            **r,
            'agent_source': defaults.get(r['path']),
            'found': folder.is_dir(),
            'projects': sum(discovery.under(p, r['path']) and p != r['path'] for p in paths),
        })
    return {'roots': rows, 'visible': discovery.visible_dirs()}


def _unseen_folder(path: str) -> str:
    """Why a folder can't be added: it doesn't exist, or Docker doesn't share it with Marumado."""
    if not Path('/.dockerenv').exists():
        return 'There is no folder at that path.'
    visible = discovery.visible_dirs()
    if any(discovery.under(path, d) for d in visible):
        return 'There is no folder at that path.'
    shared = f"Marumado runs in Docker and only sees {', '.join(visible)}. " if visible else 'Marumado runs in Docker and sees no folders of this machine. '
    return (f'{shared}If {path} exists, add it (or a parent) to MARUMADO_MOUNTS in .env, then run make up. '
            'Leave MARUMADO_MOUNTS empty to share your whole home folder.')


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
        return Response({'detail': _unseen_folder(path)}, status=400)
    ScanRoot.objects.create(path=path)
    scan = discovery.scan()
    return Response({**_roots_payload(), 'scan': scan}, status=201)


@api_view(['POST'])
def root_source(request):
    """{path, agent_source}: where the agents of every project in a scan folder start by default (null: no default)."""
    path, source = request.data.get('path'), request.data.get('agent_source')
    if not any(r['path'] == path for r in discovery.roots()):
        return Response({'detail': 'That folder isn\'t scanned.'}, status=400)
    if source is not None:
        if not isinstance(source, int) or isinstance(source, bool):
            return Response({'detail': 'Not an agent source.'}, status=400)
        try:
            herdr.get_source(source)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=400)
    herdr.set_folder_source(path, source)
    return Response(_roots_payload())


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
def file_list(request):
    """The entries of a folder inside a project or scan folder."""
    try:
        return Response(files.listing(request.query_params.get('path', '')))
    except files.Refused as exc:
        return Response({'detail': str(exc)}, status=404)


@api_view(['GET'])
def file_read(request):
    """A text file inside a project or scan folder (the first megabyte), read-only."""
    try:
        return Response(files.read(request.query_params.get('path', '')))
    except files.Refused as exc:
        return Response({'detail': str(exc)}, status=404)


@api_view(['GET'])
def agents(request):
    """Every agent, with the project it works in. `?machines=0`: only this machine's own (what other Marumados ask)."""
    data = herdr.agents(include_machines=request.query_params.get('machines') != '0')
    projects = _projects_of(data['agents'])
    for a in data['agents']:
        p = projects.get(id(a))
        a['project'] = {'id': p.id, 'name': p.name} if p else None
    # The plans' steps waiting for each agent, next first; `asking`: its turn has come, it waits for the owner's go.
    queued = plans.queued_for_agents()
    for a in data['agents']:
        a['queued'] = [{'id': t.id, 'title': t.title, 'plan': t.plan_id, 'asking': t.asking}
                       for t in queued.get((a.get('source', herdr.ENV), a['pane_id']), [])]
    return Response(data)


def _projects_of(listed: list[dict]) -> dict[int, Project]:
    """The project each agent works in, by id() of its entry."""
    projects = list(Project.objects.filter(kind=Project.KIND_PROJECT, hidden=False))
    folders = {s.id: s for s in herdr.sources(include_machines=False) if s.folders}
    out = {}
    for a in listed:
        # In a VM, a project's folder may have another path: its path here is the one to compare.
        src = folders.get(a.get('source', herdr.ENV))
        if p := discovery.project_anywhere(herdr.folder_here(a['cwd'], src) if src else a['cwd'], projects):
            out[id(a)] = p
    return out


@api_view(['POST'])
def agent_queue(request, pane_id: str):
    """{prompt, title?, ask?, source}: queue a step on an open agent, to start once it is free and what was queued
    before it is finished; `ask`: wait for the owner's go first (core/plans.py queue_for)."""
    refused = _control_only('Giving tasks to agents')
    if refused:
        return refused
    try:
        source = _agent_source(request)
    except ValueError as exc:
        return Response({'detail': str(exc)}, status=400)
    agent = next((a for a in herdr.agents()['agents'] if a.get('source', herdr.ENV) == source.id and a['pane_id'] == pane_id), None)
    if agent is None or agent.get('kind') == 'terminal':
        return Response({'detail': 'No such agent open.'}, status=404)
    made = TaskSerializer(data={'title': request.data.get('title', ''), 'prompt': request.data.get('prompt', '')})
    made.is_valid(raise_exception=True)
    step = plans.queue_for(source.id, pane_id, agent, _projects_of([agent]).get(id(agent)), made.validated_data['title'],
                           made.validated_data.get('prompt', ''), ask=bool(request.data.get('ask')))
    plans.advance()
    step.refresh_from_db()
    return Response(TaskSerializer(step).data, status=201)


class AgentSourceViewSet(viewsets.ModelViewSet):
    """The places Herdr runs that were added in the app (the one set in .env is listed by GET /agents)."""

    serializer_class = AgentSourceSerializer
    queryset = AgentSource.objects.all()

    def perform_create(self, serializer):
        serializer.save()
        herdr.forget_failures()

    def perform_update(self, serializer):
        serializer.save()
        herdr.forget_failures()

    def perform_destroy(self, instance):
        Project.objects.filter(agent_source=instance.id).update(agent_source=None)
        herdr.forget_folder_source(instance.id)
        instance.delete()


def _agent_source(request) -> herdr.Source:
    """The `source` the agent lives in (query string, or the body of a POST). Raises ValueError for an unknown one."""
    given = request.query_params.get('source')
    if given is None and isinstance(request.data, dict):
        given = request.data.get('source')
    return herdr.get_source(given)


@api_view(['GET', 'PATCH'])
def agent_env_source(request):
    """The .env agent source's settings that live in the database: {folders: [{here, there}, …]}."""
    if request.method == 'PATCH':
        try:
            herdr.set_env_folders(herdr.clean_folders(request.data.get('folders')))
        except ValueError as exc:
            return Response({'folders': [str(exc)]}, status=400)
    return Response({'folders': herdr.env_folders()})


@api_view(['POST'])
def agent_terminal(request):
    """Open a shell in a new Herdr tab, beside pane `near` or in `workspace` if given (MARUMADO_HERDR_TERMINAL=control only)."""
    if herdr.terminal_mode() != 'control':
        return Response({'detail': 'Opening terminals is turned off (MARUMADO_HERDR_TERMINAL).'}, status=403)
    near, workspace = request.data.get('near') or '', request.data.get('workspace') or ''
    if not isinstance(near, str) or not isinstance(workspace, str):
        return Response({'detail': 'near is a pane id, workspace a workspace id.'}, status=400)
    try:
        source = _agent_source(request)
        return Response({**herdr.new_terminal(near, source, workspace), 'source': source.id}, status=status.HTTP_201_CREATED)
    except ValueError as exc:
        return Response({'detail': str(exc)}, status=400)
    except (RuntimeError, KeyError) as exc:
        return Response({'detail': str(exc)}, status=502)


def _control_only(what: str) -> Response | None:
    if herdr.terminal_mode() != 'control':
        return Response({'detail': f'{what} is turned off (MARUMADO_HERDR_TERMINAL).'}, status=403)
    return None


@api_view(['POST'])
def agent_workspace(request):
    """{cwd, label[, branch | workspace]}: a new Herdr workspace with a shell, for a task (asked by the Marumado that
    shows this machine). With `branch`, a new git worktree of the repository at `cwd` on that branch, for a plan's
    step. With `workspace`, a new tab in that open workspace instead, for an agent started there."""
    refused = _control_only('Starting agents')
    if refused:
        return refused
    cwd, label, branch = request.data.get('cwd') or '', request.data.get('label') or '', request.data.get('branch') or ''
    workspace = request.data.get('workspace') or ''
    if not all(isinstance(v, str) for v in (cwd, label, branch, workspace)):
        return Response({'detail': 'cwd, label, branch and workspace are text.'}, status=400)
    try:
        if workspace:
            return Response({**herdr.open_tab(workspace, cwd, label, _agent_source(request)), 'tab': True}, status=status.HTTP_201_CREATED)
        if branch:
            if not cwd or not herdr.BRANCH.match(branch):
                return Response({'detail': 'A worktree needs the repository folder and a plain branch name.'}, status=400)
            return Response({**herdr.open_worktree(cwd, branch, label, _agent_source(request)), 'worktree': True}, status=status.HTTP_201_CREATED)
        return Response(herdr.open_workspace(cwd, label, _agent_source(request)), status=status.HTTP_201_CREATED)
    except ValueError as exc:
        return Response({'detail': str(exc)}, status=400)
    except (RuntimeError, KeyError) as exc:
        return Response({'detail': str(exc)}, status=502)


@api_view(['POST'])
def agent_workspaces(request):
    """{source, label, project | cwd}: a new Herdr workspace with a shell, in the project's folder there (or `cwd`, as
    that source sees it; neither: Herdr's default folder). Answers {workspace_id, pane_id, cwd, source}."""
    refused = _control_only('Opening workspaces')
    if refused:
        return refused
    label, project_id, cwd = request.data.get('label') or '', request.data.get('project'), request.data.get('cwd') or ''
    if not isinstance(label, str) or not isinstance(cwd, str) or project_id is not None and not isinstance(project_id, int):
        return Response({'detail': 'Send a label, and a project id or a folder.'}, status=400)
    try:
        source = _agent_source(request)
        if project_id is not None:
            project = Project.objects.filter(pk=project_id, kind=Project.KIND_PROJECT).first()
            if project is None:
                return Response({'detail': 'No such project.'}, status=400)
            cwd = tasks.folder_for(project, source.id)
            if not cwd:
                return Response({'detail': f'{project.name} has no folder {source.where()}.'}, status=400)
            label = label or project.name
        made = herdr.create_workspace(label, cwd, source)
        if cwd and made['cwd'] and made['cwd'].rstrip('/') != cwd.rstrip('/'):
            # Herdr opens a folder it can't find in its home folder, without a word.
            try:
                herdr.close_workspace(made['workspace_id'], source=source)
            except (RuntimeError, ValueError):
                pass
            return Response({'detail': f"{cwd} isn't there for Herdr {source.where()}. If it is there under another path, add that folder in Agents → Sources."}, status=400)
        return Response({**made, 'source': source.id}, status=status.HTTP_201_CREATED)
    except ValueError as exc:
        return Response({'detail': str(exc)}, status=400)
    except (RuntimeError, KeyError) as exc:
        return Response({'detail': str(exc)}, status=502)


@api_view(['POST'])
def agent_workspace_close(request, workspace_id: str):
    """{source, group}: close a Herdr workspace and everything in it. `group`: with its git worktrees' workspaces;
    without it, a workspace that has some answers 409 {group: true}."""
    refused = _control_only('Closing workspaces')
    if refused:
        return refused
    group = request.data.get('group') is True
    try:
        herdr.close_workspace(workspace_id, group, _agent_source(request))
    except herdr.GroupClose as exc:
        return Response({'detail': str(exc), 'group': True}, status=409)
    except ValueError as exc:
        return Response({'detail': str(exc)}, status=400)
    except RuntimeError as exc:
        return Response({'detail': str(exc)}, status=502)
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['POST'])
def agent_start(request):
    """{project, kind, source[, workspace]}: a new `kind` agent in the project's folder in that source (no project:
    Herdr's default folder), in a new workspace or a new tab of `workspace`. Answers {pane_id, source, cwd, name} once
    it is open; the agent keeps starting there."""
    refused = _control_only('Starting agents')
    if refused:
        return refused
    project_id, kind, workspace = request.data.get('project'), request.data.get('kind') or '', request.data.get('workspace') or ''
    if project_id is not None and not isinstance(project_id, int) or not isinstance(kind, str) or not isinstance(workspace, str):
        return Response({'detail': 'Send the project id and the kind of agent.'}, status=400)
    project = None
    if project_id is not None:
        project = Project.objects.filter(pk=project_id, kind=Project.KIND_PROJECT).first()
        if project is None:
            return Response({'detail': 'No such project.'}, status=400)
    try:
        source = _agent_source(request)
        cwd = tasks.folder_for(project, source.id)
        if project and not cwd:
            return Response({'detail': f'{project.name} has no folder {source.where()}.'}, status=400)
        started = herdr.start_agent(kind, cwd, project.name if project else '', source, workspace)
        return Response({**started, 'source': source.id}, status=status.HTTP_201_CREATED)
    except ValueError as exc:
        return Response({'detail': str(exc)}, status=400)
    except (RuntimeError, KeyError) as exc:
        return Response({'detail': str(exc)}, status=502)


@api_view(['POST'])
def agent_launch(request, pane_id: str):
    """{name, kind}: start an agent in that pane's shell. `ready`: it takes input already."""
    refused = _control_only('Starting agents')
    if refused:
        return refused
    name, kind = request.data.get('name') or '', request.data.get('kind') or ''
    try:
        return Response({'ready': herdr.launch_agent(str(name), str(kind), pane_id, _agent_source(request))})
    except ValueError as exc:
        return Response({'detail': str(exc)}, status=400)
    except RuntimeError as exc:
        return Response({'detail': str(exc)}, status=502)


@api_view(['POST'])
def agent_task(request, pane_id: str):
    """{text}: give an agent a task and wait for it to start. `blocked`: it is waiting on a question first."""
    refused = _control_only('Giving tasks to agents')
    if refused:
        return refused
    text = request.data.get('text') or ''
    if not isinstance(text, str):
        return Response({'detail': 'text is the task.'}, status=400)
    try:
        return Response({'started': herdr.prompt_task(pane_id, text, _agent_source(request)), 'blocked': False})
    except herdr.Blocked:
        return Response({'started': False, 'blocked': True})
    except ValueError as exc:
        return Response({'detail': str(exc)}, status=400)
    except RuntimeError as exc:
        return Response({'detail': str(exc)}, status=502)


@api_view(['POST'])
def agent_close(request, pane_id: str):
    """Close an agent's or terminal's pane in Herdr (MARUMADO_HERDR_TERMINAL=control only)."""
    if herdr.terminal_mode() != 'control':
        return Response({'detail': 'Closing terminals is turned off (MARUMADO_HERDR_TERMINAL).'}, status=403)
    try:
        herdr.close(pane_id, _agent_source(request))
    except ValueError as exc:
        return Response({'detail': str(exc)}, status=400)
    except (RuntimeError, KeyError) as exc:
        return Response({'detail': str(exc)}, status=502)
    return Response(status=status.HTTP_204_NO_CONTENT)


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
        herdr.send(pane_id, text, tuple(keys), _agent_source(request))
    except ValueError as exc:
        return Response({'detail': str(exc)}, status=400)
    except RuntimeError as exc:
        return Response({'detail': str(exc)}, status=502)
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['GET'])
def agent_trace(request):
    """A session record of an agent on this machine's own Herdr, for a task on another Marumado (core/tasks.py trace):
    {kind, cwd, title, since (unix seconds, optional), path (found last time), from}."""
    q = request.query_params
    try:
        since = float(q['since']) if q.get('since') else None
        start = max(0, int(q.get('from', 0)))
    except ValueError:
        return Response({'detail': 'since and from are numbers.'}, status=400)
    path = q.get('path', '')
    if path and not path.endswith('.jsonl'):
        return Response({'detail': 'Not a session record.'}, status=400)
    try:
        return Response(transcripts.trace(herdr.ENV, q.get('kind', ''), q.get('cwd', ''), since, q.get('title', ''), path, start,
                                          any_session=since is None))
    except RuntimeError as exc:
        return Response({'detail': str(exc)}, status=502)


@api_view(['GET'])
def agent_pulse(request):
    """What the agents wrote lately (core/pulse.py), by folder. `?machines=0`: only this machine's own."""
    return Response(pulse.pulse(include_machines=request.query_params.get('machines') != '0'))


@api_view(['GET'])
def agent_output(request, pane_id: str):
    try:
        return Response({'output': herdr.read(pane_id, int(request.query_params.get('lines', 80)), _agent_source(request))})
    except ValueError as exc:
        return Response({'detail': str(exc)}, status=400)
    except RuntimeError as exc:
        return Response({'detail': str(exc)}, status=502)


@api_view(['GET'])
def agent_conversation(request, pane_id: str):
    """What the pane's agent thought, said and did, from its session record, from step `from` on (negative: the last
    -from steps), for the Conversation view (core/conversation.py)."""
    from . import conversation
    try:
        start = int(request.query_params.get('from', 0))
    except ValueError:
        start = 0
    try:
        return Response(conversation.trace(pane_id, _agent_source(request), start))
    except ValueError as exc:
        return Response({'found': False, 'reason': str(exc), 'steps': [], 'total': 0})
    except RuntimeError as exc:
        return Response({'detail': str(exc)}, status=502)


@api_view(['GET'])
def agent_image(request, pane_id: str):
    """One image of the pane's session record: ?path=<the record>&id=<offset>.<n> (a step's `images`)."""
    from . import conversation
    q = request.query_params
    try:
        kind, data = conversation.image(pane_id, _agent_source(request), q.get('path', ''), q.get('id', ''))
    except ValueError as exc:
        return Response({'detail': str(exc)}, status=404)
    except RuntimeError as exc:
        return Response({'detail': str(exc)}, status=502)
    res = HttpResponse(data, content_type=kind)
    # A record only grows: an image at an offset never changes.
    res['Cache-Control'] = 'private, max-age=31536000, immutable'
    res['X-Content-Type-Options'] = 'nosniff'
    res['Content-Security-Policy'] = "default-src 'none'"
    return res


@api_view(['GET'])
def agent_changes(request, pane_id: str):
    from . import changes
    try:
        return Response(changes.read(pane_id, _agent_source(request), request.query_params.get('path')))
    except ValueError as exc:
        return Response({'detail': str(exc)}, status=400)
    except RuntimeError as exc:
        return Response({'detail': str(exc)}, status=502)
