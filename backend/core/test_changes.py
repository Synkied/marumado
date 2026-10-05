import os
import subprocess
import tempfile
from pathlib import Path
from unittest import mock
from django.test import SimpleTestCase
from . import changes, herdr


class ChangesTests(SimpleTestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.source = herdr.Source(0, 'Local', 'env')
        patch = mock.patch.dict(os.environ, {'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'safe.directory', 'GIT_CONFIG_VALUE_0': '*'})
        patch.start()
        self.addCleanup(patch.stop)
        patch = mock.patch.object(herdr, '_list', return_value={'available': True, 'agents': [{'pane_id': 'w1:p1', 'cwd': str(self.root)}]})
        patch.start()
        self.addCleanup(patch.stop)
        self.git('init', '-q')
        self.git('config', 'user.email', 'test@example.com')
        self.git('config', 'user.name', 'Test')
        (self.root / 'original.txt').write_text('before\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'Initial')

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.root), *args], check=True, capture_output=True)

    def read(self, path=None):
        return changes.read('w1:p1', self.source, path)

    def test_staged_unstaged_new_and_renamed(self):
        (self.root / 'original.txt').write_text('staged\n')
        self.git('add', '.')
        (self.root / 'original.txt').write_text('after\n')
        (self.root / "new 'file.txt").write_text('new content\n')
        self.assertEqual({f['path'] for f in self.read()['files']}, {'original.txt', "new 'file.txt"})
        self.assertIn('-before', self.read('original.txt')['diff'])
        self.assertIn('+after', self.read('original.txt')['diff'])
        self.assertIn('+new content', self.read("new 'file.txt")['diff'])
        self.git('restore', '--staged', 'original.txt')
        self.git('restore', 'original.txt')
        self.git('mv', 'original.txt', 'renamed.txt')
        renamed = next(f for f in self.read()['files'] if f['path'] == 'renamed.txt')
        self.assertEqual(renamed['original'], 'original.txt')
        self.assertIn('rename from original.txt', self.read('renamed.txt')['diff'])

    def test_clean_and_invalid_path(self):
        self.assertEqual(self.read()['files'], [])
        with self.assertRaises(ValueError):
            self.read('../outside')

    def test_unborn_repository(self):
        other = self.root / 'fresh'
        other.mkdir()
        subprocess.run(['git', '-C', str(other), 'init', '-q'], check=True)
        (other / 'first.txt').write_text('first\n')
        subprocess.run(['git', '-C', str(other), 'add', '.'], check=True)
        with mock.patch.object(herdr, '_list', return_value={'available': True, 'agents': [{'pane_id': 'w1:p1', 'cwd': str(other)}]}):
            self.assertIn('+first', self.read('first.txt')['diff'])

    def test_no_repository_and_binary(self):
        (self.root / 'binary').write_bytes(b'\0\1\2')
        self.assertIn('Binary files', self.read('binary')['diff'])
        with tempfile.TemporaryDirectory() as other:
            with mock.patch.object(herdr, '_list', return_value={'available': True, 'agents': [{'pane_id': 'w1:p1', 'cwd': other}]}):
                self.assertIsNone(self.read()['repository'])

    def test_large_diff_is_bounded(self):
        (self.root / 'large.txt').write_text('a' * (changes.LIMIT + 100))
        result = self.read('large.txt')
        self.assertTrue(result['truncated'])
        self.assertLessEqual(len(result['diff']), changes.LIMIT)
