import os
import subprocess
import tempfile
from unittest import mock

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from . import herdr, monitor, tasks
from .models import AgentSource, Project, Task

GIT = {'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'safe.directory', 'GIT_CONFIG_VALUE_0': '*',
       'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'}


def agents(*rows, down=()):
    """herdr.agents() with these panes. A row may end with its source id (0, the .env one, by default);
    every source a row names is listed, and those in `down` are unreachable."""
    rows = [(*r, 0) if len(r) == 5 else r for r in rows]
    ids = sorted({0, *(r[5] for r in rows), *down})
    return {'available': True, 'error': '', 'where': 'here', 'terminal': 'control', 'kinds': ['claude'],
            'sources': [{'id': i, 'name': f'source {i}', 'kind': 'env' if i == 0 else 'ssh', 'where': 'here',
                         'available': i not in down, 'error': '', 'agents': 0} for i in ids],
            'agents': [{'pane_id': p, 'source': src, 'name': n, 'kind': k, 'status': s, 'title': t, 'cwd': '/x',
                        'workspace': '', 'focused': False} for p, n, k, s, t, src in rows if src not in down]}


class SyncThread:
    """Runs the handover at once, so tests don't race it."""

    def __init__(self, target, args, **_):
        self.run = lambda: target(*args)

    def start(self):
        self.run()


