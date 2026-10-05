import os
import subprocess
import tempfile
from unittest import mock

from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from . import herdr, monitor, plans, tasks, terminal
from .models import AgentSource, Plan, Project, Task

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

    def __init__(self, target, args=(), **_):
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
        res = self.api.post('/api/tasks', {'prompt': 'Add a README\n\nShort one.', 'project': self.project.id}, format='json')
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

    def test_title_is_made_from_the_prompt(self):
        tid = self.create()
        self.assertEqual(Task.objects.get(pk=tid).title, 'Add a README')
        self.assertEqual(self.api.patch(f'/api/tasks/{tid}', {'title': 'Docs'}, format='json').json()['title'], 'Docs')
        res = self.api.patch(f'/api/tasks/{tid}', {'prompt': 'Write the docs. All of them.'}, format='json')
        self.assertEqual(res.json()['title'], 'Docs')  # a title written by hand stays
        self.assertEqual(self.api.patch(f'/api/tasks/{tid}', {'title': ' '}, format='json').json()['title'], 'Write the docs')
        self.assertEqual(self.api.post('/api/tasks', {'prompt': '  ', 'title': ''}, format='json').status_code, 400)
        res = self.api.post('/api/tasks', {'title': 'Only a title'}, format='json')
        self.assertEqual((res.status_code, res.json()['title']), (201, 'Only a title'))
        self.assertEqual(tasks.prompt_text(Task.objects.get(pk=res.json()['id'])), 'Only a title')

    def test_title_from(self):
        self.assertEqual(tasks.title_from('\n## Fix the login redirect\nIt loops.'), 'Fix the login redirect')
        self.assertEqual(tasks.title_from('- Fix the CSS. Then the JS.'), 'Fix the CSS')
        self.assertEqual(tasks.title_from('Look at v1.2 first'), 'Look at v1.2 first')
        long = tasks.title_from('word ' * 40)
        self.assertTrue(len(long) <= tasks.TITLE_LENGTH and long.endswith('word…'), long)
        self.assertEqual(len(tasks.title_from('x' * 300)), tasks.TITLE_LENGTH)

    def test_archiving_done_tasks(self):
        tid, other, open_ = self.create(), self.create(), self.create()
        self.assertEqual(self.api.post(f'/api/tasks/{open_}/archive').status_code, 400)  # not done yet
        self.api.post(f'/api/tasks/{tid}/done')
        task = self.api.post(f'/api/tasks/{tid}/archive').json()
        self.assertTrue(task['archived_at'])
        self.assertEqual(task['events'][-1]['kind'], 'archived')
        ids = lambda q='': [t['id'] for t in self.api.get(f'/api/tasks{q}').json()]
        self.assertNotIn(tid, ids())
        self.assertEqual(ids('?archived=1'), [tid])
        self.assertEqual(self.api.get(f'/api/tasks/{tid}').status_code, 200)  # its page still opens
        self.api.post(f'/api/tasks/{other}/done')
        self.assertEqual(self.api.post('/api/tasks/archive-done').json(), {'archived': 1})
        self.assertEqual(sorted(ids('?archived=1')), sorted([tid, other]))
        self.assertIsNone(self.api.post(f'/api/tasks/{tid}/restore').json()['archived_at'])
        self.api.post(f'/api/tasks/{other}/reopen')  # reopening brings it back too
        self.assertEqual(ids('?archived=1'), [])
        self.assertEqual(Task.objects.get(pk=other).state, 'todo')

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


