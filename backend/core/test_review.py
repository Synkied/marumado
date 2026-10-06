import json
import os
import subprocess
import tempfile
from unittest import mock

from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from . import checks, herdr, land, monitor, plans, tasks, transcripts, usage
from .models import Plan, Project, Task
from .tests import GIT, SyncThread, agents


def claude(t: str, mid: str, model: str, inp: int, write: int, read: int, out: int, side: bool = False, write_1h: int = 0) -> bytes:
    u = {'input_tokens': inp, 'cache_creation_input_tokens': write + write_1h, 'cache_read_input_tokens': read, 'output_tokens': out,
         'cache_creation': {'ephemeral_5m_input_tokens': write, 'ephemeral_1h_input_tokens': write_1h}}
    return json.dumps({'type': 'assistant', 'timestamp': t, 'isSidechain': side,
                       'message': {'id': mid, 'model': model, 'usage': u, 'content': [{'type': 'text', 'text': 'ok'}]}}).encode() + b'\n'


class UsageTests(SimpleTestCase):
    def test_claude_code_calls_are_counted_once_and_priced(self):
        p = transcripts.Parser('claude', '/x')
        # One reply written twice (once per block), the second with its final output count; then a sub-agent's call.
        p.feed(claude('2026-10-06T10:00:00Z', 'm1', 'claude-opus-5-5', 10, 1000, 0, 5))
        p.feed(claude('2026-10-06T10:00:01Z', 'm1', 'claude-opus-5-5', 10, 1000, 0, 200))
        p.feed(claude('2026-10-06T10:00:05Z', 'm2', 'claude-opus-5-5', 20, 0, 1000, 100))
        p.feed(claude('2026-10-06T10:00:06Z', 's1', 'claude-haiku-4-5', 50, 0, 0, 50, side=True))
        u = p.usage()
        self.assertEqual(u['calls'], 3)
        self.assertEqual(u['tokens'], {'input': 80, 'cache_write': 1000, 'cache_write_1h': 0, 'cache_read': 1000, 'output': 350})
        # Opus 5.5: $4 in, $20 out, $0.20 cache read, writes 1.25× in; Haiku 4.5: $1 / $5.
        opus = (30 * 4 + 1000 * 5 + 1000 * 0.2 + 300 * 20) / 1e6
        haiku = (50 * 1 + 50 * 5) / 1e6
        self.assertAlmostEqual(u['cost'], round(opus + haiku, 4))
        self.assertTrue(u['priced'])
        # The context is the main thread's last call, not the sub-agent's.
        self.assertEqual(u['context']['tokens'], 20 + 1000)
        # From a moment on (a task's prompt): only the calls since.
        self.assertEqual(p.usage(since=transcripts._ms('2026-10-06T10:00:04Z'))['calls'], 2)

    def test_unknown_models_are_counted_but_not_priced(self):
        p = transcripts.Parser('claude', '/x')
        p.feed(claude('2026-10-06T10:00:00Z', 'm1', 'some-other-model', 10, 0, 0, 10))
        u = p.usage()
        self.assertEqual((u['total'], u['cost'], u['priced']), (20, 0.0, False))

    def test_codex_running_totals_become_calls(self):
        p = transcripts.Parser('codex', '/x')
        lines = [
            {'type': 'turn_context', 'timestamp': '2026-10-06T10:00:00Z', 'payload': {'model': 'gpt-5-codex'}},
            {'type': 'event_msg', 'timestamp': '2026-10-06T10:00:01Z', 'payload': {'type': 'token_count', 'info': None}},
            {'type': 'event_msg', 'timestamp': '2026-10-06T10:00:02Z', 'payload': {'type': 'token_count', 'info': {
                'total_token_usage': {'input_tokens': 1000, 'cached_input_tokens': 400, 'output_tokens': 50},
                'last_token_usage': {'input_tokens': 1000}, 'model_context_window': 272000}}},
            # The same totals reported again: nothing new.
            {'type': 'event_msg', 'timestamp': '2026-10-06T10:00:03Z', 'payload': {'type': 'token_count', 'info': {
                'total_token_usage': {'input_tokens': 1000, 'cached_input_tokens': 400, 'output_tokens': 50}}}},
            {'type': 'event_msg', 'timestamp': '2026-10-06T10:00:04Z', 'payload': {'type': 'token_count', 'info': {
                'total_token_usage': {'input_tokens': 3000, 'cached_input_tokens': 2000, 'output_tokens': 80},
                'last_token_usage': {'input_tokens': 2000}, 'model_context_window': 272000}}},
        ]
        p.feed(b''.join(json.dumps(r).encode() + b'\n' for r in lines))
        u = p.usage()
        self.assertEqual(u['calls'], 2)
        self.assertEqual(u['tokens'], {'input': 1000, 'cache_write': 0, 'cache_write_1h': 0, 'cache_read': 2000, 'output': 80})
        self.assertEqual(u['models'], ['gpt-5-codex'])
        self.assertFalse(u['priced'], 'Codex tokens are not priced')
        self.assertEqual(u['context'], {'t': transcripts._ms('2026-10-06T10:00:04Z'), 'tokens': 2000, 'window': 272000})

    def test_prices_take_the_longest_prefix(self):
        self.assertEqual(usage.price('claude-opus-5-5'), (4.0, 20.0, 0.20))
        self.assertEqual(usage.price('claude-opus-5'), (5.0, 25.0, 0.50))
        self.assertEqual(usage.price('claude-opus-4-1-20250805'), (15.0, 75.0, 1.50))
        self.assertEqual(usage.price('claude-sonnet-4-5-20250929'), (3.0, 15.0, 0.30))
        self.assertEqual(usage.price('claude-fable-5-1'), (10.0, 50.0, 0.25))
        self.assertIsNone(usage.price('gpt-5'))

    def test_totals_add_up_without_a_context(self):
        a = usage.total([[0, 'claude-haiku-4-5', 10, 0, 0, 0, 10, False]], {'tokens': 5})
        b = usage.total([[0, 'gpt-5', 1, 0, 0, 0, 1, False]])
        both = usage.add(usage.add(None, a), b)
        self.assertEqual((both['calls'], both['total'], both['priced'], both['context']), (2, 22, False, None))


