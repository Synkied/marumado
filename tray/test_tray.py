"""uv run --with pillow python -m unittest tray/test_tray.py   (no desktop needed: the tray's own logic only)"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import marumado_tray  # noqa: E402
from marumado_tray import MENU_WORKING, Config, Reading, draw_icon, from_env_file, load_config, menu_model, screen_line, summary  # noqa: E402

CFG = Config('http://box:7878', 't')


def agent(pane: str, status: str, **more) -> dict:
    return {'pane_id': pane, 'source': 0, 'name': f'a{pane}', 'kind': 'claude', 'status': status, 'title': '', 'cwd': '/p', **more}


class MenuTests(unittest.TestCase):
    def test_up_to_three_working_agents_are_listed_in_the_menu(self):
        r = Reading(agents=[agent(str(i), 'working') for i in range(MENU_WORKING)] + [agent('9', 'idle')])
        texts = [e.text.strip() for e in menu_model(CFG, r, {'0/0': 0}, 125)]
        self.assertEqual(texts[0], '3 working · 1 idle')
        self.assertIn('a0 — 2 min', texts)
        self.assertFalse(any(e.card for e in menu_model(CFG, r, {}, 0)))

    def test_past_three_one_entry_opens_the_card(self):
        r = Reading(agents=[agent(str(i), 'working') for i in range(MENU_WORKING + 1)])
        entries = menu_model(CFG, r, {}, 0)
        cards = [e for e in entries if e.card]
        self.assertEqual([e.text for e in cards], ['See all 4 working agents…'])
        self.assertTrue(cards[0].default)
        self.assertFalse(any(e.href.startswith(f'{CFG.url}/#/m/agents/') for e in entries))

    def test_who_needs_you_is_always_listed_with_its_page(self):
        r = Reading(agents=[agent('1', 'blocked', project={'id': 1, 'name': 'marumado'})] + [agent(str(i), 'working') for i in range(2, 8)],
                    sources={0: 'here', 5: 'vm'})
        entries = menu_model(CFG, r, {}, 0)
        blocked = [e for e in entries if e.href == 'http://box:7878/#/m/agents/0/1']
        self.assertEqual(blocked[0].text.strip(), 'a1 · marumado · here')
        self.assertEqual(summary(r), '1 needs you · 6 working')

    def test_unreachable(self):
        entries = menu_model(CFG, Reading(error="Can't reach Marumado"), {}, 0)
        self.assertEqual([e.text for e in entries if not e.rule], ["Can't reach Marumado", 'Open Marumado'])

    def test_with_tk_a_click_opens_the_card_whatever_the_state(self):
        for r in [Reading(error='x'), Reading(), Reading(agents=[agent(str(i), 'working') for i in range(6)])]:
            defaults = [e for e in menu_model(CFG, r, {}, 0, card=True) if e.default]
            self.assertEqual([(e.text, e.card) for e in defaults], [('Show agents…', True)])


class TokenTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo, marumado_tray.REPO = marumado_tray.REPO, self.tmp
        self.docker, marumado_tray.from_docker = marumado_tray.from_docker, lambda: 'from-docker'
        (self.tmp / 'backend' / 'data').mkdir(parents=True)
        (self.tmp / 'backend' / 'data' / 'access-token').write_text('dev-token\n')
        for name in ('MARUMADO_TOKEN', 'MARUMADO_TOKEN_FILE'):
            os.environ.pop(name, None)

    def tearDown(self):
        marumado_tray.REPO, marumado_tray.from_docker = self.repo, self.docker

    def test_an_empty_env_token_leads_to_the_container_then_the_dev_file(self):
        (self.tmp / '.env').write_text('MARUMADO_PORT=7878\nMARUMADO_TOKEN=\n')
        cfg, _ = load_config([])
        self.assertEqual((cfg.token, cfg.token_from), ('from-docker', 'the marumado container'))
        self.assertTrue(cfg.next_token())  # refused: the next place
        self.assertEqual(cfg.token, 'dev-token')
        self.assertFalse(cfg.next_token())

    def test_the_env_file_token_comes_first_and_a_given_one_alone(self):
        (self.tmp / '.env').write_text('MARUMADO_TOKEN="abc"  # mine\n')
        self.assertEqual(from_env_file(self.tmp / '.env'), 'abc')
        self.assertEqual(load_config([])[0].token, 'abc')
        cfg, _ = load_config(['--token', 'given'])
        self.assertEqual(cfg.token, 'given')
        self.assertFalse(cfg.next_token())


class ScreenTests(unittest.TestCase):
    def test_claude_codes_activity_line_wins(self):
        screen = '⏺ Edited app.css\n✻ Pondering… (12s · ↑ 1.2k tokens · esc to interrupt)\n╭──────╮\n│ >    │\n╰──────╯\n  ? for shortcuts\n'
        self.assertEqual(screen_line(screen), '✻ Pondering… (12s · ↑ 1.2k tokens)')

    def test_otherwise_the_last_line_of_text(self):
        self.assertEqual(screen_line('$ make test\nRan 34 tests\nOK\n\n'), 'OK')
        self.assertEqual(screen_line('╭───╮\n╰───╯'), '')


class IconTests(unittest.TestCase):
    def test_every_state_draws(self):
        for r in [Reading(error='x'), Reading(), Reading(agents=[agent('1', 'working')]),
                  Reading(agents=[agent('1', 'blocked'), agent('2', 'working'), agent('3', 'done'), agent('4', 'idle')])]:
            for opaque in (False, True):
                img = draw_icon(r, opaque=opaque)
                self.assertEqual(img.size, (64, 64))
                self.assertIsNotNone(img.getbbox())
        self.assertEqual(draw_icon(Reading(), opaque=True).getpixel((0, 0))[3], 255)


if __name__ == '__main__':
    unittest.main()
