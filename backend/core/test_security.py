import base64
import subprocess
import tempfile
from pathlib import Path
from unittest import mock

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from . import monitor, security
from .models import Project


def port(n, address='0.0.0.0', pid=100, process='app', proto='tcp'):
    return {'port': n, 'address': address, 'proto': proto, 'pid': pid, 'process': process, 'cwd': '', 'cmdline': ''}


def proc(pid, name, user='me', cpu=0.0, kernel=False):
    return {'pid': pid, 'name': name, 'user': user, 'cpu': cpu, 'kernel': kernel}


class HostFiles:
    """A fake host root: host_path() reads from a temporary folder."""

    def __init__(self, test, files: dict[str, str]):
        self.dir = tempfile.TemporaryDirectory()
        test.addCleanup(self.dir.cleanup)
        root = Path(self.dir.name)
        for path, text in files.items():
            f = root / path.lstrip('/')
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(text)
        patch = mock.patch.object(security, 'host_path', lambda p: root / p.lstrip('/'))
        patch.start()
        test.addCleanup(patch.stop)


class NetworkTests(TestCase):
    def test_risky_service_on_every_address_is_high(self):
        out = security.check_network([port(6379, process='redis-server')], [proc(100, 'redis-server')], [])
        self.assertEqual([(f['id'], f['severity']) for f in out], [('net:exposed:6379', 'high')])
        self.assertIn('Redis', out[0]['title'])

    def test_loopback_and_expected_ports_are_fine(self):
        ports = [port(5432, address='127.0.0.1'), port(22), port(53, proto='udp'), port(6379, address='::1')]
        self.assertEqual(security.check_network(ports, [], []), [])

    def test_published_container_gets_compose_advice(self):
        containers = [{'name': 'db', 'ports': [{'host_port': 5432, 'host_ip': '0.0.0.0', 'container_port': '5432/tcp'}]}]
        out = security.check_network([port(5432, process='docker-proxy')], [], containers)
        self.assertEqual(out[0]['severity'], 'medium')
        self.assertIn('127.0.0.1:5432', out[0]['action'])
        self.assertIn('the container db', out[0]['detail'])

    def test_other_open_port_is_worse_as_root(self):
        self.assertEqual(security.check_network([port(8000)], [proc(100, 'app')], [])[0]['severity'], 'low')
        self.assertEqual(security.check_network([port(8000)], [proc(100, 'app', user='root')], [])[0]['severity'], 'medium')

    def test_firewall(self):
        open_port = security.check_network([port(8000)], [], [])
        HostFiles(self, {'/etc/os-release': 'ID=debian', '/etc/ufw/ufw.conf': 'ENABLED=no\n'})
        self.assertEqual(security.check_firewall([], open_port)[0]['severity'], 'medium')
        self.assertEqual(security.check_firewall([], [])[0]['severity'], 'low')
        self.assertEqual(security.check_firewall([proc(5, 'firewalld')], open_port), [])

    def test_firewall_on(self):
        HostFiles(self, {'/etc/os-release': 'ID=debian', '/etc/ufw/ufw.conf': 'ENABLED=yes\n'})
        self.assertEqual(security.check_firewall([], security.check_network([port(8000)], [], [])), [])

    def test_firewall_unknown_without_host_files(self):
        HostFiles(self, {})
        self.assertEqual(security.check_firewall([], security.check_network([port(8000)], [], [])), [])


class ProcessTests(TestCase):
    def exe(self, links):
        patch = mock.patch.object(security, '_exe_link', lambda pid: links.get(pid, ''))
        patch.start()
        self.addCleanup(patch.stop)

    def test_miner_temp_and_stale(self):
        self.exe({1: '/usr/bin/xmrig', 2: '/dev/shm/.x/run', 3: '/usr/sbin/nginx (deleted)', 4: '/usr/bin/vim'})
        out = security.check_processes([proc(1, 'xmrig', cpu=99), proc(2, 'run'), proc(3, 'nginx'), proc(4, 'vim')])
        self.assertEqual([f['id'] for f in out], ['proc:miner:xmrig', 'proc:temp:/dev/shm/.x/run', 'proc:stale'])
        self.assertIn('nginx (3)', out[2]['detail'])

    def test_kernel_threads_are_skipped(self):
        self.exe({2: '/tmp/x'})
        self.assertEqual(security.check_processes([proc(2, 'kthreadd', kernel=True)]), [])