def git(repo, *args):
    return subprocess.run(['git', '-C', repo, *args], check=True, capture_output=True, text=True).stdout.strip()


@override_settings(MARUMADO_TOKEN='test-token')
@mock.patch.object(monitor, 'ensure_started', lambda: None)
@mock.patch.object(tasks.threading, 'Thread', SyncThread)
@mock.patch.object(checks.threading, 'Thread', SyncThread)
@mock.patch.object(tasks.herdr, 'read', lambda pane, lines=80, source=0: f'output of {pane}')
class CheckTests(TestCase):
    """A plan's check runs once a step's agent finishes; the rows under it wait for it to pass."""

    def setUp(self):
        env = mock.patch.dict(os.environ, GIT)
        env.start()
        self.addCleanup(env.stop)
        self.repo = tempfile.mkdtemp()
        subprocess.run(['git', 'init', '-q', self.repo], check=True)
        self.project = Project.objects.create(name='demo', path=self.repo)
        self.api = APIClient()
        self.api.credentials(HTTP_AUTHORIZATION='Bearer test-token')
        self.prompted, self.ran = [], []
        self.results = []  # what the check's runs return, in order
        self.panes = iter(['w2:p1', 'w3:p1'])
        for name, fake in {
            'prompt_task': lambda pane, text, source=0: self.prompted.append((pane, text.split('\n')[0])) or True,
            'open_workspace': lambda cwd, label, source=0: {'pane_id': next(self.panes), 'cwd': cwd},
            'launch_agent': lambda name, kind, pane, source=0: True,
            'execute': lambda source, cwd, script, timeout=60, near='': self.ran.append((cwd, script)) or self.results.pop(0),
        }.items():
            patch = mock.patch.object(tasks.herdr, name, fake)
            patch.start()
            self.addCleanup(patch.stop)

    def tick(self, *rows):
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents(*rows)):
            tasks.watch()
            checks.run_due()
            plans.advance()

    def test_a_failed_check_goes_back_to_the_agent_and_holds_the_next_row(self):
        plan = self.api.post('/api/plans', {'title': 'Ship', 'project': self.project.id, 'kind': 'claude', 'check_command': 'make test'},
                             format='json').json()
        for title in ('Build it', 'Release it'):
            plan = self.api.post(f'/api/plans/{plan["id"]}/add', {'title': title}, format='json').json()
        build, release = (Task.objects.get(title=t) for t in ('Build it', 'Release it'))
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents()):
            self.api.post(f'/api/plans/{plan["id"]}/start')
        self.tick(('w2:p1', 'a', 'claude', 'working', ''))

        # It finishes: the check runs where it worked, fails, and goes back to it with what failed.
        self.results = [(1, 'FAILED test_thing\n1 failed')]
        self.tick(('w2:p1', 'a', 'claude', 'done', ''))
        self.assertEqual(self.ran, [(self.repo, 'export CI=1; make test')])
        build.refresh_from_db()
        self.assertEqual((build.state, build.check_state, build.check_tries), ('working', 'fixing', 1))
        self.assertTrue(self.prompted[-1][1].startswith('The check `make test` failed (exit code 1)'))
        release.refresh_from_db()
        self.assertEqual(release.state, 'queued')

        # Fixed: it passes, and the next row starts on the same agent.
        self.tick(('w2:p1', 'a', 'claude', 'working', ''))
        self.results = [(0, '3 passed')]
        self.tick(('w2:p1', 'a', 'claude', 'done', ''))
        build.refresh_from_db()
        self.assertEqual((build.state, build.check_state), ('review', 'passed'))
        self.assertEqual(self.prompted[-1], ('w2:p1', 'Release it'))
        self.assertEqual([e.text for e in build.events.filter(kind='check')], ['Check failed (exit code 1) after 0 s', 'Check passed (0 s)'])

    def test_out_of_fixes_the_step_fails(self):
        plan = self.api.post('/api/plans', {'title': 'Ship', 'project': self.project.id, 'kind': 'claude', 'check_command': 'make test',
                                            'check_fixes': 0}, format='json').json()
        plan = self.api.post(f'/api/plans/{plan["id"]}/add', {'title': 'Build it'}, format='json').json()
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents()):
            self.api.post(f'/api/plans/{plan["id"]}/start')
        self.tick(('w2:p1', 'a', 'claude', 'working', ''))
        self.results = [(2, 'boom')]
        self.tick(('w2:p1', 'a', 'claude', 'done', ''))
        build = Task.objects.get(title='Build it')
        self.assertEqual((build.state, build.check_state), ('failed', 'failed'))
        self.assertEqual(len(self.prompted), 1, 'nothing sent back')

        # The owner runs it again: it passes.
        self.results = [(0, 'ok')]
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents(('w2:p1', 'a', 'claude', 'idle', ''))):
            self.assertEqual(self.api.post(f'/api/tasks/{build.id}/check').status_code, 200)
            checks.run_due()
        build.refresh_from_db()
        self.assertEqual((build.state, build.check_state), ('review', 'passed'))

    def test_steps_finished_before_the_plan_got_a_check_are_not_held(self):
        plan = self.api.post('/api/plans', {'title': 'Ship', 'project': self.project.id, 'kind': 'claude'}, format='json').json()
        plan = self.api.post(f'/api/plans/{plan["id"]}/add', {'title': 'Build it'}, format='json').json()
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents()):
            self.api.post(f'/api/plans/{plan["id"]}/start')
        self.tick(('w2:p1', 'a', 'claude', 'working', ''))
        self.tick(('w2:p1', 'a', 'claude', 'done', ''))
        self.api.patch(f'/api/plans/{plan["id"]}', {'check_command': 'make test'}, format='json')
        build = Task.objects.get(title='Build it')
        self.assertEqual(build.check_state, 'skipped')
        self.assertTrue(checks.passed(build))
        self.tick(('w2:p1', 'a', 'claude', 'idle', ''))
        self.assertEqual(self.ran, [], 'not checked after the fact')