@override_settings(MARUMADO_TOKEN='test-token')
@mock.patch.object(monitor, 'ensure_started', lambda: None)
@mock.patch.object(tasks.threading, 'Thread', SyncThread)
@mock.patch.object(tasks.herdr, 'read', lambda pane, lines=80, source=0: f'output of {pane}')
class TaskFlowTests(TestCase):
    def setUp(self):
        env = mock.patch.dict(os.environ, GIT)
        env.start()
        self.addCleanup(env.stop)
        self.repo = tempfile.mkdtemp()
        git = lambda *a: subprocess.run(['git', '-C', self.repo, *a], check=True, capture_output=True)
        git('init', '-q')
        open(f'{self.repo}/a.txt', 'w').write('a')
        git('add', '.')
        git('commit', '-qm', 'first')
        self.git = git
        self.project = Project.objects.create(name='demo', path=self.repo)
        self.api = APIClient()
        self.api.credentials(HTTP_AUTHORIZATION='Bearer test-token')

    def create(self):
        res = self.api.post('/api/tasks', {'title': 'Add a README', 'notes': 'Short one.', 'project': self.project.id}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.json()['id']

    def watch(self, *rows, down=()):
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents(*rows, down=down)):
            tasks.watch()

    def test_existing_agent_works_then_finishes_with_changes(self):
        tid = self.create()
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents(('w1:p2', 'bob', 'claude', 'idle', ''))), \
                mock.patch.object(tasks.herdr, 'prompt_task', return_value=True) as prompt:
            res = self.api.post(f'/api/tasks/{tid}/assign', {'pane_id': 'w1:p2'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        prompt.assert_called_once_with('w1:p2', 'Add a README\n\nShort one.', 0)
        self.assertEqual(res.json()['state'], 'starting')

        self.watch(('w1:p2', 'bob', 'claude', 'working', 'Writing README'))
        self.assertEqual(Task.objects.get(pk=tid).state, 'working')
        open(f'{self.repo}/README.md', 'w').write('hi')
        self.git('add', '.')
        self.git('commit', '-qm', 'add readme')
        open(f'{self.repo}/new.txt', 'w').write('untracked')
        self.watch(('w1:p2', 'bob', 'claude', 'blocked', 'Writing README'))
        self.assertEqual(Task.objects.get(pk=tid).state, 'blocked')
        self.watch(('w1:p2', 'bob', 'claude', 'done', 'Writing README'))

        task = self.api.get(f'/api/tasks/{tid}').json()
        self.assertEqual(task['state'], 'review')
        self.assertTrue(task['live'])
        kinds = [e['kind'] for e in task['events']]
        self.assertEqual(kinds, ['created', 'assigned', 'prompt', 'activity', 'state', 'state', 'state', 'changes'])
        self.assertEqual([e['state'] for e in task['events'] if e['kind'] == 'state'], ['working', 'blocked', 'done'])
        change = task['events'][-1]['data']
        self.assertEqual([c['subject'] for c in change['commits']], ['add readme'])
        self.assertEqual({f['path']: f['status'] for f in change['files']}, {'README.md': 'A', 'new.txt': '?'})

        # The same state again records nothing; marking done stops watching.
        self.watch(('w1:p2', 'bob', 'claude', 'done', 'Writing README'))
        self.assertEqual(len(self.api.get(f'/api/tasks/{tid}').json()['events']), 8)
        task = self.api.post(f'/api/tasks/{tid}/done').json()
        self.assertEqual((task['state'], task['live']), ('done', False))

    def test_new_agent_is_started_in_the_project(self):
        tid = self.create()
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents(('w1:p1', 'task-%d' % tid, 'claude', 'idle', ''))), \
                mock.patch.object(tasks.herdr, 'open_workspace', return_value={'pane_id': 'w2:p1', 'cwd': self.repo}) as opened, \
                mock.patch.object(tasks.herdr, 'launch_agent', return_value=True) as start, \
                mock.patch.object(tasks.herdr, 'prompt_task', return_value=False):
            res = self.api.post(f'/api/tasks/{tid}/assign', {'kind': 'claude'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        opened.assert_called_once_with(self.repo, 'demo', 0)
        start.assert_called_once_with(f'task-{tid}-2', 'claude', 'w2:p1', 0)
        task = Task.objects.get(pk=tid)
        self.assertEqual((task.pane_id, task.state), ('w2:p1', 'starting'))
        # Never picked up: idle keeps it starting.
        self.watch(('w2:p1', f'task-{tid}-2', 'claude', 'idle', ''))
        self.assertEqual(Task.objects.get(pk=tid).state, 'starting')

    def test_new_agent_asking_first_gets_the_task_once_answered(self):
        tid = self.create()
        asking = agents(('w2:p1', '', 'claude', 'blocked', 'Claude Code'))
        with mock.patch.object(tasks.herdr, 'agents', return_value=asking), \
                mock.patch.object(tasks.herdr, 'open_workspace', return_value={'pane_id': 'w2:p1', 'cwd': self.repo}), \
                mock.patch.object(tasks.herdr, 'launch_agent', return_value=False), \
                mock.patch.object(tasks.herdr, 'prompt_task') as prompt:
            self.api.post(f'/api/tasks/{tid}/assign', {'kind': 'claude'}, format='json')
        prompt.assert_not_called()
        task = Task.objects.get(pk=tid)
        self.assertEqual((task.state, task.prompt_pending, task.live), ('starting', True, True))

        # The monitor sees it stop on its question, then: nothing happens. Answered: the task is sent.
        self.watch(('w2:p1', '', 'claude', 'blocked', 'Claude Code'))
        with mock.patch.object(tasks.herdr, 'prompt_task', return_value=True) as prompt:
            self.watch(('w2:p1', '', 'claude', 'idle', 'Claude Code'))
        prompt.assert_called_once()
        task = Task.objects.get(pk=tid)
        self.assertEqual((task.state, task.prompt_pending), ('starting', False))
        self.watch(('w2:p1', '', 'claude', 'working', 'Adding a README'))
        self.assertEqual(Task.objects.get(pk=tid).state, 'working')
        # The title that only names the agent is not activity.
        texts = [e.text for e in Task.objects.get(pk=tid).events.filter(kind='activity')]
        self.assertEqual(texts, ['Adding a README'])

    def test_slow_agent_gets_the_task_once_ready_or_fails_after_a_while(self):
        tid = self.create()
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents()), \
                mock.patch.object(tasks.herdr, 'open_workspace', return_value={'pane_id': 'w2:p1', 'cwd': '/root'}), \
                mock.patch.object(tasks.herdr, 'launch_agent', return_value=False):
            self.api.post(f'/api/tasks/{tid}/assign', {'kind': 'claude'}, format='json')
        task = Task.objects.get(pk=tid)
        self.assertEqual((task.state, task.pane_id, task.prompt_pending), ('starting', 'w2:p1', True))
        # The project folder isn't where Herdr runs: said so.
        self.assertTrue(task.events.filter(kind='error', text__contains="isn't on the machine").exists())
        # Still a bare shell: wait.
        self.watch(('w2:p1', '', 'terminal', 'unknown', ''))
        self.assertEqual(Task.objects.get(pk=tid).state, 'starting')
        with mock.patch.object(tasks.herdr, 'prompt_task', return_value=True) as prompt:
            self.watch(('w2:p1', '', 'claude', 'idle', 'Claude Code'))
        prompt.assert_called_once()
        self.assertFalse(Task.objects.get(pk=tid).prompt_pending)

        # Another one that never comes up fails after START_SECONDS.
        Task.objects.filter(pk=tid).update(state='starting', prompt_pending=True, agent_state='',
                                           started_at=tasks._now() - tasks.timedelta(seconds=tasks.herdr.START_SECONDS + 1))
        self.watch(('w2:p1', '', 'terminal', 'unknown', ''))
        task = Task.objects.get(pk=tid)
        self.assertEqual((task.state, task.live), ('failed', False))
        self.assertIn("didn't start", task.events.last().text)

    def test_delete_during_handover_does_not_bring_it_back(self):
        tid = self.create()

        def deleted_meanwhile(*_):
            Task.objects.filter(pk=tid).delete()
            return True
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents(('w1:p2', 'bob', 'claude', 'idle', ''))), \
                mock.patch.object(tasks.herdr, 'prompt_task', side_effect=deleted_meanwhile):
            self.api.post(f'/api/tasks/{tid}/assign', {'pane_id': 'w1:p2'}, format='json')
        self.assertFalse(Task.objects.filter(pk=tid).exists())

    def test_closed_pane_fails_a_working_task(self):
        tid = self.create()
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents(('w1:p2', 'bob', 'claude', 'idle', ''))), \
                mock.patch.object(tasks.herdr, 'prompt_task', return_value=True):
            self.api.post(f'/api/tasks/{tid}/assign', {'pane_id': 'w1:p2'}, format='json')
        self.watch(('w1:p2', 'bob', 'claude', 'working', ''))
        self.watch()
        task = Task.objects.get(pk=tid)
        self.assertEqual((task.state, task.live), ('failed', False))

    def test_handover_error_fails_the_task(self):
        tid = self.create()
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents(('w1:p2', 'bob', 'claude', 'idle', ''))), \
                mock.patch.object(tasks.herdr, 'prompt_task', side_effect=RuntimeError('boom')):
            self.api.post(f'/api/tasks/{tid}/assign', {'pane_id': 'w1:p2'}, format='json')
        task = self.api.get(f'/api/tasks/{tid}').json()
        self.assertEqual(task['state'], 'failed')
        self.assertIn('boom', task['events'][-1]['text'])

    def test_busy_agent_is_refused(self):
        tid = self.create()
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents(('w1:p2', 'bob', 'claude', 'working', ''))):
            res = self.api.post(f'/api/tasks/{tid}/assign', {'pane_id': 'w1:p2'}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(Task.objects.get(pk=tid).state, 'todo')

    def test_moving_between_columns(self):
        tid = self.create()
        self.assertEqual(self.api.post(f'/api/tasks/{tid}/review').json()['state'], 'review')
        self.assertEqual(self.api.post(f'/api/tasks/{tid}/done').json()['state'], 'done')
        task = self.api.post(f'/api/tasks/{tid}/reopen').json()
        self.assertEqual(task['state'], 'todo')
        self.assertEqual([e['kind'] for e in task['events']], ['created', 'moved', 'done', 'reopened'])

    def test_agents_in_other_sources_are_told_apart(self):
        # The same pane id in two sources: the task follows the one in the source it was given to.
        tid = self.create()
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents(('w1:p2', 'bob', 'claude', 'working', ''),
                                                                        ('w1:p2', 'ann', 'claude', 'idle', '', 7))), \
                mock.patch.object(tasks.herdr, 'prompt_task', return_value=True) as prompt:
            res = self.api.post(f'/api/tasks/{tid}/assign', {'pane_id': 'w1:p2', 'source': 7}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        prompt.assert_called_once_with('w1:p2', mock.ANY, 7)
        task = Task.objects.get(pk=tid)
        self.assertEqual((task.agent_source, task.agent_name), (7, 'ann'))
        self.assertIn('on source 7', task.events.get(kind='assigned').text)
        self.watch(('w1:p2', 'bob', 'claude', 'idle', ''), ('w1:p2', 'ann', 'claude', 'working', '', 7))
        self.assertEqual(Task.objects.get(pk=tid).state, 'working')

        # Its source unreachable for a moment: nothing changes. Gone from the list: the agent is closed.
        self.watch(('w1:p2', 'bob', 'claude', 'idle', ''), down=(7,))
        self.assertEqual(Task.objects.get(pk=tid).state, 'working')
        self.watch(('w1:p2', 'bob', 'claude', 'idle', ''))
        task = Task.objects.get(pk=tid)
        self.assertEqual((task.state, task.live), ('failed', False))

    def test_an_agent_already_at_work_becomes_a_task(self):
        tid = self.create()
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents(('w1:p2', 'bob', 'claude', 'working', 'Fixing CSS'))), \
                mock.patch.object(tasks.herdr, 'prompt_task') as prompt:
            res = self.api.post(f'/api/tasks/{tid}/follow', {'pane_id': 'w1:p2', 'source': 0}, format='json')
            again = self.api.post(f'/api/tasks/{self.create()}/follow', {'pane_id': 'w1:p2', 'source': 0}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        prompt.assert_not_called()  # nothing is sent: it is only followed
        task = Task.objects.get(pk=tid)
        self.assertEqual((task.state, task.live, task.agent_title), ('working', True, 'Fixing CSS'))
        self.assertEqual(again.status_code, 400)
        self.watch(('w1:p2', 'bob', 'claude', 'idle', ''))
        self.assertEqual(Task.objects.get(pk=tid).state, 'review')

    def test_unreachable_source_refuses_the_task(self):
        tid = self.create()
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents(down=(7,))):
            res = self.api.post(f'/api/tasks/{tid}/assign', {'kind': 'claude', 'source': 7}, format='json')
        self.assertEqual(res.status_code, 502, res.content)
        self.assertEqual(Task.objects.get(pk=tid).state, 'todo')


