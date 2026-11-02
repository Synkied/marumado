from unittest import mock

from django.test import TestCase

from . import recap


class RecapTests(TestCase):
    def material(self, prompts=1, commits=0):
        return {'sessions': [{'kind': 'claude', 'source': 'This machine', 'start': 1_761_000_000_000, 'prompts': ['add a button'] * prompts,
                              'files': ['src/a.tsx'], 'last': 'Done.'}] if prompts else [],
                'errors': [], 'commits': ['2026-10-30 feat: a button'] * commits, 'tasks': []}

    def test_written_and_kept_for_the_same_days(self):
        with mock.patch.object(recap, 'material', return_value=self.material(2, 1)), \
             mock.patch.object(recap, '_write', return_value='- Added a button.') as write:
            entry = recap.write('demo', '2026-10-27', '2026-11-02', 'Europe/Paris')
        self.assertEqual(entry['text'], '- Added a button.')
        self.assertEqual(entry['counts'], {'sessions': 1, 'prompts': 2, 'commits': 1, 'tasks': 0})
        self.assertIn('add a button', write.call_args[0][0])
        self.assertEqual([r['project'] for r in recap.saved('2026-10-27', '2026-11-02')], ['demo'])
        self.assertEqual(recap.saved('2026-11-01', '2026-11-02'), [])

    def test_nothing_to_go_on_asks_no_one(self):
        with mock.patch.object(recap, 'material', return_value=self.material(0, 0)), mock.patch.object(recap, '_write') as write:
            entry = recap.write('demo', '2026-11-02', '2026-11-02')
        write.assert_not_called()
        self.assertEqual(entry['text'], '')

    def test_bad_days(self):
        with self.assertRaises(ValueError):
            recap.write('demo', '2026-11-02', '2026-11-01')

    def test_brief_is_cut_to_size(self):
        m = self.material(1)
        m['sessions'][0]['prompts'] = ['x' * 700] * 200
        self.assertLessEqual(len(recap._brief('demo', '2026-11-01', '2026-11-02', m)), recap.MATERIAL + 40)
