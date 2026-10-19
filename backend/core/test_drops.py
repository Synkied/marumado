import os
import re
import shutil
import subprocess
from pathlib import Path
from unittest import mock

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from . import drops, herdr
from .tests import FakeTunnel, with_tunnels

ROOT = Path(f'/tmp/marumado-drops-{os.getuid()}')


def run_here(script, data=None):
    """What a VM or SSH host would do with the script: run it in sh, `data` on its stdin."""
    return subprocess.run(['sh', '-c', script], input=data, capture_output=True).stdout


class DropTests(TestCase):
    """A file dropped into an agent's chat lands where the agent runs, in a folder of its own."""

    def tearDown(self):
        shutil.rmtree(ROOT, ignore_errors=True)

    def test_a_name_keeps_no_folder_nor_anything_a_shell_would_read(self):
        self.assertEqual(drops.clean_name('../../etc/passwd'), 'passwd')
        self.assertEqual(drops.clean_name('C:\\Users\\me\\My shot (2).png'), 'My-shot-2-.png')
        self.assertEqual(drops.clean_name('.env'), 'env')
        self.assertEqual(drops.clean_name('$(rm -rf ~);.txt'), 'rm--rf-.txt')
        self.assertEqual(drops.clean_name('...'), 'file')
        self.assertEqual(drops.clean_name('é' * 200 + '.pdf')[-4:], '.pdf')

    def test_on_this_machine_it_is_written_for_the_owner_only(self):
        with mock.patch.object(herdr, '_contained', return_value=False):
            path = Path(drops.save('w1:p1', herdr.ENV, 'shot.png', b'\x89PNG data'))
        self.assertEqual((path.parent.parent, path.name, path.read_bytes()), (ROOT, 'shot.png', b'\x89PNG data'))
        self.assertEqual((path.stat().st_mode & 0o777, path.parent.stat().st_mode & 0o777), (0o600, 0o700))

    def test_old_drops_are_removed_as_new_ones_come(self):
        old = ROOT / 'old'
        old.mkdir(parents=True)
        (old / 'a.txt').write_text('a')
        os.utime(old, (0, 0))
        with mock.patch.object(herdr, '_contained', return_value=False):
            drops.save('w1:p1', herdr.ENV, 'b.txt', b'b')
        self.assertFalse(old.exists())

    def test_in_a_vm_or_over_ssh_it_goes_on_the_shells_stdin(self):
        with mock.patch.object(herdr, '_elsewhere', return_value=('', 'vm-exec', '')), \
                mock.patch.object(herdr, '_wrap', side_effect=lambda src, script, interactive=False: (['sh', '-c', script], None)) as wrapped:
            path = Path(drops.save('w1:p1', herdr.ENV, 'notes.txt', b'hello'))
        self.assertTrue(wrapped.call_args.kwargs['interactive'])  # so smolvm passes stdin on
        self.assertEqual(path.read_bytes(), b'hello')
        self.assertEqual(path.parent.parent, ROOT)

    def test_a_file_cut_short_on_the_way_is_an_error(self):
        with mock.patch.object(herdr, '_elsewhere', return_value=('', 'vm-exec', '')), \
                mock.patch.object(herdr, 'shell', side_effect=lambda src, script, timeout, data: run_here(script, data[:2])):
            with self.assertRaisesRegex(RuntimeError, 'Only part of it arrived'):
                drops.save('w1:p1', herdr.ENV, 'notes.txt', b'hello')

    def test_a_drop_folder_someone_else_made_is_refused(self):
        ROOT.parent.mkdir(exist_ok=True)
        ROOT.symlink_to('/tmp')
        try:
            with mock.patch.object(herdr, '_elsewhere', return_value=('', 'vm-exec', '')), \
                    mock.patch.object(herdr, 'shell', side_effect=lambda src, script, timeout, data: run_here(script, data)):
                with self.assertRaisesRegex(RuntimeError, 'is not yours'):
                    drops.save('w1:p1', herdr.ENV, 'notes.txt', b'hello')
        finally:
            ROOT.unlink()

    def test_in_a_container_the_host_fetches_it_once_from_marumado(self):
        client = APIClient()  # the host's shell has no login
        fetched = []

        def host(src, cwd, script, timeout, near):
            url = re.search(r"curl -fsS -o \"\$f\" '?(http://127\.0\.0\.1:\d+(/api/drops/[^ ']+))", script)
            first, again = client.get(url.group(2)), client.get(url.group(2))
            fetched.append((first.status_code, first.content, again.status_code, near))
            return 0, run_here(script.replace(script[script.index('{ curl'):script.index('2>&1') + 4], 'cat > "$f"'), first.content).decode()

        with mock.patch.object(herdr, '_contained', return_value=True), mock.patch.object(herdr, 'execute', side_effect=host):
            path = Path(drops.save('w1:p1', herdr.ENV, 'shot.png', b'picture'))
        self.assertEqual(fetched, [(200, b'picture', 404, 'w1:p1')])
        self.assertEqual(path.read_bytes(), b'picture')
        self.assertEqual(drops._waiting, {})

    def test_a_machine_is_sent_the_file_through_its_marumado(self):
        tunnel = FakeTunnel(id=3, answers={'agents/w2:p1/files': (201, {'path': '/tmp/marumado-drops-1000/ab/shot.png'})})
        with with_tunnels(tunnel):
            path = drops.save('w2:p1', herdr.MACHINE_BASE + 3, 'my shot.png', b'picture')
        self.assertEqual(path, '/tmp/marumado-drops-1000/ab/shot.png')
        self.assertEqual(tunnel.calls[0], ('POST', 'agents/w2:p1/files', 'source=0&name=my-shot.png', b'picture'))


@override_settings(MARUMADO_TOKEN='test-token')
class DropViewTests(TestCase):
    def setUp(self):
        self.api = APIClient()
        self.api.credentials(HTTP_AUTHORIZATION='Bearer test-token')

    def post(self, data, name='shot.png', **extra):
        return self.api.generic('POST', f'/api/agents/w1:p1/files?name={name}&source=0', data, 'application/octet-stream', **extra)

    def test_a_file_bigger_than_a_form_may_be_is_taken(self):
        big = b'x' * (3 * 1024 * 1024)  # over Django's 2.5 MB for request.body
        with mock.patch.object(drops, 'save', return_value='/tmp/marumado-drops-0/ab/shot.png') as saved:
            res = self.post(big)
        self.assertEqual((res.status_code, res.json()), (201, {'path': '/tmp/marumado-drops-0/ab/shot.png'}))
        self.assertEqual(saved.call_args.args[2:], ('shot.png', big))

    def test_refuses_an_empty_or_too_big_file_and_strangers(self):
        self.assertEqual(self.post(b'').status_code, 400)
        self.assertEqual(self.post(b'x', CONTENT_LENGTH=str(drops.MAX_BYTES + 1)).status_code, 413)
        self.assertEqual(APIClient().generic('POST', '/api/agents/w1:p1/files?name=a', b'x', 'application/octet-stream').status_code, 403)
        self.assertEqual(APIClient().get('/api/drops/nothing-here').status_code, 404)