def fake_herdr(panes: dict):
    """A herdr._run answering `pane list` and `workspace list` for each source name in `panes`; None fails."""
    calls = []

    def run(src, *args, text=False, timeout=0):
        calls.append((src.name, args))
        if panes[src.name] is None:
            raise RuntimeError('SSH to box failed: Connection refused')
        if args[:2] == ('pane', 'list'):
            return {'panes': [{'pane_id': p, 'workspace_id': 'w1', 'agent': 'claude', 'agent_status': 'idle'} for p in panes[src.name]]}
        if args[:2] == ('workspace', 'list'):
            return {'workspaces': [{'workspace_id': 'w1', 'label': src.name}]}
        return 'output' if text else {}
    return run, calls


@override_settings(MARUMADO_TOKEN='test-token')
@mock.patch.object(monitor, 'ensure_started', lambda: None)
class AgentSourceTests(TestCase):
    def setUp(self):
        herdr.forget_failures()
        self.addCleanup(herdr.forget_failures)
        self.api = APIClient()
        self.api.credentials(HTTP_AUTHORIZATION='Bearer test-token')

    def add(self, **body):
        return self.api.post('/api/agent-sources', body, format='json')

    def test_targets_are_checked(self):
        self.assertEqual(self.add(name='a', kind='ssh', target='-oProxyCommand=touch /tmp/x').status_code, 400)
        self.assertEqual(self.add(name='b', kind='ssh', target='me@box one').status_code, 400)
        self.assertEqual(self.add(name='c', kind='smolvm', target='--name=x').status_code, 400)
        self.assertEqual(self.add(name='d', kind='exec', target='sh').status_code, 400)
        self.assertEqual(self.add(name='e', kind='ssh', target=' ssh://me@box:2222 ').status_code, 201)
        self.assertEqual(self.add(name='f', kind='smolvm', target='dev-vm').status_code, 201)
        self.assertEqual(AgentSource.objects.get(name='e').target, 'ssh://me@box:2222')

    @mock.patch.dict(os.environ, {'MARUMADO_HERDR_SSH': 'main-box'})
    def test_every_source_is_listed_and_one_down_does_not_hide_the_others(self):
        vm = AgentSource.objects.create(name='vm', kind='smolvm', target='vm')
        AgentSource.objects.create(name='off', kind='ssh', target='me@off')
        run, calls = fake_herdr({'main-box': ['w1:p1'], 'vm': ['w1:p1', 'w1:p2'], 'off': None})
        with mock.patch.object(herdr, '_run', run):
            listed = self.api.get('/api/agents').json()
            self.assertTrue(listed['available'])
            self.assertEqual([(s['name'], s['available'], s['agents']) for s in listed['sources']],
                             [('main-box', True, 1), ('off', False, 0), ('vm', True, 2)])
            self.assertIn('Connection refused', listed['sources'][1]['error'])
            self.assertEqual(sorted((a['source'], a['pane_id']) for a in listed['agents']),
                             [(0, 'w1:p1'), (vm.id, 'w1:p1'), (vm.id, 'w1:p2')])
            # The source that failed isn't asked again right away.
            asked = len(calls)
            self.api.get('/api/agents')
            self.assertNotIn('off', [name for name, _ in calls[asked:]])

            # Reading a pane asks the source it is in.
            res = self.api.get(f'/api/agents/w1:p2/output?source={vm.id}')
            self.assertEqual(res.json(), {'output': 'output'})
            self.assertEqual(calls[-1], ('vm', ('agent', 'read', 'w1:p2', '--source', 'recent-unwrapped', '--lines', '80')))
            self.assertEqual(self.api.get('/api/agents/w1:p2/output?source=999').status_code, 400)

    def test_this_machine_is_left_out_when_herdr_is_elsewhere(self):
        AgentSource.objects.create(name='vm', kind='smolvm', target='vm')
        with mock.patch.dict(os.environ, {k: '' for k in ('MARUMADO_HERDR_SMOLVM', 'MARUMADO_HERDR_EXEC', 'MARUMADO_HERDR_SSH',
                                                         'MARUMADO_HERDR_SOCKET', 'MARUMADO_HERDR_BIN')}), \
                mock.patch.object(herdr, '_local_binary', return_value=None):
            self.assertEqual([s.name for s in herdr.sources()], ['vm'])
        with mock.patch.object(herdr, '_local_binary', return_value='/usr/bin/herdr'):
            self.assertEqual([s.name for s in herdr.sources()], ['This machine', 'vm'])

    def test_commands_run_where_the_source_is(self):
        ssh = herdr.Source(3, 'box', 'ssh', 'me@box')
        cmd, _ = herdr._command(ssh, ('pane', 'list'))
        self.assertEqual(cmd[:5], ['ssh', '-o', 'BatchMode=yes', '-o', f'ConnectTimeout={herdr.TIMEOUT - 1}'])
        self.assertEqual(cmd[5], 'me@box')
        self.assertTrue(cmd[6].endswith("pane list"))
        with mock.patch.object(herdr, '_smolvm', return_value=(['smolvm', 'machine', 'exec', '--name', 'vm', '--'], None)) as smolvm:
            cmd, _ = herdr._command(herdr.Source(4, 'vm', 'smolvm', 'vm'), ('pane', 'list'), interactive=True)
        smolvm.assert_called_once_with('vm', True)
        self.assertEqual(cmd[-3:-1], ['sh', '-c'])


