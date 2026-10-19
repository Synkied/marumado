from unittest import mock

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from . import herdr, modelapis, monitor, tasks
from .models import ModelApi, Project, Task
from .tests import FakeTunnel, SyncThread, agents, with_tunnels


class PointingTests(TestCase):
    """What a new agent is given to use a model API: its token in the shell's environment, never on screen."""

    def test_claude_gets_the_server_root_and_the_model_for_everything(self):
        api = ModelApi(name='Ollama', base_url='http://localhost:11434/v1', model='qwen3-coder:30b')
        env = modelapis.env_for('claude', api)
        self.assertEqual(env['ANTHROPIC_BASE_URL'], 'http://localhost:11434')
        self.assertEqual(env['ANTHROPIC_AUTH_TOKEN'], 'marumado')  # a local server takes any
        self.assertEqual(env['ANTHROPIC_API_KEY'], '')
        self.assertEqual(env['ANTHROPIC_DEFAULT_HAIKU_MODEL'], 'qwen3-coder:30b')
        self.assertEqual(env[modelapis.MARKER], 'Ollama')
        self.assertEqual(modelapis.args_for('claude', api), [])

    def test_codex_gets_a_provider_whose_token_stays_in_the_environment(self):
        api = ModelApi(name='OpenAI "work"', base_url='https://api.openai.com', token='sk-secret', model='gpt-5')
        self.assertEqual(modelapis.env_for('codex', api), {modelapis.MARKER: 'OpenAI "work"', modelapis.CODEX_TOKEN: 'sk-secret'})
        args = modelapis.args_for('codex', api)
        self.assertNotIn('sk-secret', ' '.join(args))
        self.assertEqual(args[:2], ['-c', 'model_provider="marumado"'])
        self.assertEqual(args[3], 'model_providers.marumado={name = "OpenAI \\"work\\"", base_url = "https://api.openai.com/v1", '
                                  'wire_api = "responses", env_key = "MARUMADO_API_TOKEN"}')
        self.assertEqual(args[4:], ['-m', 'gpt-5'])

    def test_only_claude_and_codex_can_use_one(self):
        with self.assertRaises(ValueError):
            modelapis.env_for('gemini', ModelApi(name='x', base_url='http://x'))
        self.assertEqual(modelapis.env_for('gemini', None), {})

    def test_the_shell_gets_the_environment_through_herdr(self):
        with mock.patch.object(herdr, '_run', return_value={'root_pane': {'pane_id': 'w2:p1', 'cwd': '/x'}}) as ran:
            herdr.open_workspace('/x', 'x', 0, {'A': '1', 'B': ''})
        self.assertEqual(ran.call_args.args[1:], ('workspace', 'create', '--cwd', '/x', '--label', 'x', '--env', 'A=1', '--env', 'B=', '--no-focus'))

    def test_a_worktree_with_an_environment_opens_a_tab_that_has_it(self):
        answers = iter([
            {'workspace': {'workspace_id': 'w3'}, 'worktree': {'path': '/x-b'}},
            {'panes': [{'pane_id': 'w3:p1', 'workspace_id': 'w3', 'cwd': '/x-b'}]},
            {'root_pane': {'pane_id': 'w3:p2', 'cwd': '/x-b'}},
            None,
        ])
        with mock.patch.object(herdr, '_run', side_effect=lambda *a, **k: next(answers)) as ran:
            self.assertEqual(herdr.open_worktree('/x', 'b', 'x', 0, {'A': '1'}), {'pane_id': 'w3:p2', 'cwd': '/x-b'})
        calls = [c.args[1:] for c in ran.call_args_list]
        self.assertEqual(calls[2], ('tab', 'create', '--workspace', 'w3', '--cwd', '/x-b', '--env', 'A=1', '--no-focus'))
        self.assertEqual(calls[3], ('pane', 'close', 'w3:p1'))

    def test_agent_arguments_go_after_its_command(self):
        with mock.patch.object(herdr, '_run') as ran:
            herdr.launch_agent('a', 'codex', 'w2:p1', 0, ['-m', 'gpt-5'])
        self.assertEqual(ran.call_args.args[-3:], ('--', '-m', 'gpt-5'))

    def test_another_machine_is_sent_the_environment_and_an_old_one_refused(self):
        new = FakeTunnel(id=3, answers={'agents/workspace': (201, {'pane_id': 'w2:p1', 'cwd': '/srv', 'env': True})})
        with with_tunnels(new):
            source = herdr.get_source(herdr.MACHINE_BASE + 3)
            herdr.open_workspace('/srv', 'x', source, {'A': '1'})
        self.assertEqual(new.calls[0][3], {'cwd': '/srv', 'label': 'x', 'env': {'A': '1'}})
        old = FakeTunnel(id=3, answers={'agents/workspace': (201, {'pane_id': 'w2:p1', 'cwd': '/srv'}), 'agents/w2:p1/close': (204, None)})
        with with_tunnels(old):
            source = herdr.get_source(herdr.MACHINE_BASE + 3)
            with self.assertRaisesRegex(RuntimeError, 'too old for model APIs'):
                herdr.open_workspace('/srv', 'x', source, {'A': '1'})
        self.assertEqual(old.calls[-1][:2], ('POST', 'agents/w2:p1/close'))  # not left open without it