@override_settings(MARUMADO_TOKEN='test-token')
@mock.patch.object(monitor, 'ensure_started', lambda: None)
@mock.patch.object(tasks.threading, 'Thread', SyncThread)
@mock.patch.object(tasks.herdr, 'read', lambda pane, lines=80, source=0: f'output of {pane}')
class PlanTests(TestCase):
    """A plan's steps start by themselves: row after row, a row's steps at once, a step under another on its agent."""

    def setUp(self):
        env = mock.patch.dict(os.environ, GIT)
        env.start()
        self.addCleanup(env.stop)
        self.repo = tempfile.mkdtemp()
        subprocess.run(['git', 'init', '-q', self.repo], check=True)
        self.project = Project.objects.create(name='demo', path=self.repo)
        self.api = APIClient()
        self.api.credentials(HTTP_AUTHORIZATION='Bearer test-token')
        self.prompted = []
        self.opened = []
        self.panes = iter(['w2:p1', 'w3:p1', 'w4:p1', 'w5:p1'])
        for name, fake in {
            'prompt_task': lambda pane, text, source=0: self.prompted.append((pane, text.split('\n')[0])) or True,
            'open_workspace': lambda cwd, label, source=0: self.opened.append(('workspace', cwd)) or {'pane_id': next(self.panes), 'cwd': cwd},
            'open_worktree': lambda cwd, branch, label, source=0: self.opened.append(('worktree', branch)) or {'pane_id': next(self.panes), 'cwd': f'{cwd}-{branch}'},
            'launch_agent': lambda name, kind, pane, source=0: True,
        }.items():
            patch = mock.patch.object(tasks.herdr, name, fake)
            patch.start()
            self.addCleanup(patch.stop)

    def plan(self, *rows):
        plan = self.api.post('/api/plans', {'title': 'Ship it', 'project': self.project.id, 'kind': 'claude'}, format='json').json()
        ids = {}
        for r, row in enumerate(rows):
            for title in row:
                plan = self.api.post(f'/api/plans/{plan["id"]}/add', {'title': title, 'row': r}, format='json').json()
                ids[title] = plan['steps'][-1]['id'] if plan['steps'][-1]['title'] == title else next(t['id'] for t in plan['steps'] if t['title'] == title)
        return plan['id'], ids

    def step(self, ids, title):
        return Task.objects.get(pk=ids[title])

    def tick(self, *rows):
        """One pass of the monitor: follow the tasks, then advance the plans."""
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents(*rows)):
            tasks.watch()
            plans.advance()

    def test_rows_run_in_order_side_by_side_steps_at_once(self):
        pid, ids = self.plan(['Plan the API'], ['Build the API', 'Write the docs'], ['Release'])
        self.assertEqual([t['plan_row'] for t in self.api.get(f'/api/plans/{pid}').json()['steps']], [0, 1, 1, 2])
        self.tick()
        self.assertEqual(self.prompted, [], 'nothing runs before the plan starts')

        with mock.patch.object(tasks.herdr, 'agents', return_value=agents()):
            self.assertEqual(self.api.post(f'/api/plans/{pid}/start').status_code, 200)
        self.assertEqual(self.prompted, [('w2:p1', 'Plan the API')])
        self.assertEqual(self.opened, [('workspace', self.repo)])
        self.assertEqual({self.step(ids, t).state for t in ('Build the API', 'Write the docs', 'Release')}, {'queued'})

        # At work, or waiting on you: the next row waits.
        self.tick(('w2:p1', 'a', 'claude', 'working', ''))
        self.tick(('w2:p1', 'a', 'claude', 'blocked', ''))
        self.assertEqual(len(self.prompted), 1)
        # Finished: the step under it continues on its agent; the one beside it gets a new agent in a worktree.
        self.tick(('w2:p1', 'a', 'claude', 'done', ''))
        self.assertEqual(self.step(ids, 'Plan the API').state, 'review')
        self.assertFalse(self.step(ids, 'Plan the API').live, 'its agent moved on to the next step')
        self.assertEqual(self.prompted[1:], [('w2:p1', 'Build the API'), ('w3:p1', 'Write the docs')])
        docs = self.step(ids, 'Write the docs')
        self.assertTrue(docs.worktree.startswith(f'marumado/p{pid}-{docs.id}-write-the-docs'))
        self.assertEqual(self.opened[-1], ('worktree', docs.worktree))

        # Release waits for both, then continues on the first one's agent.
        self.tick(('w2:p1', 'a', 'claude', 'done', ''), ('w3:p1', 'b', 'claude', 'working', ''))
        self.tick(('w2:p1', 'a', 'claude', 'working', ''), ('w3:p1', 'b', 'claude', 'working', ''))
        self.tick(('w2:p1', 'a', 'claude', 'done', ''), ('w3:p1', 'b', 'claude', 'working', ''))
        self.assertEqual(self.step(ids, 'Release').state, 'queued')
        self.tick(('w2:p1', 'a', 'claude', 'done', ''), ('w3:p1', 'b', 'claude', 'done', ''))
        self.assertEqual(self.prompted[-1], ('w2:p1', 'Release'))

    def test_a_failed_step_holds_back_the_rows_under_it(self):
        pid, ids = self.plan(['One', 'Two'], ['Three'])
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents()):
            self.api.post(f'/api/plans/{pid}/start')
        # Two's agent is closed while it works: Two fails, Three never starts.
        self.tick(('w2:p1', 'a', 'claude', 'working', ''), ('w3:p1', 'b', 'claude', 'working', ''))
        self.tick(('w2:p1', 'a', 'claude', 'done', ''))
        self.assertEqual((self.step(ids, 'One').state, self.step(ids, 'Two').state), ('review', 'failed'))
        self.tick(('w2:p1', 'a', 'claude', 'idle', ''))
        self.assertEqual(self.step(ids, 'Three').state, 'queued')

    def test_paused_plans_start_nothing_and_agents_list_what_waits_for_them(self):
        pid, ids = self.plan(['One'], ['Two'], ['Three'])
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents()):
            self.api.post(f'/api/plans/{pid}/start')
        self.api.post(f'/api/plans/{pid}/pause')
        self.tick(('w2:p1', 'a', 'claude', 'done', ''))
        self.assertEqual(self.step(ids, 'Two').state, 'queued')
        with mock.patch.object(herdr, 'agents', return_value=agents(('w2:p1', 'a', 'claude', 'idle', ''))):
            listed = self.api.get('/api/agents').json()
        self.assertEqual([q['title'] for q in listed['agents'][0]['queued']], ['Two', 'Three'])

    def test_a_step_that_asks_waits_for_the_go(self):
        pid, ids = self.plan(['One'], ['Two'], ['Three'])
        two = ids['Two']
        self.assertEqual(self.api.patch(f'/api/tasks/{two}', {'ask': True}, format='json').status_code, 200)
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents()):
            self.api.post(f'/api/plans/{pid}/start')
        self.assertEqual(self.api.get(f'/api/plans/{pid}').json()['asking'], [], 'not its turn yet')
        self.tick(('w2:p1', 'a', 'claude', 'done', ''))
        self.tick(('w2:p1', 'a', 'claude', 'idle', ''))
        self.assertEqual((self.step(ids, 'One').state, self.step(ids, 'Two').state), ('review', 'queued'))
        self.assertEqual(self.api.get(f'/api/plans/{pid}').json()['asking'], [two])
        with mock.patch.object(herdr, 'agents', return_value=agents(('w2:p1', 'a', 'claude', 'idle', ''))):
            self.assertEqual([(q['title'], q['asking']) for q in self.api.get('/api/agents').json()['agents'][0]['queued']],
                             [('Two', True), ('Three', False)])
            self.assertEqual(self.api.post(f'/api/tasks/{two}/go').status_code, 200)
            self.assertEqual(self.prompted[-1], ('w2:p1', 'Two'))
            self.assertEqual(self.api.post(f'/api/tasks/{ids["Three"]}/go').status_code, 200, 'a go given ahead of time')
            self.assertEqual(self.api.post(f'/api/tasks/{ids["One"]}/go').status_code, 400)

    def test_steps_queued_on_an_agent_run_one_after_the_other_on_it(self):
        busy = agents(('w9:p1', 'mine', 'claude', 'working', ''))
        with mock.patch.object(herdr, 'agents', return_value=busy):
            first = self.api.post('/api/agents/w9:p1/queue', {'title': 'Then the docs', 'source': 0}, format='json')
            second = self.api.post('/api/agents/w9:p1/queue', {'title': 'Then release', 'ask': True, 'source': 0}, format='json')
            self.assertEqual(self.api.post('/api/agents/w9:p2/queue', {'title': 'x', 'source': 0}, format='json').status_code, 404)
        self.assertEqual((first.status_code, second.status_code), (201, 201), first.content)
        plan = Plan.objects.get()
        self.assertEqual((plan.title, plan.running, plan.pane_id), ('Next for mine', True, 'w9:p1'))
        self.assertEqual([[t.title for t in row] for row in plans.rows(plan)], [['Then the docs'], ['Then release']])
        self.assertEqual(self.prompted, [], 'it is at work')
        self.tick(('w9:p1', 'mine', 'claude', 'done', ''))
        self.assertEqual(self.prompted, [('w9:p1', 'Then the docs')])
        self.tick(('w9:p1', 'mine', 'claude', 'working', ''))
        self.tick(('w9:p1', 'mine', 'claude', 'done', ''))
        self.tick(('w9:p1', 'mine', 'claude', 'done', ''))
        self.assertEqual(len(self.prompted), 1, 'the second asks first')
        with mock.patch.object(herdr, 'agents', return_value=agents(('w9:p1', 'mine', 'claude', 'done', ''))):
            self.api.post(f'/api/tasks/{second.json()["id"]}/go')
        self.assertEqual(self.prompted[-1], ('w9:p1', 'Then release'))

    def test_steps_are_written_as_prompts(self):
        plan = self.api.post('/api/plans', {'title': 'Ship it', 'project': self.project.id, 'kind': 'claude'}, format='json').json()
        long = 'Rewrite the settings page so every field saves on its own. ' + 'Keep the layout. ' * 20
        plan = self.api.post(f'/api/plans/{plan["id"]}/add', {'prompt': long}, format='json').json()
        step = Task.objects.get(pk=plan['steps'][0]['id'])
        self.assertEqual((step.title, tasks.prompt_text(step)), ('Rewrite the settings page so every field saves on its own', long.strip()))

    def test_archiving_a_finished_plan_takes_its_steps(self):
        pid, ids = self.plan(['One'], ['Two'])
        self.assertEqual(self.api.post(f'/api/plans/{pid}/archive').status_code, 400)  # not finished
        self.api.post(f'/api/tasks/{ids["One"]}/done')
        self.api.post(f'/api/tasks/{ids["Two"]}/review')
        plan = self.api.post(f'/api/plans/{pid}/archive').json()
        self.assertTrue(plan['archived_at'])
        self.assertEqual([p['id'] for p in self.api.get('/api/plans').json()], [])
        self.assertEqual([p['id'] for p in self.api.get('/api/plans?archived=1').json()], [pid])
        listed = [t['id'] for t in self.api.get('/api/tasks').json()]
        self.assertNotIn(ids['One'], listed)
        self.assertNotIn(ids['Two'], listed)
        self.assertIsNone(self.api.post(f'/api/plans/{pid}/restore').json()['archived_at'])
        listed = [t['id'] for t in self.api.get('/api/tasks').json()]
        self.assertIn(ids['One'], listed)
        self.assertEqual(self.step(ids, 'Two').state, 'review')

    def test_arranging_and_deleting_give_steps_back_to_the_ideas(self):
        pid, ids = self.plan(['One'], ['Two'])
        idea = self.api.post('/api/tasks', {'title': 'Idea', 'project': self.project.id}, format='json').json()['id']
        res = self.api.post(f'/api/plans/{pid}/arrange', {'rows': [[ids['Two'], idea], [ids['One']]]}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual([(t['title'], t['plan_row'], t['plan_col']) for t in res.json()['steps']], [('Two', 0, 0), ('Idea', 0, 1), ('One', 1, 0)])
        res = self.api.post(f'/api/plans/{pid}/arrange', {'rows': [[ids['One']]]}, format='json')
        self.assertEqual([t['title'] for t in res.json()['steps']], ['One'])
        self.assertIsNone(Task.objects.get(pk=idea).plan)
        self.assertEqual(self.api.post(f'/api/plans/{pid}/arrange', {'rows': [[ids['One'], ids['One']]]}, format='json').status_code, 400)
        self.api.delete(f'/api/plans/{pid}')
        self.assertFalse(Plan.objects.exists())
        self.assertEqual((self.step(ids, 'One').plan, self.step(ids, 'One').state), (None, 'todo'))


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


class SeenTests(SimpleTestCase):
    """Herdr keeps a finished turn `done` until it's focused there; looking at it in Marumado counts too."""

    def listing(self, panes):
        def run(src, *args, text=False, timeout=0):
            if args[:2] == ('pane', 'list'):
                return {'panes': panes}
            return {'workspaces': []}
        with mock.patch.object(herdr, '_run', run):
            return [a['status'] for a in herdr._list(self.src)['agents']]

    def setUp(self):
        self.src = herdr.Source(77, 'seen', 'smolvm', 'seen')
        herdr.forget_failures()

    def test_a_turn_watched_in_marumado_reads_as_idle(self):
        done = {'pane_id': 'w1:p1', 'terminal_id': 't1', 'agent': 'claude', 'agent_status': 'done', 'completion_seq': 5}
        self.assertEqual(self.listing([done]), ['done'])
        herdr.watch(77, 'w1:p1')
        self.assertEqual(self.listing([done]), ['idle'])
        herdr.unwatch(77, 'w1:p1')
        self.assertEqual(self.listing([done]), ['idle'])
        # A turn finished after the terminal closed is new; so is another terminal in the same pane.
        self.assertEqual(self.listing([{**done, 'completion_seq': 6}]), ['done'])
        self.assertEqual(self.listing([{**done, 'terminal_id': 't2'}]), ['done'])

    def test_a_turn_finished_just_before_closing_is_seen(self):
        herdr.watch(77, 'w1:p2')
        herdr.unwatch(77, 'w1:p2')
        done = {'pane_id': 'w1:p2', 'terminal_id': 't1', 'agent': 'claude', 'agent_status': 'done', 'completion_seq': 9}
        self.assertEqual(self.listing([done]), ['idle'])
        self.assertEqual(self.listing([{**done, 'completion_seq': 10}]), ['done'])


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


@override_settings(MARUMADO_TOKEN='test-token')
@mock.patch.object(monitor, 'ensure_started', lambda: None)
@mock.patch.object(herdr.threading, 'Thread', SyncThread)
class StartAgentTests(TestCase):
    def setUp(self):
        self.api = APIClient()
        self.api.credentials(HTTP_AUTHORIZATION='Bearer test-token')
        self.project = Project.objects.create(name='My Blog', path='/projects/my-blog')

    def test_starts_in_the_project_folder_under_a_free_name(self):
        listed = {'available': True, 'error': '', 'agents': [{'name': 'my-blog'}]}
        with mock.patch.object(herdr, '_list', return_value=listed), \
                mock.patch.object(herdr, 'open_workspace', return_value={'pane_id': 'w4:p1', 'cwd': '/projects/my-blog'}) as opened, \
                mock.patch.object(herdr, 'launch_agent', return_value=True) as launched:
            res = self.api.post('/api/agents/start', {'project': self.project.id, 'kind': 'claude', 'source': 0}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json(), {'pane_id': 'w4:p1', 'cwd': '/projects/my-blog', 'name': 'my-blog-2', 'source': 0})
        self.assertEqual(opened.call_args.args[:2], ('/projects/my-blog', 'My Blog'))
        self.assertEqual(launched.call_args.args[:3], ('my-blog-2', 'claude', 'w4:p1'))

    def test_refuses_a_folder_herdr_cannot_see(self):
        # Herdr opens a folder it doesn't have in its home folder: close that and say why, rather than start there.
        with mock.patch.object(herdr, '_list', return_value={'agents': []}), \
                mock.patch.object(herdr, 'open_workspace', return_value={'pane_id': 'w4:p1', 'cwd': '/root'}), \
                mock.patch.object(herdr, 'close') as closed, \
                mock.patch.object(herdr, 'launch_agent') as launched:
            res = self.api.post('/api/agents/start', {'project': self.project.id, 'kind': 'claude', 'source': 0}, format='json')
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("/projects/my-blog isn't there", res.json()['detail'])
        self.assertEqual(closed.call_args.args[0], 'w4:p1')
        launched.assert_not_called()

    def test_a_source_sees_folders_where_it_says(self):
        res = self.api.patch('/api/agents/env-source', {'folders': [{'here': '/home/me/projects/', 'there': '/projects'},
                                                                    {'here': '/home/me/projects/blog', 'there': '/srv/blog'}]}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()['folders'][0], {'here': '/home/me/projects', 'there': '/projects'})
        self.assertEqual(herdr.folder_in('/home/me/projects/shop/api'), '/projects/shop/api')
        self.assertEqual(herdr.folder_in('/home/me/projects/blog'), '/srv/blog')  # the closest folder wins
        self.assertEqual(herdr.folder_in('/home/me/projectsX'), '/home/me/projectsX')
        self.assertEqual(herdr.folder_here('/projects/shop'), '/home/me/projects/shop')
        self.project.path = '/home/me/projects/my-blog'
        self.assertEqual(tasks.folder_for(self.project, 0), '/projects/my-blog')
        res = self.api.patch('/api/agents/env-source', {'folders': [{'here': 'projects', 'there': '/projects'}]}, format='json')
        self.assertEqual(res.status_code, 400)

    def test_an_added_source_keeps_its_own_folders(self):
        res = self.api.post('/api/agent-sources', {'name': 'vm', 'kind': 'smolvm', 'target': 'vm',
                                                   'folders': [{'here': '/home/me/dev', 'there': '/dev-share'}]}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(herdr.folder_in('/home/me/dev/x', res.json()['id']), '/dev-share/x')
        self.assertEqual(herdr.folder_in('/home/me/dev/x'), '/home/me/dev/x')

    def test_pane_ids_past_the_ninth_workspace(self):
        # Herdr counts workspaces w1…w9, then wA, wB…
        with mock.patch.object(herdr, '_run') as ran:
            herdr.close('wJ:p1')
        self.assertEqual(ran.call_args.args[1:], ('pane', 'close', 'wJ:p1'))
        with self.assertRaises(ValueError):
            herdr.close('wJ:p1; rm -rf /')

    def test_refuses_an_unknown_kind_or_project(self):
        res = self.api.post('/api/agents/start', {'project': self.project.id, 'kind': 'rm -rf'}, format='json')
        self.assertEqual(res.status_code, 400)
        res = self.api.post('/api/agents/start', {'project': 999, 'kind': 'claude'}, format='json')
        self.assertEqual(res.status_code, 400)

    def test_names_are_valid_agent_names(self):
        with mock.patch.object(herdr, '_list', return_value={'agents': []}):
            for base in ('My Blog!', '2048 game', '', 'Ünïcode'):
                self.assertRegex(herdr.free_name(base), herdr.AGENT_NAME)


@override_settings(MARUMADO_TOKEN='test-token')
@mock.patch.object(monitor, 'ensure_started', lambda: None)
class WorkspaceTests(TestCase):
    """Herdr's workspaces, made, picked and closed from the web."""

    def setUp(self):
        herdr.forget_failures()
        self.addCleanup(herdr.forget_failures)
        self.api = APIClient()
        self.api.credentials(HTTP_AUTHORIZATION='Bearer test-token')
        self.project = Project.objects.create(name='My Blog', path='/projects/my-blog')
        self.calls = []

    def run_herdr(self, src, *args, text=False, timeout=0):
        self.calls.append(args)
        if args[:2] == ('pane', 'list'):
            return {'panes': [{'pane_id': 'w1:p1', 'workspace_id': 'w1', 'agent': 'claude', 'agent_status': 'idle'},
                              {'pane_id': 'w2:p1', 'workspace_id': 'w2'}]}
        if args[:2] == ('workspace', 'list'):
            return {'workspaces': [
                {'workspace_id': 'w1', 'label': 'blog', 'worktree': {'repo_key': '/b/.git', 'checkout_path': '/b', 'is_linked_worktree': False}},
                {'workspace_id': 'w2', 'label': 'blog · fix', 'worktree': {'repo_key': '/b/.git', 'checkout_path': '/wt/fix', 'is_linked_worktree': True}},
                {'workspace_id': 'w3', 'label': 'notes'}]}
        if args[:2] == ('workspace', 'create'):
            cwd = args[args.index('--cwd') + 1] if '--cwd' in args else '/root'
            return {'root_pane': {'pane_id': 'w4:p1', 'workspace_id': 'w4', 'cwd': cwd}}
        if args[:2] == ('tab', 'create'):
            return {'root_pane': {'pane_id': 'w1:p2', 'workspace_id': 'w1', 'cwd': args[args.index('--cwd') + 1] if '--cwd' in args else '/b'}}
        if args[:2] == ('workspace', 'close') and '--group' not in args and args[2] == 'w1':
            raise RuntimeError('workspace has linked worktree workspaces; use --group (close_group=true in the API) to close the group')
        return '' if text else {}

    def test_workspaces_are_listed_with_their_worktrees(self):
        with mock.patch.object(herdr, '_run', self.run_herdr):
            listed = self.api.get('/api/agents').json()
        spaces = listed['sources'][0]['workspaces']
        self.assertEqual([(w['id'], w['label'], w['worktree_of'], w['linked']) for w in spaces],
                         [('w1', 'blog', '', 1), ('w2', 'blog · fix', 'w1', 0), ('w3', 'notes', '', 0)])
        self.assertEqual({a['pane_id']: a['workspace_id'] for a in listed['agents']}, {'w1:p1': 'w1', 'w2:p1': 'w2'})

    def test_a_workspace_opens_in_the_project_folder(self):
        with mock.patch.object(herdr, '_run', self.run_herdr):
            res = self.api.post('/api/agents/workspaces', {'source': 0, 'project': self.project.id}, format='json')
            self.assertEqual(res.status_code, 201, res.content)
            self.assertEqual(res.json(), {'workspace_id': 'w4', 'pane_id': 'w4:p1', 'cwd': '/projects/my-blog', 'source': 0})
            self.assertEqual(self.calls[-1], ('workspace', 'create', '--cwd', '/projects/my-blog', '--label', 'My Blog', '--no-focus'))
            res = self.api.post('/api/agents/workspaces', {'source': 0, 'label': ' Scratch '}, format='json')
            self.assertEqual(self.calls[-1], ('workspace', 'create', '--label', 'Scratch', '--no-focus'))

    def test_a_folder_herdr_cannot_see_closes_the_workspace(self):
        def elsewhere(src, *args, **kw):
            if args[:2] == ('workspace', 'create'):
                return {'root_pane': {'pane_id': 'w4:p1', 'workspace_id': 'w4', 'cwd': '/root'}}
            return self.run_herdr(src, *args, **kw)
        with mock.patch.object(herdr, '_run', elsewhere):
            res = self.api.post('/api/agents/workspaces', {'source': 0, 'project': self.project.id}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self.calls[-1], ('workspace', 'close', 'w4'))

    def test_terminals_and_agents_open_in_the_chosen_workspace(self):
        with mock.patch.object(herdr, '_run', self.run_herdr):
            res = self.api.post('/api/agents/terminal', {'source': 0, 'workspace': 'w3'}, format='json')
            self.assertEqual(res.status_code, 201, res.content)
            self.assertEqual(self.calls[-1], ('tab', 'create', '--workspace', 'w3', '--no-focus'))
            with mock.patch.object(herdr, 'launch_agent', return_value=True):
                res = self.api.post('/api/agents/start', {'project': self.project.id, 'kind': 'claude', 'source': 0, 'workspace': 'w1'}, format='json')
            self.assertEqual(res.status_code, 201, res.content)
            self.assertIn(('tab', 'create', '--workspace', 'w1', '--cwd', '/projects/my-blog', '--label', 'My Blog', '--no-focus'), self.calls)
            res = self.api.post('/api/agents/terminal', {'source': 0, 'workspace': 'w1; rm'}, format='json')
            self.assertEqual(res.status_code, 400)

    def test_closing_a_workspace_with_worktrees_asks_for_the_group(self):
        with mock.patch.object(herdr, '_run', self.run_herdr):
            res = self.api.post('/api/agents/workspaces/w1/close', {'source': 0}, format='json')
            self.assertEqual(res.status_code, 409, res.content)
            self.assertTrue(res.json()['group'])
            res = self.api.post('/api/agents/workspaces/w1/close', {'source': 0, 'group': True}, format='json')
            self.assertEqual(res.status_code, 204, res.content)
            self.assertEqual(self.calls[-1], ('workspace', 'close', 'w1', '--group'))
            self.assertEqual(self.api.post('/api/agents/workspaces/w1:p1/close', {'source': 0}, format='json').status_code, 400)


class TerminalCommandTests(TestCase):
    def test_scroll_and_clicks_reach_the_cell_under_the_pointer(self):
        scroll = terminal._command({'type': 'terminal.scroll', 'direction': 'down', 'lines': 3, 'column': 130, 'row': 20}, fit=False)
        self.assertEqual(scroll, {'type': 'terminal.scroll', 'direction': 'down', 'lines': 3, 'column': 130, 'row': 20})
        # Without a position Herdr picks its own, as before.
        self.assertNotIn('column', terminal._command({'type': 'terminal.scroll', 'direction': 'up'}, fit=False))
        click = terminal._command({'type': 'terminal.mouse', 'action': 'down', 'button': 'left', 'column': '9', 'row': -4}, fit=False)
        self.assertEqual(click, {'type': 'terminal.mouse', 'action': 'down', 'button': 'left', 'column': 9, 'row': 0})
        self.assertIsNone(terminal._command({'type': 'terminal.mouse', 'action': 'move', 'button': 'left'}, fit=False))
        self.assertIsNone(terminal._command({'type': 'terminal.mouse', 'action': 'down', 'button': 'wheel'}, fit=False))
