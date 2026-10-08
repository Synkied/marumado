import base64
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from unittest import mock

from django.test import TestCase

from . import conversation, herdr, transcripts
from .models import Task

PNG = base64.b64encode(b'\x89PNG\r\n\x1a\nfake').decode()


def image_block(data=PNG, kind='image/png'):
    return {'type': 'image', 'source': {'type': 'base64', 'media_type': kind, 'data': data}}


def line(kind, content, ts='2026-10-08T10:00:00Z', **extra):
    return json.dumps({'type': kind, 'timestamp': ts, 'message': {'role': kind, 'content': content}, **extra})


class ConversationTests(TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.home = Path(folder.name)
        self.cwd = '/work/app'
        self.records = self.home / '.claude' / 'projects' / transcripts.claude_folder(self.cwd)
        self.records.mkdir(parents=True)
        self.source = herdr.Source(0, 'Local', 'env')
        self.started = None  # when the pane's agent started (unix seconds), None: can't be told
        self.pid = None  # the pane's agent's process, None: can't be told
        self.panes = [{'pane_id': 'w1:p1', 'kind': 'claude', 'cwd': self.cwd}]
        run = lambda src, script, timeout=0: subprocess.run(['sh', '-c', script], env={'HOME': str(self.home), 'PATH': '/usr/bin:/bin'},
                                                             capture_output=True).stdout
        for patch in (mock.patch.object(herdr, 'shell', side_effect=run),
                      mock.patch.object(herdr, '_list', side_effect=lambda src: {'available': True, 'agents': self.panes}),
                      mock.patch.object(herdr, 'get_source', return_value=self.source),
                      mock.patch.object(conversation, '_started', side_effect=lambda src, pane: self.started),
                      mock.patch.object(conversation, '_pid', side_effect=lambda src, pane: self.pid)):
            patch.start()
            self.addCleanup(patch.stop)
        for cache in (conversation._panes, conversation._titles, transcripts._parsers, transcripts._newest_seen, transcripts._images_read):
            cache.clear()

    def write(self, name, *lines):
        path = self.records / name
        path.write_text(''.join(f'{x}\n' for x in lines))
        return str(path)

    def test_pi_session(self):
        self.panes = [{'pane_id': 'w1:p1', 'kind': 'pi', 'cwd': self.cwd}]
        folder = self.home / '.pi' / 'agent' / 'sessions' / transcripts.pi_folder(self.cwd)
        folder.mkdir(parents=True)
        msg = lambda role, content, ts='2026-10-08T10:00:00Z', **extra: json.dumps(
            {'type': 'message', 'id': ts[-6:], 'timestamp': ts, 'message': {'role': role, 'content': content, **extra}})
        (folder / '2026-10-08T10-00-00-000Z_abc.jsonl').write_text('\n'.join([
            json.dumps({'type': 'session', 'version': 3, 'id': 'abc', 'timestamp': '2026-10-08T10:00:00Z', 'cwd': self.cwd}),
            msg('user', [{'type': 'text', 'text': 'Fix the typo'}, {'type': 'image', 'data': PNG, 'mimeType': 'image/png'}]),
            msg('assistant', [{'type': 'thinking', 'thinking': 'Look first'},
                              {'type': 'toolCall', 'id': 'c1', 'name': 'edit', 'arguments': {'path': f'{self.cwd}/a.py', 'edits': [{'oldText': 'teh', 'newText': 'the'}]}}],
                ts='2026-10-08T10:00:05Z', usage={'input': 10, 'output': 5, 'cacheRead': 100, 'cacheWrite': 0, 'totalTokens': 115}),
            msg('toolResult', [{'type': 'text', 'text': 'Successfully replaced 1 block(s)'}], ts='2026-10-08T10:00:06Z',
                toolCallId='c1', toolName='edit', isError=False, details={'diff': '   1 a\n-  2 teh\n+  2 the\n      ...'}),
            msg('assistant', [{'type': 'text', 'text': 'Fixed.'}], ts='2026-10-08T10:00:07Z'),
            json.dumps({'type': 'compaction', 'id': 'k', 'timestamp': '2026-10-08T10:00:08Z', 'summary': 'We fixed a typo.', 'tokensBefore': 50000}),
        ]) + '\n')
        data = conversation.trace('w1:p1', 0)
        self.assertTrue(data['found'])
        steps = data['steps']
        self.assertEqual([s['kind'] for s in steps], ['you', 'think', 'edit', 'say', 'compact'])
        self.assertEqual(len(steps[0]['images']), 1)
        self.assertEqual(steps[2]['title'], 'Edited a.py')
        self.assertEqual(steps[2]['files'][0], {'path': 'a.py', 'add': 1, 'del': 1})
        self.assertIn('-teh\n+the', steps[2]['detail'])
        self.assertTrue(steps[2]['ok'])
        self.assertEqual(steps[4]['title'], 'Compacted the conversation (from 50k tokens)')
        kind, body = transcripts.image(self.source, data['path'], steps[0]['images'][0])
        self.assertEqual((kind, body[:4]), ('image/png', b'\x89PNG'))

    def test_a_new_session_is_not_the_folders_last_one(self):
        old = self.write('s1.jsonl', line('user', 'An old conversation'))
        os.utime(old, (time.time() - 600, time.time() - 600))
        self.started = time.time() - 60  # the agent started after its folder's last record was written
        data = conversation.trace('w1:p1', 0)
        self.assertTrue(data['found'])
        self.assertEqual(data['steps'], [])
        # Its first prompt writes its own record, which it then shows.
        self.write('s2.jsonl', line('user', 'A new one'))
        transcripts._newest_seen.clear()
        self.assertEqual([s['title'] for s in conversation.trace('w1:p1', 0)['steps']], ['A new one'])

    def test_the_session_herdr_names(self):
        self.write('s1.jsonl', line('user', 'An old conversation'))
        named = str(self.home / '.pi' / 'agent' / 'sessions' / transcripts.pi_folder(self.cwd) / '2026-10-08T12-26-41-926Z_new.jsonl')
        self.panes = [{'pane_id': 'w1:p1', 'kind': 'pi', 'cwd': self.cwd, 'session': {'kind': 'path', 'value': named}}]
        data = conversation.trace('w1:p1', 0)  # not written yet: an empty conversation, not another one
        self.assertEqual((data['found'], data['path'], data['steps']), (True, named, []))

    def test_compaction_summary_is_not_a_prompt(self):
        self.write(
            's1.jsonl',
            line('user', 'Fix the build'),
            json.dumps({'type': 'system', 'subtype': 'compact_boundary', 'timestamp': '2026-10-08T10:01:00Z',
                        'compactMetadata': {'trigger': 'manual', 'preTokens': 362527, 'postTokens': 13323}}),
            line('user', 'This session is being continued from a previous conversation.\n\nSummary: ...', ts='2026-10-08T10:01:01Z', isCompactSummary=True),
            line('user', 'Now the tests'),
        )
        steps = conversation.trace('w1:p1', 0)['steps']
        self.assertEqual([s['kind'] for s in steps], ['you', 'compact', 'you'])
        self.assertEqual(steps[1]['title'], 'Compacted the conversation (manual, 363k → 13k tokens)')
        self.assertIn('Summary', steps[1]['detail'])

    def test_screenshot_in_a_tool_result_goes_to_its_call(self):
        path = self.write(
            's1.jsonl',
            line('user', 'Take a screenshot of the page'),
            line('assistant', [{'type': 'tool_use', 'id': 'c1', 'name': 'mcp__browser__screenshot', 'input': {}}]),
            line('user', [{'type': 'tool_result', 'tool_use_id': 'c1', 'content': [{'type': 'text', 'text': 'Done'}, image_block()]}]),
            line('assistant', [{'type': 'text', 'text': 'Here it is.'}]),
        )
        data = conversation.trace('w1:p1', 0)
        self.assertTrue(data['found'])
        self.assertEqual(data['path'], path)
        self.assertEqual(data['shared'], 1)
        tool = next(s for s in data['steps'] if s['kind'] == 'tool')
        self.assertEqual(len(tool['images']), 1)
        kind, body = conversation.image('w1:p1', 0, path, tool['images'][0])
        self.assertEqual((kind, body), ('image/png', b'\x89PNG\r\n\x1a\nfake'))
        self.assertFalse(any('images' in s for s in data['steps'] if s is not tool))

    def test_pasted_image_goes_to_the_prompt(self):
        path = self.write('s1.jsonl', line('user', [image_block(), {'type': 'text', 'text': '[Image #1] what is wrong here?'}]))
        you = conversation.trace('w1:p1', 0)['steps'][0]
        self.assertEqual(you['kind'], 'you')
        self.assertEqual(conversation.image('w1:p1', 0, path, you['images'][0])[0], 'image/png')

    def test_images_read_across_polls(self):
        path = self.write('s1.jsonl', line('user', 'hello'))
        self.assertEqual(len(conversation.trace('w1:p1', 0)['steps']), 1)
        with open(path, 'a') as f:
            f.write(line('user', [image_block(), image_block(base64.b64encode(b'second').decode(), 'image/jpeg')]) + '\n')
        step = conversation.trace('w1:p1', 0)['steps'][-1]
        self.assertEqual(len(step['images']), 2)
        self.assertEqual(conversation.image('w1:p1', 0, path, step['images'][1]), ('image/jpeg', b'second'))

    def test_last_steps_only(self):
        self.write('s1.jsonl', *[line('user', f'prompt {i}') for i in range(10)])
        data = conversation.trace('w1:p1', 0, -3)
        self.assertEqual([s['title'] for s in data['steps']], ['prompt 7', 'prompt 8', 'prompt 9'])
        self.assertEqual(data['total'], 10)

    def test_image_only_from_session_records(self):
        other = self.home / 'notes.jsonl'
        other.write_text(line('user', [image_block()]) + '\n')
        with self.assertRaises(ValueError):
            conversation.image('w1:p1', 0, str(other), '0.0')
        with self.assertRaises(ValueError):
            conversation.image('w1:p1', 0, str(self.records / '..' / '..' / 'x.jsonl'), '0.0')
        path = self.write('s1.jsonl', line('user', [image_block(kind='text/html')]))
        with self.assertRaises(ValueError):
            conversation.image('w1:p1', 0, path, '0.0')

    def test_codex_after_clear(self):
        """A /clear starts a thread Codex writes only with the next prompt: an empty conversation, not the last one."""
        self.panes = [{'pane_id': 'w1:p1', 'kind': 'codex', 'cwd': self.cwd}]
        day = self.home / '.codex' / 'sessions' / '2026' / '10' / '08'
        day.mkdir(parents=True)
        meta = json.dumps({'type': 'session_meta', 'timestamp': '2026-10-08T10:00:00Z', 'payload': {'id': 'old', 'cwd': self.cwd}})
        (day / 'rollout-2026-10-08T10-00-00-0000aaaa-old.jsonl').write_text(meta + '\n')
        locks = self.home / '.codex' / 'thread-writer-locks'
        locks.mkdir(parents=True)
        lock = locks / '0000bbbb-0000-7000-8000-000000000001.lock'
        lock.touch()
        child = subprocess.Popen(['sh', '-c', f'exec 9<"{lock}"; exec sleep 30'])
        self.addCleanup(child.wait)
        self.addCleanup(child.kill)
        for _ in range(50):  # until it holds the lock
            if any(os.path.realpath(f'/proc/{child.pid}/fd/{fd}') == str(lock) for fd in os.listdir(f'/proc/{child.pid}/fd')):
                break
            time.sleep(0.02)
        self.pid = child.pid
        data = conversation.trace('w1:p1', 0)
        self.assertEqual((data['found'], data['path'], data['steps'], data['sure']), (True, '', [], True))
        # Its first prompt writes the thread's record, which it then shows.
        new = day / 'rollout-2026-10-08T10-05-00-0000bbbb-0000-7000-8000-000000000001.jsonl'
        new.write_text(meta + '\n')
        self.assertEqual(conversation.trace('w1:p1', 0)['path'], str(new))

    def test_claude_after_clear(self):
        """Claude Code names its session in ~/.claude/sessions/<pid>.json, a new one at once after /clear."""
        self.write('s1.jsonl', line('user', 'An old conversation'))
        sessions = self.home / '.claude' / 'sessions'
        sessions.mkdir(parents=True)
        pid = os.getpid()
        start = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
        mine = {'pid': pid, 'sessionId': '0d9da46f-33e1-412f-9eb9-f509c4c43d7f', 'cwd': self.cwd, 'procStart': start}
        (sessions / f'{pid}.json').write_text(json.dumps(mine))
        self.pid = pid
        data = conversation.trace('w1:p1', 0)
        self.assertEqual((data['path'], data['steps']), (str(self.records / f"{mine['sessionId']}.jsonl"), []))
        # One left by an earlier process of that id is not its own.
        (sessions / f'{pid}.json').write_text(json.dumps({**mine, 'procStart': '1'}))
        self.assertEqual(conversation.trace('w1:p1', 0)['path'], str(self.records / 's1.jsonl'))

    def test_two_agents_in_one_folder(self):
        old = self.write('old.jsonl', line('user', 'task prompt'))
        self.write('new.jsonl', line('user', 'other prompt'))
        os.utime(old, (time.time() - 120, time.time() - 120))
        self.panes = [{'pane_id': 'w1:p1', 'kind': 'claude', 'cwd': self.cwd}, {'pane_id': 'w1:p2', 'kind': 'claude', 'cwd': self.cwd}]
        Task.objects.create(title='t', pane_id='w1:p1', agent_source=0, live=True, transcript=old)
        self.assertEqual(conversation.trace('w1:p1', 0)['path'], old)
        mine = conversation.trace('w1:p2', 0)
        self.assertEqual((mine['path'], mine['shared'], mine['sure']), (str(self.records / 'new.jsonl'), 2, False))

    def test_two_agents_told_apart_by_their_titles(self):
        first = self.write('a.jsonl', line('user', 'first'), json.dumps({'type': 'ai-title', 'aiTitle': 'Fix the "login" page'}))
        second = self.write('b.jsonl', line('user', 'second'), json.dumps({'type': 'ai-title', 'aiTitle': 'Web terminal'}))
        os.utime(first, (time.time() - 120, time.time() - 120))
        self.panes = [{'pane_id': 'w1:p1', 'kind': 'claude', 'cwd': self.cwd, 'title': 'Fix the "login" page'},
                      {'pane_id': 'w1:p2', 'kind': 'claude', 'cwd': self.cwd, 'title': 'Web terminal'},
                      {'pane_id': 'w1:p3', 'kind': 'claude', 'cwd': self.cwd, 'title': 'Claude Code'}]
        one, two = conversation.trace('w1:p1', 0), conversation.trace('w1:p2', 0)
        self.assertEqual((one['path'], one['sure'], one['shared']), (first, True, 3))
        self.assertEqual((two['path'], two['sure']), (second, True))
        # Not named yet: a guess, among the records no other agent here is named after (none left: the newest).
        self.assertEqual(conversation.trace('w1:p3', 0)['sure'], False)

    def test_command_and_output_apart(self):
        self.write(
            's1.jsonl',
            line('assistant', [{'type': 'tool_use', 'id': 'c1', 'name': 'Bash', 'input': {'command': 'printf "a\\n\\nb"', 'description': 'Print'}}]),
            line('user', [{'type': 'tool_result', 'tool_use_id': 'c1', 'content': 'a\n\nb'}], toolUseResult={'stdout': 'a\n\nb', 'stderr': ''}),
        )
        run = conversation.trace('w1:p1', 0)['steps'][0]
        self.assertEqual(run['detail'][:run['cut']], '$ printf "a\\n\\nb"')
        self.assertEqual(run['detail'][run['cut']:].strip(), 'a\n\nb')

    def test_plain_terminal(self):
        self.panes = [{'pane_id': 'w1:p1', 'kind': 'terminal', 'cwd': self.cwd}]
        self.assertFalse(conversation.trace('w1:p1', 0)['found'])