@override_settings(MARUMADO_TOKEN='test-token')
@mock.patch.object(monitor, 'ensure_started', lambda: None)
@mock.patch.object(herdr.threading, 'Thread', SyncThread)
@mock.patch.object(tasks.threading, 'Thread', SyncThread)
class ModelApiViewTests(TestCase):
    def setUp(self):
        self.api = APIClient()
        self.api.credentials(HTTP_AUTHORIZATION='Bearer test-token')
        self.project = Project.objects.create(name='blog', path='/projects/blog')

    def add(self, **fields):
        res = self.api.post('/api/model-apis', {'name': 'Ollama', 'base_url': 'http://localhost:11434/', 'model': 'qwen3-coder', **fields}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.json()

    def test_the_token_is_kept_but_never_sent_back(self):
        made = self.add(token='sk-secret')
        self.assertEqual((made['base_url'], made['has_token']), ('http://localhost:11434', True))
        self.assertNotIn('token', made)
        res = self.api.patch(f"/api/model-apis/{made['id']}", {'model': 'llama3'}, format='json')
        self.assertEqual(ModelApi.objects.get().token, 'sk-secret')  # left out: kept
        res = self.api.patch(f"/api/model-apis/{made['id']}", {'token': ''}, format='json')
        self.assertFalse(res.json()['has_token'])
        with mock.patch.object(herdr, 'agents', return_value=agents()):
            listed = self.api.get('/api/agents').json()
        self.assertEqual(listed['apis'], [{'id': made['id'], 'name': 'Ollama', 'model': 'llama3'}])
        self.assertEqual(listed['api_kinds'], ['claude', 'codex'])

    def test_refuses_what_isnt_an_address_or_a_model_name(self):
        res = self.api.post('/api/model-apis', {'name': 'x', 'base_url': 'localhost:11434'}, format='json')
        self.assertEqual(res.status_code, 400)
        res = self.api.post('/api/model-apis', {'name': 'x', 'base_url': 'http://x', 'model': 'a model; rm'}, format='json')
        self.assertEqual(res.status_code, 400)
        res = self.api.post('/api/model-apis', {'name': 'x', 'base_url': 'http://x', 'token': 'two words'}, format='json')
        self.assertEqual(res.status_code, 400)

    def test_an_agent_started_on_one_gets_its_environment(self):
        made = self.add(token='sk-secret')
        with mock.patch.object(herdr, '_list', return_value={'agents': []}), \
                mock.patch.object(herdr, 'open_workspace', return_value={'pane_id': 'w4:p1', 'cwd': '/projects/blog'}) as opened, \
                mock.patch.object(herdr, 'launch_agent', return_value=True) as launched:
            res = self.api.post('/api/agents/start', {'project': self.project.id, 'kind': 'codex', 'source': 0, 'api': made['id']}, format='json')
            refused = self.api.post('/api/agents/start', {'project': self.project.id, 'kind': 'gemini', 'source': 0, 'api': made['id']}, format='json')
            gone = self.api.post('/api/agents/start', {'project': self.project.id, 'kind': 'codex', 'source': 0, 'api': 999}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(opened.call_args.args[3][modelapis.CODEX_TOKEN], 'sk-secret')
        self.assertIn('-m', launched.call_args.args[4])
        self.assertEqual((refused.status_code, gone.status_code), (400, 400))

    def test_a_task_and_a_plan_start_their_agents_on_it(self):
        made = self.add()
        task = Task.objects.create(title='Do it', project=self.project)
        with mock.patch.object(tasks.herdr, 'agents', return_value=agents()), \
                mock.patch.object(tasks.herdr, 'open_workspace', return_value={'pane_id': 'w2:p1', 'cwd': '/projects/blog'}) as opened, \
                mock.patch.object(tasks.herdr, 'launch_agent', return_value=True), \
                mock.patch.object(tasks.herdr, 'prompt_task', return_value=True), \
                mock.patch.object(tasks, 'git_head', return_value=''):
            res = self.api.post(f'/api/tasks/{task.id}/assign', {'kind': 'claude', 'api': made['id']}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(opened.call_args.args[3]['ANTHROPIC_BASE_URL'], 'http://localhost:11434')
        self.assertIn('on the model API Ollama', task.events.get(kind='assigned').text)

        plan = self.api.post('/api/plans', {'title': 'p', 'kind': 'claude', 'api': made['id']}, format='json')
        self.assertEqual((plan.status_code, plan.json()['api']), (201, made['id']))
        res = self.api.patch(f"/api/plans/{plan.json()['id']}", {'kind': 'gemini'}, format='json')
        self.assertEqual(res.status_code, 400)  # a gemini agent can't use it
        res = self.api.patch(f"/api/plans/{plan.json()['id']}", {'kind': 'gemini', 'api': None}, format='json')
        self.assertEqual(res.status_code, 200, res.content)

    def test_the_marumado_on_another_machine_takes_an_environment_and_arguments(self):
        with mock.patch.object(herdr, 'open_workspace', return_value={'pane_id': 'w2:p1', 'cwd': '/srv'}) as opened:
            res = self.api.post('/api/agents/workspace', {'cwd': '/srv', 'env': {'ANTHROPIC_BASE_URL': 'http://x'}}, format='json')
            bad = self.api.post('/api/agents/workspace', {'cwd': '/srv', 'env': {'lower; rm': 'x'}}, format='json')
        self.assertEqual((res.status_code, res.json()['env']), (201, True))
        self.assertEqual(opened.call_args.args[3], {'ANTHROPIC_BASE_URL': 'http://x'})
        self.assertEqual(bad.status_code, 400)
        with mock.patch.object(herdr, 'launch_agent', return_value=True) as launched:
            res = self.api.post('/api/agents/w2:p1/launch', {'name': 'a', 'kind': 'codex', 'args': ['-m', 'gpt-5']}, format='json')
        self.assertEqual(res.json(), {'ready': True, 'args': True})
        self.assertEqual(launched.call_args.args[4], ['-m', 'gpt-5'])