class SystemTests(TestCase):
    SSHD = (proc(1, 'sshd'),)

    def test_sshd_first_value_wins_dropins_first(self):
        HostFiles(self, {
            '/etc/ssh/sshd_config': 'PermitRootLogin yes\nPasswordAuthentication yes\nMatch User git\n  PermitRootLogin no\n',
            '/etc/ssh/sshd_config.d/50-cloud.conf': 'PasswordAuthentication no\n',
        })
        out = security.check_ssh(list(self.SSHD), [port(22, process='sshd')])
        self.assertEqual([f['id'] for f in out], ['ssh:root'])

    def test_password_logins_open_to_network_without_guard(self):
        HostFiles(self, {'/etc/ssh/sshd_config': '# defaults\n'})
        out = security.check_ssh(list(self.SSHD), [port(22, process='sshd')])
        self.assertEqual([(f['id'], f['severity']) for f in out], [('ssh:password', 'medium'), ('ssh:guard', 'low')])
        self.assertEqual([f['id'] for f in security.check_ssh([*self.SSHD, proc(2, 'fail2ban-server')], [port(22)])], ['ssh:password'])
        self.assertEqual(security.check_ssh(list(self.SSHD), [port(22, address='127.0.0.1')])[0]['severity'], 'low')

    def test_no_sshd_no_ssh_findings(self):
        HostFiles(self, {'/etc/ssh/sshd_config': 'PermitRootLogin yes\n'})
        self.assertEqual(security.check_ssh([], []), [])

    def test_updates(self):
        HostFiles(self, {
            '/var/run/reboot-required': '', '/var/run/reboot-required.pkgs': 'linux-base\nlibc6\n',
            '/var/lib/update-notifier/updates-available': '\n12 updates can be applied immediately.\n3 of these updates are standard security updates.\n',
            '/etc/debian_version': '13', '/etc/apt/apt.conf.d/20auto-upgrades': 'APT::Periodic::Unattended-Upgrade "1";\n',
        })
        out = security.check_updates()
        self.assertEqual([f['id'] for f in out], ['upd:reboot', 'upd:security'])
        self.assertIn('libc6', out[0]['detail'])
        self.assertTrue(out[1]['title'].startswith('3 security updates'))

    def test_auto_updates_off(self):
        HostFiles(self, {'/etc/debian_version': '13'})
        self.assertEqual([f['id'] for f in security.check_updates()], ['upd:auto'])

    def test_accounts(self):
        HostFiles(self, {
            '/etc/passwd': 'root:x:0:0::/root:/bin/sh\ntoor:x:0:0::/root:/bin/sh\nme:x:1000:1000::/home/me:/bin/sh\n',
            '/etc/shadow': 'root:*:1::::::\nguest::1::::::\n',
            '/etc/group': 'docker:x:999:me\n',
        })
        out = security.check_accounts()
        self.assertEqual([f['id'] for f in out], ['acct:uid0', 'acct:empty', 'acct:docker'])
        self.assertIn('toor', out[0]['title'])
        self.assertIn('guest', out[1]['title'])


def openssh_key(cipher: bytes) -> str:
    body = base64.b64encode(b'openssh-key-v1\0' + len(cipher).to_bytes(4, 'big') + cipher + b'\0' * 40).decode()
    return f'-----BEGIN OPENSSH PRIVATE KEY-----\n{body}\n-----END OPENSSH PRIVATE KEY-----\n'


class SecretsTests(TestCase):
    def test_ssh_keys(self):
        with tempfile.TemporaryDirectory() as home:
            ssh = Path(home, '.ssh')
            ssh.mkdir()
            for name, text, mode in [('id_bare', openssh_key(b'none'), 0o600), ('id_safe', openssh_key(b'aes256-ctr'), 0o600),
                                     ('id_open', openssh_key(b'aes256-ctr'), 0o644), ('id_bare.pub', 'ssh-ed25519 AAA', 0o644)]:
                Path(ssh, name).write_text(text)
                Path(ssh, name).chmod(mode)
            with mock.patch.dict('os.environ', {'MARUMADO_HOST_HOME': home}):
                out = security.check_ssh_keys()
        self.assertEqual(sorted(f['id'] for f in out), ['key:bare', 'key:mode:id_open'])
        self.assertIn('id_bare', next(f for f in out if f['id'] == 'key:bare')['detail'])

    def test_repo_secrets(self):
        with tempfile.TemporaryDirectory() as path:
            for name in ('.env', '.env.example', 'deploy/server.pem', 'src/app.py'):
                Path(path, name).parent.mkdir(parents=True, exist_ok=True)
                Path(path, name).write_text('x')
            subprocess.run(['git', 'init', '-q', path], check=True)
            subprocess.run(['git', '-C', path, 'add', '.'], check=True)
            p = Project.objects.create(name='demo', path=path, detected={'repo_url': 'https://github.com/me/demo'})
            out = security.check_repos()
        self.assertEqual([(f['id'], f['severity']) for f in out], [(f'repo:secrets:{p.id}', 'high')])
        self.assertIn('.env', out[0]['detail'])
        self.assertIn('deploy/server.pem', out[0]['detail'])
        self.assertNotIn('.env.example', out[0]['detail'])


@override_settings(MARUMADO_TOKEN='test-token-that-is-long-enough')
class AuditApiTests(TestCase):
    def setUp(self):
        self.api = APIClient()
        self.api.credentials(HTTP_AUTHORIZATION='Bearer test-token-that-is-long-enough')
        snap = {'processes': [proc(100, 'redis-server')], 'ports': [port(6379, process='redis-server')],
                'docker': {'available': False, 'containers': []}}
        for patch in (mock.patch.object(monitor, 'snapshot', side_effect=snap.__getitem__),
                      mock.patch.object(security, 'check_connections', return_value=[]),
                      mock.patch.object(security, 'check_containers', return_value=[]),
                      mock.patch.object(security, 'check_ssh_keys', return_value=[])):
            patch.start()
            self.addCleanup(patch.stop)
        HostFiles(self, {})
        security._cache = None

    def test_audit_and_accept(self):
        data = self.api.get('/api/security?fresh=1').json()
        ids = [f['id'] for f in data['findings']]
        self.assertEqual(ids[0], 'net:exposed:6379')
        self.assertIsNone(data['findings'][0]['accepted'])
        self.assertTrue(any('host’s files' in u for u in data['unknown']))

        data = self.api.post('/api/security/accept', {'id': 'net:exposed:6379', 'note': 'firewalled upstream'}, format='json').json()
        self.assertEqual(data['findings'][0]['accepted']['note'], 'firewalled upstream')

        data = self.api.delete('/api/security/accept?id=net:exposed:6379').json()
        self.assertIsNone(data['findings'][0]['accepted'])
        self.assertEqual(self.api.post('/api/security/accept', {}, format='json').status_code, 400)
