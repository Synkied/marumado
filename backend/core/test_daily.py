import json
import os
import tempfile
from pathlib import Path
from unittest import mock

from django.test import TestCase

from . import daily


def _reply(msg_id: str, ts: str, output: int, model: str = 'claude-opus-5-5') -> str:
    return json.dumps({'type': 'assistant', 'timestamp': ts, 'message': {
        'id': msg_id, 'model': model, 'usage': {'input_tokens': 10, 'cache_read_input_tokens': 100, 'output_tokens': output}}}) + '\n'


class DailyUsageTests(TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        env = mock.patch.dict('os.environ', {'HOME': str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        daily._seen.clear()
        self.record = self.home / '.claude' / 'projects' / '-projects-demo' / 's1.jsonl'
        self.record.parent.mkdir(parents=True)
        self.ledger = self.home / '.agents' / 'marumado' / f'usage-{os.uname().nodename}.json'

    def totals(self) -> dict:
        daily._seen.clear()
        out: dict = {}
        for day, _, project, model, calls, *tokens in daily.report(include_machines=False, tz='Pacific/Kiritimati')['rows']:
            row = out.setdefault((day, project, model), [0] * 7)
            for i, v in enumerate([calls, *tokens]):
                row[i] += v
        return out

    def test_a_reply_written_over_two_reads_counts_once_and_a_deleted_record_stays(self):
        # Claude Code writes a reply once per block; the second line has the final usage.
        self.record.write_text(_reply('m1', '2026-10-27T13:05:00Z', 5))
        daily.collect(0)
        with self.record.open('a') as f:
            f.write(_reply('m1', '2026-10-27T13:05:01Z', 40))
            f.write(_reply('m2', '2026-10-27T14:00:00Z', 7))
            f.write('{"type": "assistant", "half a line')
        rows = self.totals()
        # Days in the browser's time zone: at UTC+14 both replies fall on the 28th.
        self.assertEqual(rows[('2026-10-28', 'demo', 'claude-opus-5-5')][:6], [2, 20, 0, 0, 200, 47])
        ledger = json.loads(self.ledger.read_text())
        self.assertIn(str(self.record), ledger['files'])

        self.record.unlink()
        self.assertEqual(self.totals(), rows)
        ledger = json.loads(self.ledger.read_text())
        self.assertEqual(ledger['files'], {})
        self.assertIn(str(self.record), ledger['gone'])

    def test_a_record_the_listing_misses_for_a_while_is_not_counted_again(self):
        self.record.write_text(_reply('m1', '2026-10-27T13:05:00Z', 5) + _reply('m2', '2026-10-27T14:00:00Z', 7))
        rows = self.totals()
        away = self.home / 'away.jsonl'
        for _ in range(3):  # out of sight (unreadable, say), then back
            self.record.rename(away)
            self.assertEqual(self.totals(), rows)
            away.rename(self.record)
            self.assertEqual(self.totals(), rows)

    def test_the_shared_version_1_ledger_gives_this_machine_its_own_records_only(self):
        self.record.write_text(_reply('m1', '2026-10-27T13:05:00Z', 5))
        old = self.home / '.agents' / 'marumado' / 'usage.json'  # shared by every machine with this ~/.agents
        old.parent.mkdir(parents=True)
        theirs = {'kind': 'claude', 'folder': '-x', 'offset': 9, 'state': {}, 'hours': {'2026-10-27T13': {'claude-opus-5-5': [3, 3, 0, 0, 3, 3, 1.0]}}}
        old.write_text(json.dumps({'version': 1, 'files': {'/elsewhere/.claude/projects/-x/s.jsonl': theirs},
                                   'gone': {'claude\t-projects-demo': {'2026-10-27T13': {'claude-opus-5-5': [9, 9, 0, 0, 9, 9, 1.0]}}}}))
        self.assertEqual(self.totals(), {('2026-10-28', 'demo', 'claude-opus-5-5'): [1, 10, 0, 0, 100, 5, mock.ANY]})
        mine = json.loads(self.ledger.read_text())
        self.assertEqual((mine['version'], list(mine['files']), mine['gone']), (2, [str(self.record)], {}))

    def test_an_answer_cut_short_reads_what_came_and_the_rest_next_run(self):
        self.record.write_text(_reply('m1', '2026-10-27T13:05:00Z', 5) + _reply('m2', '2026-10-27T14:00:00Z', 7))
        real = daily.herdr.shell

        def cut(src, script, **kw):
            out = real(src, script, **kw)
            return out[:out.index(b'"m2"')] if 'tail -c' in script else out
        with mock.patch.object(daily.herdr, 'shell', cut):
            ledger, behind = daily.collect(0)
        self.assertTrue(behind)
        self.assertEqual(sum(r[0] for m in ledger['files'][str(self.record)]['hours'].values() for r in m.values()), 1)
        self.assertEqual(self.totals()[('2026-10-28', 'demo', 'claude-opus-5-5')][:6], [2, 20, 0, 0, 200, 12])

    def test_a_cloud_model_id_is_priced_and_a_day_read_before_it_had_a_price_is_priced_now(self):
        self.record.write_text(_reply('m1', '2026-10-27T13:05:00Z', 5, model='eu.anthropic.claude-opus-4-8'))
        cost = self.totals()[('2026-10-28', 'demo', 'eu.anthropic.claude-opus-4-8')][6]
        self.assertAlmostEqual(cost, (10 * 5 + 100 * 0.5 + 5 * 25) / 1e6)
        ledger = json.loads(self.ledger.read_text())
        for models in ledger['files'][str(self.record)]['hours'].values():
            models['eu.anthropic.claude-opus-4-8'][6] = 0.0
        self.ledger.write_text(json.dumps(ledger))
        self.assertAlmostEqual(self.totals()[('2026-10-28', 'demo', 'eu.anthropic.claude-opus-4-8')][6], cost)