class FakeTunnel:
    """A machine in Machines, up, whose Marumado answers `answers` ({path: (status, json)}) and reports `overview`."""

    def __init__(self, id=1, name='server', overview=None, answers=None):
        self.id, self.name, self.state, self.overview = id, name, 'up', overview
        self.answers = answers or {}
        self.calls = []

    def request(self, method, path, query='', body=b'', content_type='', timeout=10):
        import json
        self.calls.append((method, path, query, json.loads(body) if body else None))
        status_code, data = self.answers.get(path, (404, {}))
        res = mock.Mock(status_code=status_code, content=json.dumps(data).encode(), headers={'content-type': 'application/json'})
        res.json = lambda: data
        return res


def with_tunnels(*tunnels):
    from . import machines
    return mock.patch.multiple(machines, tunnels=lambda: list(tunnels), get=lambda i: next((t for t in tunnels if t.id == i), None))


class PlacesTests(TestCase):
    def setUp(self):
        self.blog = Project.objects.create(name='my-blog', path='/projects/my-blog')
        self.shop = Project.objects.create(name='Shop', path='/projects/shop')

    def test_a_folder_elsewhere_is_matched_by_compose_name_then_folder_name(self):
        from . import discovery
        projects = list(Project.objects.all())
        self.assertEqual(discovery.project_by_name('/srv/whatever', 'myblog', projects), self.blog)
        self.assertEqual(discovery.project_by_name('/home/me/apps/shop/backend', '', projects), self.shop)
        self.assertIsNone(discovery.project_by_name('/srv/apps/data', '', projects))
        self.assertEqual(discovery.project_anywhere('/projects/shop/web', projects), self.shop)

    def test_what_runs_here_is_grouped_by_compose_project_or_folder(self):
        from . import overview
        dock = {'containers': [
            {'name': 'blog-web-1', 'compose_project': 'my-blog', 'compose_service': 'web', 'working_dir': '/srv/my-blog',
             'status': 'running', 'health': None, 'ports': [{'host_port': 8080}]},
            {'name': 'blog-db-1', 'compose_project': 'my-blog', 'compose_service': 'db', 'working_dir': '/srv/my-blog',
             'status': 'running', 'health': 'healthy', 'ports': []},
        ]}
        ports = [{'port': 3000, 'cwd': '/home/me/shop'}, {'port': 22, 'cwd': '/'}, {'port': 8081, 'cwd': '/srv/my-blog/api'}]
        got = {g['dir']: g for g in overview.places(dock, ports)}
        self.assertEqual(set(got), {'/srv/my-blog', '/home/me/shop'})
        self.assertEqual(got['/srv/my-blog']['ports'], [8080, 8081])
        self.assertEqual(len(got['/srv/my-blog']['containers']), 2)

    def test_projects_list_where_else_they_run(self):
        from . import places
        tunnel = FakeTunnel(overview={'agents': {'available': False}, 'places': [
            {'compose': 'my-blog', 'dir': '/srv/my-blog', 'ports': [8080],
             'containers': [{'name': 'web', 'service': 'web', 'status': 'running', 'health': None}]},
            {'compose': '', 'dir': '/opt/unknown', 'ports': [9000], 'containers': []},
        ]})
        with with_tunnels(tunnel):
            found = places.by_project(list(Project.objects.all()))
            self.assertEqual(places.folder_on(self.blog, tunnel.id), '/srv/my-blog')
            self.assertEqual(tasks.folder_for(self.blog, herdr.MACHINE_BASE + tunnel.id), '/srv/my-blog')
            self.assertEqual(tasks.folder_for(self.shop, herdr.MACHINE_BASE + tunnel.id), '')
            self.assertEqual(tasks.folder_for(self.shop, 0), '/projects/shop')
        self.assertEqual([(p['machine_name'], p['running']) for p in found[self.blog.id]], [('server', True)])
        self.assertEqual(found[self.shop.id], [])

    @override_settings(MARUMADO_TOKEN='test-token')
    @mock.patch.object(monitor, 'ensure_started', lambda: None)
    def test_another_machines_rows_point_at_projects_here(self):
        from . import machines
        tunnel = FakeTunnel(answers={'docker': (200, {'available': True, 'error': '', 'containers': [
            {'id': 'c1', 'name': 'web', 'compose_project': 'shop', 'working_dir': '/srv/x', 'project': {'id': 999, 'name': 'theirs'}}]})})
        api = APIClient()
        api.credentials(HTTP_AUTHORIZATION='Bearer test-token')
        with mock.patch.object(machines, 'get', lambda i: tunnel if i == 1 else None):
            res = api.get('/api/machines/1/docker')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['containers'][0]['project'], {'id': self.shop.id, 'name': 'Shop'})