@override_settings(MARUMADO_TOKEN='test-token')
@mock.patch.object(monitor, 'ensure_started', lambda: None)
class LandTests(TestCase):
    """A step's branch, merged into the project's, or thrown away; commands run for real in temporary repositories."""

    def setUp(self):
        env = mock.patch.dict(os.environ, GIT)
        env.start()
        self.addCleanup(env.stop)
        self.repo = tempfile.mkdtemp()
        git(self.repo, 'init', '-q', '-b', 'main')
        open(f'{self.repo}/a.txt', 'w').write('one\n')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-qm', 'first')
        self.project = Project.objects.create(name='demo', path=self.repo)
        self.api = APIClient()
        self.api.credentials(HTTP_AUTHORIZATION='Bearer test-token')
        for name, fake in {
            # As Herdr lists them: every worktree but the main one, none open as a workspace.
            'worktrees': lambda cwd, source=0: [{'branch': b, 'path': p, 'open_workspace_id': ''} for p, b in self._trees()],
            '_contained': lambda: False,
        }.items():
            patch = mock.patch.object(herdr, name, fake)
            patch.start()
            self.addCleanup(patch.stop)

    def _trees(self):
        out, path = [], None
        for line in git(self.repo, 'worktree', 'list', '--porcelain').splitlines():
            if line.startswith('worktree '):
                path = line[9:]
            elif line.startswith('branch ') and path != self.repo:
                out.append((path, line[7:].removeprefix('refs/heads/')))
        return out

    def step(self, branch='marumado/p1-1-change-a', content='two\n'):
        tree = tempfile.mkdtemp() + '/tree'
        git(self.repo, 'worktree', 'add', '-q', '-b', branch, tree)
        open(f'{tree}/a.txt', 'w').write(content)
        git(tree, 'commit', '-qam', 'change a')
        return Task.objects.create(title='Change a', project=self.project, state=Task.REVIEW, worktree=branch, agent_cwd=tree,
                                   started_at=tasks._now(), git_start=git(self.repo, 'rev-parse', 'HEAD')), tree

    def test_review_shows_the_branch_against_the_project(self):
        task, _ = self.step()
        seen = self.api.get(f'/api/tasks/{task.id}/work').json()
        self.assertEqual((seen['kind'], seen['into'], seen['ahead'], seen['behind']), ('branch', 'main', 1, 0))
        self.assertEqual([c['subject'] for c in seen['commits']], ['change a'])
        self.assertEqual(seen['files'], [{'path': 'a.txt', 'status': 'M', 'original': None, 'add': 1, 'del': 1}])
        d = self.api.get(f'/api/tasks/{task.id}/work', {'path': 'a.txt'}).json()
        self.assertIn('-one\n+two', d['diff'])

    def test_merge_lands_the_branch_and_removes_the_worktree(self):
        task, tree = self.step()
        res = self.api.post(f'/api/tasks/{task.id}/merge', format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(open(f'{self.repo}/a.txt').read(), 'two\n')
        self.assertIn('Merge marumado/p1-1-change-a', git(self.repo, 'log', '-1', '--format=%s'))
        task.refresh_from_db()
        self.assertEqual((task.state, task.landed), ('done', 'merged'))
        self.assertFalse(os.path.exists(tree))
        self.assertEqual(git(self.repo, 'branch', '--list', task.worktree), '')
        self.assertIn('worktree and branch are removed', res.json()['said'])

    def test_uncommitted_work_or_a_conflict_merges_nothing(self):
        task, tree = self.step()
        open(f'{tree}/b.txt', 'w').write('left over\n')
        git(tree, 'add', 'b.txt')
        res = self.api.post(f'/api/tasks/{task.id}/merge', format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('didn’t commit', res.json()['detail'])
        git(tree, 'commit', '-qm', 'b')

        # The project moved on meanwhile, in the same lines.
        open(f'{self.repo}/a.txt', 'w').write('three\n')
        git(self.repo, 'commit', '-qam', 'elsewhere')
        res = self.api.post(f'/api/tasks/{task.id}/merge', format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('conflicts', res.json()['detail'])
        self.assertIn('a.txt', res.json()['detail'])
        self.assertEqual(git(self.repo, 'status', '--porcelain'), '', 'the merge was undone')
        task.refresh_from_db()
        self.assertEqual((task.state, task.landed), ('review', ''))

    def test_discard_throws_the_branch_away_and_the_task_goes_back_to_do(self):
        task, tree = self.step()
        res = self.api.post(f'/api/tasks/{task.id}/discard', format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(os.path.exists(tree))
        self.assertEqual(git(self.repo, 'branch', '--list', 'marumado/*'), '')
        self.assertEqual(open(f'{self.repo}/a.txt').read(), 'one\n')
        task.refresh_from_db()
        self.assertEqual((task.state, task.worktree, task.landed), ('todo', '', ''))
        self.assertTrue(task.events.filter(kind='discarded').exists())

    def test_work_in_the_project_folder_has_nothing_to_merge(self):
        task = Task.objects.create(title='Edit', project=self.project, state=Task.REVIEW, started_at=tasks._now(),
                                   git_start=git(self.repo, 'rev-parse', 'HEAD'))
        open(f'{self.repo}/a.txt', 'w').write('edited\n')
        open(f'{self.repo}/new.txt', 'w').write('new\n')
        seen = self.api.get(f'/api/tasks/{task.id}/work').json()
        self.assertEqual(seen['kind'], 'folder')
        self.assertEqual({f['path']: f['status'] for f in seen['files']}, {'a.txt': 'M', 'new.txt': '?'})
        self.assertEqual(self.api.post(f'/api/tasks/{task.id}/merge', format='json').status_code, 400)
