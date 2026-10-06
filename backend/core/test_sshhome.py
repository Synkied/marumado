import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase

from . import sshhome


class PrepareTests(SimpleTestCase):
    def prepare(self, files, env=None):
        """sshhome.prepare() from a host ~/.ssh holding these files: the container's ~/.ssh config it writes."""
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        source, home = tmp / 'host-ssh', tmp / 'root'
        source.mkdir()
        home.mkdir()
        for name, text in files.items():
            (source / name).write_text(text)
        env = {'MARUMADO_SSH_SOURCE': str(source), 'MARUMADO_SSH_USER': 'you', 'MARUMADO_SSH_KEYS': '', **(env or {})}
        real_exists = Path.exists
        with mock.patch.dict(os.environ, env), mock.patch.object(sshhome, '_copied', None), \
                mock.patch.object(Path, 'home', return_value=home), \
                mock.patch.object(Path, 'exists', lambda p: str(p) == '/.dockerenv' or real_exists(p)):
            sshhome.prepare()
        config = home / '.ssh' / 'config'
        return config.read_text() if config.is_file() else ''

    def test_a_config_naming_its_own_keys_keeps_the_usual_ones_last(self):
        text = self.prepare({'config': 'Host aws\n  IdentityFile ~/.ssh/work.pem\n', 'work.pem': 'k', 'id_rsa': 'k'})
        self.assertTrue(text.startswith('Host aws\n  IdentityFile ~/.ssh/work.pem\n'))
        self.assertIn('User you\n', text)
        self.assertTrue(text.endswith('Match all\n  IdentityFile ~/.ssh/id_rsa\n'))
        self.assertNotIn('id_ed25519', text, 'only the keys that are there')
        if not shutil.which('ssh'):
            raise unittest.SkipTest('no ssh to read the config back')
        path = Path(tempfile.mkdtemp()) / 'config'
        self.addCleanup(shutil.rmtree, path.parent)
        path.write_text(text)
        out = subprocess.run(['ssh', '-G', '-F', str(path), 'aws'], capture_output=True, text=True, check=True).stdout
        files = [ln.split(' ', 1)[1] for ln in out.splitlines() if ln.startswith('identityfile ')]
        self.assertEqual([Path(f).name for f in files], ['work.pem', 'id_rsa'])

    def test_without_a_config_ssh_tries_the_usual_keys_itself(self):
        text = self.prepare({'id_rsa': 'k'})
        self.assertNotIn('IdentityFile', text)
        self.assertIn('User you\n', text)

    def test_chosen_keys_leave_the_config_out(self):
        text = self.prepare({'config': 'Host aws\n  IdentityFile ~/.ssh/work.pem\n', 'id_rsa': 'k'},
                            env={'MARUMADO_SSH_KEYS': 'id_rsa'})
        self.assertNotIn('work.pem', text)
        self.assertNotIn('IdentityFile', text)