class MachineAgentSourceTests(TestCase):
    def remote(self, available=True):
        return FakeTunnel(id=3, name='server', overview={'agents': {'available': available}}, answers={
            'agents': (200, {'available': True, 'error': '', 'sources': [{'id': 0, 'available': True, 'error': ''}],
                             'agents': [{'pane_id': 'w1:p1', 'source': 0, 'name': '', 'kind': 'claude', 'status': 'working',
                                         'title': '', 'cwd': '/srv/my-blog', 'workspace': '', 'focused': False},
                                        {'pane_id': 'w9:p9', 'source': 5, 'name': '', 'kind': 'claude', 'status': 'idle',
                                         'title': '', 'cwd': '/vm', 'workspace': '', 'focused': False}]}),
            'agents/workspace': (201, {'pane_id': 'w2:p1', 'cwd': '/srv/my-blog'}),
            'agents/w2:p1/task': (200, {'started': False, 'blocked': True}),
        })

    def test_a_machine_with_herdr_is_a_source_and_its_own_agents_are_listed(self):
        tunnel = self.remote()
        with with_tunnels(tunnel), mock.patch.object(herdr, '_local_binary', lambda: None):
            herdr.forget_failures()
            listed = herdr.agents()
            own = herdr.agents(include_machines=False)
        source = herdr.MACHINE_BASE + 3
        self.assertEqual([(s['id'], s['kind']) for s in listed['sources']], [(source, 'machine')])
        self.assertEqual([(a['pane_id'], a['source']) for a in listed['agents']], [('w1:p1', source)])
        self.assertEqual(tunnel.calls[0][:3], ('GET', 'agents', 'source=0&machines=0'))
        self.assertNotIn(source, [s['id'] for s in own['sources']])

    def test_a_machine_without_herdr_is_not_a_source(self):
        with with_tunnels(self.remote(available=False)):
            self.assertNotIn('machine', [s.kind for s in herdr.sources()])

    def test_tasks_on_a_machine_go_through_its_marumado(self):
        tunnel = self.remote()
        with with_tunnels(tunnel):
            source = herdr.get_source(herdr.MACHINE_BASE + 3)
            self.assertEqual(herdr.open_workspace('/srv/my-blog', 'blog', source), {'pane_id': 'w2:p1', 'cwd': '/srv/my-blog'})
            with self.assertRaises(herdr.Blocked):
                herdr.prompt_task('w2:p1', 'Do it', source)
            with self.assertRaises(RuntimeError):
                herdr.close('w2:p1', source)  # an older Marumado without the call
        self.assertEqual(tunnel.calls[0], ('POST', 'agents/workspace', 'source=0', {'cwd': '/srv/my-blog', 'label': 'blog'}))


class ProjectFolderTests(TestCase):
    def test_the_default_folder_only_counts_where_it_exists(self):
        from . import discovery
        with override_settings(MARUMADO_PROJECT_ROOTS=['/no/such/folder'], MARUMADO_PROJECT_ROOTS_DEFAULT=True):
            self.assertEqual(discovery.roots(), [])
        with override_settings(MARUMADO_PROJECT_ROOTS=['/no/such/folder'], MARUMADO_PROJECT_ROOTS_DEFAULT=False):
            self.assertEqual([r['path'] for r in discovery.roots()], ['/no/such/folder'])
