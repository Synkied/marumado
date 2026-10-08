import subprocess
import tempfile
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase

from . import herdr, slash


class SlashTests(SimpleTestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.home = Path(folder.name)
        self.cwd = str(self.home / 'work' / 'app')
        run = lambda src, script, timeout=0: subprocess.run(['sh', '-c', script], env={'HOME': str(self.home), 'PATH': '/usr/bin:/bin'},
                                                             capture_output=True).stdout
        self.kind = 'claude'
        for patch in (mock.patch.object(herdr, 'shell', side_effect=run),
                      mock.patch.object(herdr, 'get_source', return_value=herdr.Source(0, 'Local', 'env')),
                      mock.patch('core.conversation._pane', side_effect=lambda src, pane: ({'kind': self.kind, 'cwd': self.cwd}, []))):
            patch.start()
            self.addCleanup(patch.stop)
        slash._seen.clear()

    def put(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def test_claude_commands_and_skills(self):
        self.put(self.home / '.claude' / 'commands' / 'ship.md', '---\ndescription: Ship it\n---\nDo the release.')
        self.put(Path(self.cwd) / '.claude' / 'commands' / 'db' / 'reset.md', '# Reset the database\n')
        self.put(self.home / '.claude' / 'skills' / 'herdr' / 'SKILL.md', '---\nname: herdr\ndescription: "Control Herdr"\n---\n')
        found = {c['name']: c for c in slash.commands('w1:p1', 0)['commands']}
        self.assertEqual(found['ship'], {'name': 'ship', 'description': 'Ship it', 'kind': 'custom'})
        self.assertEqual(found['db:reset']['description'], 'Reset the database')
        self.assertEqual((found['herdr']['kind'], found['herdr']['description']), ('skill', 'Control Herdr'))
        self.assertEqual(found['clear']['kind'], 'built-in')

    def test_codex_prompts_and_pi_skills(self):
        self.kind = 'codex'
        self.put(self.home / '.codex' / 'prompts' / 'tidy.md', 'Tidy the imports')
        names = [c['name'] for c in slash.commands('w1:p1', 0)['commands']]
        self.assertIn('prompts:tidy', names)
        self.assertIn('new', names)
        self.kind = 'pi'
        self.put(self.home / '.agents' / 'skills' / 'obsidian' / 'SKILL.md', '---\ndescription: Notes\n---\n')
        names = [c['name'] for c in slash.commands('w1:p1', 0)['commands']]
        self.assertIn('skill:obsidian', names)
        self.assertNotIn('prompts:tidy', names)

    def test_plain_terminal(self):
        self.kind = 'terminal'
        self.assertEqual(slash.commands('w1:p1', 0)['commands'], [])
