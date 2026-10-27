import json
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
        ledger = json.loads((self.home / '.agents' / 'marumado' / 'usage.json').read_text())
        self.assertIn(str(self.record), ledger['files'])

        self.record.unlink()
        self.assertEqual(self.totals(), rows)
        ledger = json.loads((self.home / '.agents' / 'marumado' / 'usage.json').read_text())
        self.assertEqual(ledger['files'], {})
        self.assertIn('claude\t-projects-demo', ledger['gone'])
