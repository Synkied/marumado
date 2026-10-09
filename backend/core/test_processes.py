from unittest import mock

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from . import monitor
from .models import Project


def proc(pid, ppid, name, cpu=0.0, rss=0, **extra):
    return {'pid': pid, 'ppid': ppid, 'name': name, 'user': 'me', 'status': 'sleeping', 'cpu': cpu, 'rss': rss,
            'mem_percent': 0.0, 'threads': 1, 'started': 1000.0 + pid, 'cpu_time': 0.0, 'nice': 0, 'kernel': False,
            'cwd': '', 'cmdline': name, **extra}


ROWS = [
    proc(1, 0, 'init', cpu=0.1, rss=10),
    proc(2, 0, 'kthreadd', kernel=True),
    proc(3, 2, 'kworker', cpu=5.0, kernel=True),
    proc(10, 1, 'bash', cpu=0.0, rss=5),
    proc(11, 10, 'python', cpu=40.0, rss=500, cwd='/work/demo/src'),
    proc(12, 10, 'vim', cpu=1.0, rss=50),
    proc(20, 1, 'chrome', cpu=10.0, rss=1000),
    proc(21, 20, 'chrome', cpu=5.0, rss=800),
]


@override_settings(MARUMADO_TOKEN='test-token')
class ProcessesTests(TestCase):
    def setUp(self):
        Project.objects.create(name='demo', path='/work/demo')
        self.api = APIClient()
        self.api.credentials(HTTP_AUTHORIZATION='Bearer test-token')
        patch = mock.patch.object(monitor, 'snapshot', return_value=ROWS)
        patch.start()
        self.addCleanup(patch.stop)

    def get(self, query):
        res = self.api.get(f'/api/processes?{query}')
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def test_list_sorts_and_hides_kernel_threads(self):
        data = self.get('view=list&sort=cpu')
        self.assertEqual([r['pid'] for r in data['processes']][:3], [11, 20, 21])
        self.assertNotIn(3, [r['pid'] for r in data['processes']])
        self.assertEqual(data['processes'][0]['project']['name'], 'demo')
        self.assertIn(3, [r['pid'] for r in self.get('view=list&kernel=1')['processes']])
        self.assertEqual([r['name'] for r in self.get('sort=name&limit=2')['processes']], ['bash', 'chrome'])
        self.assertEqual(self.get('sort=name&order=desc&limit=1')['processes'][0]['name'], 'vim')

    def test_tree_orders_branches_by_their_weight(self):
        rows = self.get('view=tree&sort=cpu')['processes']
        self.assertEqual([(r['pid'], r['depth']) for r in rows], [(1, 0), (10, 1), (11, 2), (12, 2), (20, 1), (21, 2)])
        bash = rows[1]
        self.assertEqual((bash['children'], bash['tree_cpu'], bash['tree_rss']), (2, 41.0, 555))

    def test_tree_filter_keeps_the_parents(self):
        rows = self.get('view=tree&q=vim')['processes']
        self.assertEqual([(r['pid'], r['match']) for r in rows], [(1, False), (10, False), (12, True)])

    def test_apps_add_up_a_program(self):
        apps = self.get('view=apps&sort=rss')['apps']
        self.assertEqual(apps[0]['name'], 'chrome')
        self.assertEqual((apps[0]['count'], apps[0]['cpu'], apps[0]['rss'], apps[0]['pid']), (2, 15.0, 1800, 20))
        self.assertEqual(self.get('view=apps&sort=count&limit=1')['apps'][0]['name'], 'chrome')

    def test_one_program_by_name(self):
        self.assertEqual([r['pid'] for r in self.get('name=chrome&sort=pid')['processes']], [20, 21])

    def test_detail(self):
        with mock.patch.object(monitor, 'process_detail', return_value={'exe': '/usr/bin/python', 'fds': 4}), \
                mock.patch.object(monitor, 'process_history', return_value=[(1.0, 40.0, 500)]):
            res = self.api.get('/api/processes/11')
        self.assertEqual(res.status_code, 200, res.content)
        data = res.json()
        self.assertEqual((data['exe'], data['project']['name'], data['history']), ('/usr/bin/python', 'demo', [{'t': 1.0, 'cpu': 40.0, 'rss': 500}]))
        self.assertEqual(self.api.get('/api/processes/999').status_code, 404)
