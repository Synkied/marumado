"""What a coding agent thought and did, read from the record it keeps of its session.

Claude Code writes every session to ~/.claude/projects/<its folder, dashed>/<session>.jsonl, Codex to
~/.codex/sessions/<date>/rollout-*.jsonl, and Pi to ~/.pi/agent/sessions/--<its folder, dashed>--/<time>_<id>.jsonl:
one JSON object per line, with its thinking, what it said, every tool it called and what came back. The terminal only shows the end of that; this reads all of it.

The files are where the agent runs, so they are read with a small shell script through the agent's source (this
machine, a VM or an SSH host: herdr.shell). An agent on a machine in Machines is read by that machine's Marumado
(the agents/trace endpoint). Each record is read once: a Parser per file remembers how far it got, and each poll
reads only what the agent wrote since.

A trace is a list of steps, oldest first. Each step is one thing the agent did, in one of these kinds:
  think   thinking, or a plan it wrote down        say     what it told you
  read    reading files or listing folders         search  searching the code or the web
  edit    changing files                           run     running a command
  agent   handing part of the work to a sub-agent  tool    any other tool
  you     what it was told (your prompts)          ask     a question it asked you
  compact the conversation compacted into a summary (Claude Code writes it as your prompt; it is not yours)

A step may carry `images`: the screenshots and pictures in it (a tool's result, a prompt you pasted one into), as
ids `<offset>.<n>`, the n-th image of the line at that byte offset of the record. They stay in the record and are
read one at a time when shown (image()).
"""
import base64
import json
import re
import shlex
import threading
import time
from collections import OrderedDict
from datetime import datetime

from . import herdr, usage

KINDS = ('claude', 'codex', 'pi')
MAX_READ = 8 * 1024 * 1024  # read at most this much of a record per poll
TEXT = 6000  # how much of a thought, a message or a command's output a step keeps
SAY = 24000  # how much of what it told you, or you told it, a step keeps
DIFF_LINES = 400
SLACK = 120  # seconds: clocks on another machine may be a little off
FIND_EVERY = 5  # seconds between two looks for a record not found yet


def _ms(ts: str) -> int:
    try:
        return int(datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp() * 1000)
    except (ValueError, AttributeError, TypeError):
        return 0


def clip(text: str, n: int = TEXT) -> str:
    """The start and the end of a long text, which is where commands say what went wrong."""
    text = (text or '').strip('\n')
    if len(text) <= n:
        return text
    head, tail = text[: n * 2 // 3], text[-(n // 3):]
    return f'{head}\n… {len(text) - len(head) - len(tail):,} characters left out …\n{tail}'


def first_line(text: str, n: int = 140) -> str:
    line = next((x.strip() for x in (text or '').splitlines() if x.strip()), '')
    line = re.sub(r'^[#>*\s-]+', '', line).replace('**', '').replace('`', '')
    return line if len(line) <= n else line[: n - 1].rstrip() + '…'


def _images(node):
    """The images in a piece of a record, in order: (media type, base64 data)."""
    if isinstance(node, dict):
        source = node.get('source')
        if node.get('type') == 'image' and isinstance(source, dict) and source.get('type') == 'base64':
            yield source.get('media_type') or 'image/png', source.get('data') or ''
            return
        if node.get('type') == 'image' and isinstance(node.get('data'), str):  # Pi
            yield node.get('mimeType') or 'image/png', node['data']
            return
        url = node.get('image_url')
        if node.get('type') == 'input_image' and isinstance(url, str) and url.startswith('data:'):
            head, _, data = url.partition(',')
            yield head[5:].split(';')[0] or 'image/png', data
            return
        for value in node.values():
            yield from _images(value)
    elif isinstance(node, list):
        for value in node:
            yield from _images(value)


def _image_blocks(kind: str, r: dict) -> list:
    """Where a record's images are, block by block: Claude Code's and Pi's message content, or Codex's payload."""
    if kind == 'pi':
        content = (r.get('message') or {}).get('content') if r.get('type') == 'message' else None
        return content if isinstance(content, list) else []
    if kind == 'claude':
        if r.get('type') not in ('user', 'assistant') or r.get('isSidechain'):
            return []
        content = (r.get('message') or {}).get('content')
        return content if isinstance(content, list) else []
    return [r.get('payload')] if r.get('type') == 'response_item' else []


def needle(title: str) -> str:
    """A piece of the task's title to find its prompt by, made of characters JSON writes as they are."""
    m = re.match(r"[A-Za-z0-9 ,.:;_()/'-]+", title.strip())
    piece = (m.group(0) if m else '').strip()[:48].strip()
    return piece if len(piece) >= 6 else ''


# ---------------------------------------------------------------- reading a command

_READERS = {'cat', 'head', 'tail', 'less', 'more', 'ls', 'tree', 'wc', 'nl', 'stat', 'file', 'pwd', 'bat', 'jq', 'du'}
_SEARCHERS = {'rg', 'grep', 'egrep', 'find', 'fd', 'ag', 'ack', 'locate'}
_GIT_READS = {'log', 'show', 'diff', 'status', 'blame', 'grep', 'branch', 'rev-parse', 'ls-files'}


def command_kind(command: str) -> str:
    """run, or read/search for a command that only looks (cat, sed -n, rg, git log…), judged by its first word."""
    first = re.split(r'\s*(?:&&|;|\|\|?)\s*', command.strip())
    words = []
    for part in first:
        try:
            words = shlex.split(part)
        except ValueError:
            words = part.split()
        if words and words[0] not in ('cd', 'export', 'set', 'source', '.'):
            break
    if not words:
        return 'run'
    word = words[0].rsplit('/', 1)[-1]
    if word in _READERS or (word == 'sed' and '-n' in words) or (word == 'git' and len(words) > 1 and words[1] in _GIT_READS):
        return 'read'
    return 'search' if word in _SEARCHERS else 'run'


def _patch_counts(lines: list[str]) -> tuple[int, int]:
    return (sum(1 for x in lines if x.startswith('+') and not x.startswith('+++')),
            sum(1 for x in lines if x.startswith('-') and not x.startswith('---')))


def _hunks_text(hunks: list[dict]) -> list[str]:
    out = []
    for h in hunks or []:
        out.append(f"@@ -{h.get('oldStart', 0)},{h.get('oldLines', 0)} +{h.get('newStart', 0)},{h.get('newLines', 0)} @@")
        out.extend(h.get('lines') or [])
    return out


def _clip_lines(lines: list[str]) -> str:
    if len(lines) <= DIFF_LINES:
        return '\n'.join(lines)
    return '\n'.join([*lines[:DIFF_LINES], f'… {len(lines) - DIFF_LINES} more lines'])


def apply_patch_files(patch: str) -> tuple[list[dict], str]:
    """The files a Codex apply_patch changes, with the lines it adds and removes in each."""
    files: list[dict] = []
    lines: list[str] = []
    for line in (patch or '').splitlines():
        m = re.match(r'\*\*\* (Add|Update|Delete) File: (.+)', line)
        if m:
            files.append({'path': m.group(2).strip(), 'add': 0, 'del': 0, 'op': m.group(1).lower()})
            lines.append(f'@@ {m.group(1).lower()} {m.group(2).strip()}')
            continue
        if line.startswith('***') or not files:
            continue
        lines.append(line)
        if line.startswith('+'):
            files[-1]['add'] += 1
        elif line.startswith('-'):
            files[-1]['del'] += 1
    return files, _clip_lines(lines)


# ---------------------------------------------------------------- parsing

class Parser:
    """Turns a session record into steps, a few lines at a time as the agent writes them."""

    def __init__(self, kind: str, cwd: str):
        self.kind, self.cwd = kind, cwd.rstrip('/')
        self.offset = 0
        self.buf = b''
        self.steps: list[dict] = []
        self.open: dict[str, dict] = {}  # tool calls waiting for their result, by call id
        self.called: dict[str, dict] = {}  # every tool call's step, by call id (for the images in its result)
        self.prev = 0  # when the last record was written
        self.compacted: dict | None = None  # Claude Code: how its last compaction went, until its summary comes
        # What each model call used (usage.py), by message id, in the order they came; and how full the agent's
        # context was at its last call of its own (not a sub-agent's): {t, tokens, window}.
        self.calls: dict[str, list] = {}
        self.context: dict | None = None
        self._totals: dict = {}  # Codex: the session's running totals, to tell what each call added
        self._model = ''  # Codex: the model of the current turn
        self.lock = threading.Lock()

    # The first step that may still change: everything before it is final.
    def settled(self) -> int:
        return min((s['i'] for s in self.open.values()), default=len(self.steps))

    def feed(self, data: bytes) -> None:
        at = self.offset - len(self.buf)  # where the first line starts in the record
        self.offset += len(data)
        lines = (self.buf + data).split(b'\n')
        self.buf = lines.pop()
        for raw in lines:
            line_at, at = at, at + len(raw) + 1
            if not raw.strip():
                continue
            try:
                record = json.loads(raw)
            except ValueError:
                continue
            if isinstance(record, dict):
                before = len(self.steps)
                usage_of, steps_of = {'claude': (self._claude_usage, self._claude), 'pi': (self._pi_usage, self._pi)}.get(
                    self.kind, (self._codex_usage, self._codex))
                try:
                    usage_of(record)
                except (KeyError, TypeError, AttributeError, ValueError):
                    pass
                try:
                    steps_of(record)
                except (KeyError, TypeError, AttributeError, ValueError):
                    continue  # a record of a shape this doesn't know: skip it, keep the rest
                if b'"image' in raw or b'input_image' in raw:
                    try:
                        self._attach_images(record, line_at, before)
                    except (KeyError, TypeError, AttributeError, ValueError):
                        pass

    def _attach_images(self, r: dict, at: int, before: int) -> None:
        """Give the record's images to their steps: a tool's result to its call, the rest to what this record added
        (your prompt), or else to the step before (Codex shows an image it was asked to look at as a message)."""
        n = 0
        for block in _image_blocks(self.kind, r):
            found = sum(1 for _ in _images(block))
            if not found:
                continue
            ids = [f'{at}.{n + k}' for k in range(found)]
            n += found
            step = None
            if isinstance(block, dict) and block.get('type') == 'tool_result':
                step = self.called.get(block.get('tool_use_id', ''))
            if step is None and len(self.steps) > before:
                step = self.steps[-1]
            if step is None and self.steps and self.steps[-1]['kind'] not in ('say', 'think', 'you', 'compact'):
                step = self.steps[-1]
            if step is None:
                t = _ms(r.get('timestamp', ''))
                step = self.add('you', t, 'Sent an image' if found == 1 else f'Sent {found} images', end=t)
            step.setdefault('images', []).extend(ids)

    def rel(self, path: str) -> str:
        path = path or ''
        if self.cwd and path.startswith(self.cwd + '/'):
            return path[len(self.cwd) + 1:]
        return path

    def add(self, kind: str, t: int, title: str, detail: str = '', end: int | None = None, ok: bool | None = None,
            files: list[dict] | None = None, call: str = '', sub: str = '') -> dict:
        step = {'i': len(self.steps), 'kind': kind, 't': t, 'end': end, 'title': title, 'detail': detail, 'ok': ok}
        if files:
            step['files'] = files
        if sub:
            step['sub'] = sub
        self.steps.append(step)
        if call:
            self.open[call] = self.called[call] = step
        return step

    def close(self, call: str, t: int, ok: bool | None, detail: str = '') -> dict | None:
        step = self.open.pop(call, None)
        if step is None:
            return None
        step['end'] = max(t, step['t'])
        step['ok'] = ok
        if detail:
            # Where what came back begins (`cut`), so a command and its output can be shown apart.
            step['cut'] = len(step['detail']) if step['detail'] else 0
            step['detail'] = f"{step['detail']}\n\n{detail}".strip() if step['detail'] else detail
        return step

    def prompt(self, t: int, text: str) -> None:
        text = (text or '').strip()
        if not text or text.startswith(('<', 'Caveat:', '# AGENTS.md instructions')):
            return  # what the agent's own tooling adds: reminders, command output, environment notes, AGENTS.md
        if text.startswith('[Request interrupted'):
            self.add('you', t, 'Interrupted', end=t)
            return
        self.add('you', t, first_line(text), clip(text, SAY), end=t)

    def compact(self, t: int, text: str, meta: dict) -> None:
        """The conversation compacted into a summary: how (auto or by /compact) and how many tokens it went from and to."""
        how = [meta.get('trigger') or '']
        before, after = meta.get('preTokens'), meta.get('postTokens')
        if isinstance(before, int) and isinstance(after, int):
            how.append(f'{round(before / 1000)}k → {round(after / 1000)}k tokens')
        elif isinstance(before, int):
            how.append(f'from {round(before / 1000)}k tokens')
        how = ', '.join(h for h in how if h)
        title = f'Compacted the conversation ({how})' if how else 'Compacted the conversation'
        text = (text or '').strip()
        self.add('compact', t, title, clip(text, SAY), end=t)

    def usage(self, since: int | None = None) -> dict:
        """What the session used from `since` (ms) on: usage.total of its model calls."""
        return usage.total((e for e in self.calls.values() if since is None or e[0] >= since), self.context)

    # ---- Claude Code

    def _claude_usage(self, r: dict) -> None:
        """Claude Code writes a reply once per block, each line with the usage so far: the largest numbers count."""
        msg = r.get('message') or {}
        u = msg.get('usage')
        if r.get('type') != 'assistant' or not isinstance(u, dict) or msg.get('model') == '<synthetic>':
            return
        key = msg.get('id') or r.get('uuid') or str(len(self.calls))
        split = u.get('cache_creation') if isinstance(u.get('cache_creation'), dict) else {}
        write_1h = int(split.get('ephemeral_1h_input_tokens') or 0)
        write = int(u.get('cache_creation_input_tokens') or 0) - write_1h
        entry = [_ms(r.get('timestamp', '')), msg.get('model') or '', int(u.get('input_tokens') or 0), max(write, 0), write_1h,
                 int(u.get('cache_read_input_tokens') or 0), int(u.get('output_tokens') or 0), u.get('speed') == 'fast']
        old = self.calls.get(key)
        if old:
            entry = [old[0], old[1] or entry[1], *(max(a, b) for a, b in zip(old[2:7], entry[2:7])), old[7] or entry[7]]
        self.calls[key] = entry
        if not r.get('isSidechain'):
            self.context = {'t': entry[0], 'tokens': entry[2] + entry[3] + entry[4] + entry[5], 'window': None}

    def _claude(self, r: dict) -> None:
        if r.get('type') == 'system' and r.get('subtype') == 'compact_boundary':
            self.compacted = r.get('compactMetadata') or {}
            return
        attached = r.get('attachment') if r.get('type') == 'attachment' and not r.get('isSidechain') else None
        if isinstance(attached, dict) and attached.get('type') == 'queued_command' and attached.get('commandMode') == 'prompt':
            # What you sent while it worked, taken in mid-turn: written as an attachment, not as a message of yours.
            t = _ms(r.get('timestamp', ''))
            self.prev = t
            self.prompt(t, attached.get('prompt') if isinstance(attached.get('prompt'), str) else '')
            return
        if r.get('type') not in ('user', 'assistant') or r.get('isSidechain') or r.get('isMeta'):
            return
        t = _ms(r.get('timestamp', ''))
        prev, self.prev = self.prev or t, t
        content = (r.get('message') or {}).get('content')
        if r['type'] == 'user':
            if r.get('isCompactSummary'):
                # Written as if you sent it, but it is Claude Code's summary of the conversation so far.
                text = content if isinstance(content, str) else '\n'.join(b.get('text', '') for b in content or [] if b.get('type') == 'text')
                self.compact(t, text, self.compacted or {})
                self.compacted = None
                return
            if isinstance(content, str):
                self.prompt(t, content)
                return
            for block in content or []:
                if block.get('type') == 'tool_result':
                    self._claude_result(block, r.get('toolUseResult'), t)
                elif block.get('type') == 'text':
                    self.prompt(t, block.get('text', ''))
            return
        for block in content or []:
            kind = block.get('type')
            if kind == 'thinking':
                text = block.get('thinking') or ''
                took = r.get('thinkingDurationMs')
                start = t - int(took) if isinstance(took, (int, float)) else prev
                self.add('think', start, first_line(text) or 'Thought', clip(text), end=t)
            elif kind == 'text' and (block.get('text') or '').strip():
                text = block['text']
                self.add('say', prev, first_line(text), clip(text, SAY), end=t)
            elif kind == 'tool_use':
                self._claude_tool(block, t)

    def _claude_tool(self, b: dict, t: int) -> None:
        name, x, call = b.get('name', ''), b.get('input') or {}, b.get('id', '')
        path = self.rel(x.get('file_path') or x.get('notebook_path') or x.get('path') or '')
        if name in ('Read', 'NotebookRead'):
            self.add('read', t, f'Read {path}', call=call, files=[{'path': path}])
        elif name == 'LS':
            self.add('read', t, f'Listed {path or "the folder"}', call=call)
        elif name in ('Grep', 'Glob'):
            what = x.get('pattern', '')
            where = f' in {path}' if path else ''
            self.add('search', t, f'Searched for “{what}”{where}' if name == 'Grep' else f'Looked for {what}{where}', call=call)
        elif name in ('Edit', 'MultiEdit', 'Write', 'NotebookEdit'):
            verb = 'Wrote' if name == 'Write' else 'Edited'
            self.add('edit', t, f'{verb} {path}', call=call, files=[{'path': path, 'add': 0, 'del': 0}])
            self._claude_edit_guess(self.open[call], name, x)
        elif name == 'Bash':
            command = x.get('command', '')
            self.add(command_kind(command), t, first_line(x.get('description') or '') or first_line(command),
                     f'$ {command}', call=call, sub=first_line(command, 200) if x.get('description') else '')
        elif name in ('WebFetch', 'WebSearch'):
            self.add('search', t, f"Searched the web for “{x.get('query', '')}”" if name == 'WebSearch' else f"Read {x.get('url', '')}", call=call)
        elif name in ('Task', 'Agent'):
            self.add('agent', t, f"Sub-agent: {x.get('description') or first_line(x.get('prompt', ''))}", clip(x.get('prompt', '')), call=call)
        elif name == 'TodoWrite':
            marks = {'completed': '[x]', 'in_progress': '[>]', 'pending': '[ ]'}
            todos = x.get('todos') or []
            done = sum(1 for d in todos if d.get('status') == 'completed')
            self.add('think', t, f'Updated its plan · {done} of {len(todos)} done',
                     '\n'.join(f"{marks.get(d.get('status'), '[ ]')} {d.get('content', '')}" for d in todos), call=call)
        elif name == 'ExitPlanMode':
            self.add('think', t, 'Wrote a plan', clip(x.get('plan', '')), call=call)
        elif name == 'AskUserQuestion':
            qs = x.get('questions') or []
            self.add('ask', t, first_line(qs[0].get('question', '')) if qs else 'Asked you something',
                     '\n'.join(q.get('question', '') for q in qs), call=call)
        else:
            shown = name.removeprefix('mcp__').replace('__', ' · ')
            self.add('tool', t, f'Used {shown}', clip(json.dumps(x, ensure_ascii=False, indent=1), 1500), call=call)

    def _claude_edit_guess(self, step: dict, name: str, x: dict) -> None:
        """The change as the agent asked for it, until the result says what it really was."""
        if name == 'Write':
            lines = [f'+{line}' for line in (x.get('content') or '').splitlines()]
        else:
            edits = x.get('edits') or [x]
            lines = []
            for e in edits:
                lines += [f'-{line}' for line in (e.get('old_string') or '').splitlines()]
                lines += [f'+{line}' for line in (e.get('new_string') or e.get('new_source') or '').splitlines()]
        step['files'][0]['add'], step['files'][0]['del'] = _patch_counts(lines)
        step['detail'] = _clip_lines(lines)

    def _claude_result(self, block: dict, result, t: int) -> None:
        call = block.get('tool_use_id', '')
        step = self.open.get(call)
        if step is None:
            return
        content = block.get('content')
        if isinstance(content, list):
            content = '\n'.join(c.get('text', '') for c in content if isinstance(c, dict) and c.get('type') == 'text')
        text = content if isinstance(content, str) else ''
        error = bool(block.get('is_error'))
        if step['kind'] == 'edit':
            if isinstance(result, dict) and not error:
                lines = _hunks_text(result.get('structuredPatch') or [])
                if not lines and result.get('type') == 'create':
                    lines = [f'+{line}' for line in (result.get('content') or '').splitlines()]
                if lines:
                    step['files'][0]['add'], step['files'][0]['del'] = _patch_counts(lines)
                    step['detail'] = _clip_lines(lines)
            self.close(call, t, not error, clip(text, 1500) if error else '')
            return
        if step['kind'] in ('read',) and step.get('files'):
            self.close(call, t, not error, clip(text, 1500) if error else '')
            return
        if isinstance(result, dict) and ('stdout' in result or 'stderr' in result):
            out = '\n'.join(filter(None, [result.get('stdout', ''), result.get('stderr', '')]))
            text = out or text
            changed = (result.get('bashEditDiff') or {}).get('files') or []
            if changed:
                step['files'] = []
                for f in changed:
                    a, d = _patch_counts(_hunks_text(f.get('hunks') or []))
                    step['files'].append({'path': self.rel(f.get('filePath', '')), 'add': a, 'del': d})
        if step['kind'] == 'run' and not error:
            m = re.match(r'Exit code (\d+)', text or '')
            error = bool(m and m.group(1) != '0')
        self.close(call, t, not error, clip(text) if text.strip() else '')

    # ---- Codex

    def _codex_usage(self, r: dict) -> None:
        """Codex reports the session's running totals after each call: what a call used is what the totals grew by."""
        p = r.get('payload') or {}
        if r.get('type') == 'turn_context':
            self._model = p.get('model') or self._model
            return
        if r.get('type') != 'event_msg' or p.get('type') != 'token_count' or not isinstance(p.get('info'), dict):
            return
        info = p['info']
        now = info.get('total_token_usage') or {}
        grew = {k: int(now.get(k) or 0) - int(self._totals.get(k) or 0) for k in ('input_tokens', 'cached_input_tokens', 'output_tokens')}
        if any(v < 0 for v in grew.values()):  # the totals started again
            grew = {k: int(now.get(k) or 0) for k in grew}
        self._totals = now
        t = _ms(r.get('timestamp', ''))
        if any(grew.values()):
            cached = grew['cached_input_tokens']
            self.calls[str(len(self.calls))] = [t, self._model, max(grew['input_tokens'] - cached, 0), 0, 0, cached, grew['output_tokens'], False]
        last = info.get('last_token_usage') or {}
        if last.get('input_tokens'):
            self.context = {'t': t, 'tokens': int(last['input_tokens']), 'window': info.get('model_context_window') or None}

    def _codex(self, r: dict) -> None:
        t = _ms(r.get('timestamp', ''))
        p = r.get('payload') or {}
        if r.get('type') == 'session_meta':
            self.cwd = (p.get('cwd') or self.cwd).rstrip('/')
            return
        if r.get('type') == 'compacted':
            self.compact(t, p.get('message') or '', {})
            return
        if r.get('type') != 'response_item':
            return  # event_msg and turn_context repeat what the response items say
        prev, self.prev = self.prev or t, t
        kind = p.get('type')
        if kind == 'message':
            text = '\n'.join(c.get('text', '') for c in p.get('content') or [] if isinstance(c, dict))
            if p.get('role') == 'user':
                self.prompt(t, text)
            elif p.get('role') == 'assistant' and text.strip():
                self.add('say', prev, first_line(text), clip(text, SAY), end=t)
        elif kind == 'reasoning':
            text = '\n\n'.join(s.get('text', '') for s in p.get('summary') or [] if isinstance(s, dict))
            self.add('think', prev, first_line(text) or 'Thought', clip(text), end=t)
        elif kind in ('function_call', 'custom_tool_call', 'local_shell_call'):
            self._codex_call(p, t)
        elif kind in ('function_call_output', 'custom_tool_call_output', 'local_shell_call_output'):
            self._codex_output(p, t)

    def _codex_call(self, p: dict, t: int) -> None:
        name, call = p.get('name', ''), p.get('call_id') or p.get('id') or ''
        if p.get('type') == 'custom_tool_call':
            args = {'input': p.get('input', '')}
        elif p.get('type') == 'local_shell_call':
            args = {'command': (p.get('action') or {}).get('command') or []}
            name = 'shell'
        else:
            try:
                args = json.loads(p.get('arguments') or '{}')
            except ValueError:
                args = {'input': p.get('arguments', '')}
        if name == 'apply_patch':
            files, diff = apply_patch_files(args.get('input') or args.get('patch') or '')
            for f in files:
                f['path'] = self.rel(f['path'])
            title = f"Edited {files[0]['path']}" if files else 'Edited files'
            if len(files) > 1:
                title += f' +{len(files) - 1} more'
            self.add('edit', t, title, diff, call=call, files=[{k: f[k] for k in ('path', 'add', 'del')} for f in files])
            return
        if name in ('shell', 'container.exec', 'exec_command', 'shell_command'):
            command = args.get('command') if name != 'exec_command' else args.get('cmd')
            if isinstance(command, list):
                command = command[2] if len(command) >= 3 and command[1] in ('-lc', '-c') else shlex.join(command)
            command = command or ''
            self.add(command_kind(command), t, first_line(command), f'$ {command}', call=call)
            return
        if name == 'write_stdin':
            self.add('run', t, 'Typed into a running command', clip(args.get('chars', ''), 500), call=call)
            return
        if name == 'update_plan':
            marks = {'completed': '[x]', 'in_progress': '[>]', 'pending': '[ ]'}
            plan = args.get('plan') or []
            done = sum(1 for s in plan if s.get('status') == 'completed')
            text = '\n'.join(f"{marks.get(s.get('status'), '[ ]')} {s.get('step', '')}" for s in plan)
            self.add('think', t, f'Updated its plan · {done} of {len(plan)} done', '\n\n'.join(filter(None, [args.get('explanation', ''), text])), call=call)
            return
        if name in ('web_search', 'web.run'):
            self.add('search', t, f"Searched the web for “{args.get('query', '')}”", call=call)
            return
        self.add('tool', t, f'Used {name}', clip(json.dumps(args, ensure_ascii=False, indent=1), 1500), call=call)

    def _codex_output(self, p: dict, t: int) -> None:
        call = p.get('call_id') or ''
        out = p.get('output', '')
        code = None
        if isinstance(out, str):
            try:
                parsed = json.loads(out)
            except ValueError:
                parsed = None
            if isinstance(parsed, dict) and 'output' in parsed:
                out = parsed.get('output') or ''
                code = (parsed.get('metadata') or {}).get('exit_code')
        elif isinstance(out, dict):
            code, out = (out.get('metadata') or {}).get('exit_code'), out.get('output', '')
        out = out if isinstance(out, str) else json.dumps(out)
        if code is None:
            m = re.search(r'(?:Exit code:|exited with code) (\d+)', out[:400])
            code = int(m.group(1)) if m else None
        step = self.open.get(call)
        if step is None:
            return
        ok = code in (None, 0) and not out.startswith('Error') if step['kind'] != 'edit' else not out.lower().startswith(('error', 'failed'))
        self.close(call, t, ok, clip(out) if step['kind'] != 'edit' or not ok else '')


    # ---- Pi

    def _pi_usage(self, r: dict) -> None:
        """Pi writes each model call's usage on its reply (and some on `usage` entries, cache warming, say)."""
        m = r.get('message') or {}
        if r.get('type') == 'usage':
            u, model = r.get('usage') or {}, r.get('model') or ''
        elif r.get('type') == 'message' and m.get('role') == 'assistant':
            u, model = m.get('usage') or {}, m.get('model') or ''
        else:
            return
        if not isinstance(u, dict) or not u.get('totalTokens'):
            return
        t = _ms(r.get('timestamp', ''))
        write_1h = int(u.get('cacheWrite1h') or 0)
        entry = [t, model, int(u.get('input') or 0), max(int(u.get('cacheWrite') or 0) - write_1h, 0), write_1h,
                 int(u.get('cacheRead') or 0), int(u.get('output') or 0), False]
        self.calls[r.get('id') or str(len(self.calls))] = entry
        if r.get('type') == 'message':
            self.context = {'t': t, 'tokens': entry[2] + entry[3] + entry[4] + entry[5], 'window': None}

    def _pi(self, r: dict) -> None:
        kind = r.get('type')
        t = _ms(r.get('timestamp', ''))
        if kind == 'session':
            self.cwd = (r.get('cwd') or self.cwd).rstrip('/')
            return
        if kind == 'compaction':
            self.compact(t, r.get('summary') or '', {'preTokens': r.get('tokensBefore')})
            return
        if kind != 'message':
            return  # model and thinking changes, labels, extensions' state
        m = r.get('message') or {}
        role, content = m.get('role'), m.get('content')
        prev, self.prev = self.prev or t, t
        if role == 'user':
            text = content if isinstance(content, str) else '\n'.join(b.get('text', '') for b in content or [] if b.get('type') == 'text')
            self.prompt(t, text)
        elif role == 'assistant':
            for block in content or []:
                b = block.get('type')
                if b == 'thinking' and (block.get('thinking') or '').strip():
                    self.add('think', prev, first_line(block['thinking']) or 'Thought', clip(block['thinking']), end=t)
                elif b == 'text' and (block.get('text') or '').strip():
                    self.add('say', prev, first_line(block['text']), clip(block['text'], SAY), end=t)
                elif b == 'toolCall':
                    self._pi_tool(block, t)
            if m.get('stopReason') == 'error' and m.get('errorMessage'):
                self.add('say', t, f"Stopped: {first_line(m['errorMessage'])}", clip(m['errorMessage'], 1500), end=t, ok=False)
        elif role == 'toolResult':
            self._pi_result(m, t)
        elif role == 'bashExecution':
            # A command you ran yourself (`!ls`), not one it called.
            command = m.get('command') or ''
            step = self.add(command_kind(command), t, first_line(command), f'$ {command}', end=t,
                            ok=not m.get('cancelled') and m.get('exitCode') in (0, None))
            step['cut'] = len(step['detail'])
            if (m.get('output') or '').strip():
                step['detail'] += f"\n\n{clip(m['output'])}"

    def _pi_tool(self, b: dict, t: int) -> None:
        name, x, call = b.get('name', ''), b.get('arguments') or {}, b.get('id', '')
        path = self.rel(x.get('path') or x.get('file_path') or '')
        if name == 'read':
            self.add('read', t, f'Read {path}', call=call, files=[{'path': path}])
        elif name == 'ls':
            self.add('read', t, f'Listed {path or "the folder"}', call=call)
        elif name in ('grep', 'find'):
            what = x.get('pattern') or x.get('query') or ''
            where = f' in {path}' if path else ''
            self.add('search', t, f'Searched for “{what}”{where}' if name == 'grep' else f'Looked for {what}{where}', call=call)
        elif name in ('edit', 'write'):
            if name == 'write':
                lines = [f'+{line}' for line in (x.get('content') or '').splitlines()]
            else:
                lines = []
                for e in x.get('edits') or [x]:
                    lines += [f'-{line}' for line in (e.get('oldText') or '').splitlines()]
                    lines += [f'+{line}' for line in (e.get('newText') or '').splitlines()]
            a, d = _patch_counts(lines)
            self.add('edit', t, f"{'Wrote' if name == 'write' else 'Edited'} {path}", _clip_lines(lines), call=call,
                     files=[{'path': path, 'add': a, 'del': d}])
        elif name == 'bash':
            command = x.get('command', '')
            self.add(command_kind(command), t, first_line(command), f'$ {command}', call=call)
        else:
            self.add('tool', t, f'Used {name}', clip(json.dumps(x, ensure_ascii=False, indent=1), 1500), call=call)

    def _pi_result(self, m: dict, t: int) -> None:
        call = m.get('toolCallId', '')
        step = self.open.get(call)
        if step is None:
            return
        text = '\n'.join(c.get('text', '') for c in m.get('content') or [] if isinstance(c, dict) and c.get('type') == 'text')
        error = bool(m.get('isError'))
        if step['kind'] == 'edit':
            diff = (m.get('details') or {}).get('diff') if isinstance(m.get('details'), dict) else None
            if isinstance(diff, str) and diff.strip() and not error:
                lines = _pi_diff(diff)
                step['files'][0]['add'], step['files'][0]['del'] = _patch_counts(lines)
                step['detail'] = _clip_lines(lines)
            self.close(call, t, not error, clip(text, 1500) if error else '')
            return
        if step['kind'] == 'read' and step.get('files'):
            self.close(call, t, not error, clip(text, 1500) if error else '')
            return
        if step['kind'] == 'run' and not error:
            m2 = re.search(r'(?:exit code|exited with code)[: ]+(\d+)', text[-400:], re.I)
            error = bool(m2 and m2.group(1) != '0')
        self.close(call, t, not error, clip(text) if text.strip() else '')


def _pi_diff(diff: str) -> list[str]:
    """Pi's diff of an edit, a line number after each line's mark ("+  34 text"), as unified diff lines."""
    lines = []
    for line in diff.splitlines():
        m = re.match(r'^([+\- ])\s*\d+ ?(.*)$', line)
        if m:
            lines.append(m.group(1) + m.group(2))
        elif line.strip() == '...':
            lines.append('@@ … @@')
    return lines


def pi_folder(cwd: str) -> str:
    """Pi's folder for a working folder: the path without its leading /, every / \\ and : a -, between --."""
    return '--' + re.sub(r'[/\\:]', '-', (cwd.rstrip('/') or '/').removeprefix('/')) + '--'


# ---------------------------------------------------------------- finding and reading the record

_lock = threading.Lock()
_parsers: 'OrderedDict[tuple, Parser]' = OrderedDict()
_looked: dict[tuple, float] = {}
KEEP = 48  # records kept parsed in memory


def claude_folder(cwd: str) -> str:
    return re.sub(r'[^A-Za-z0-9]', '-', cwd.rstrip('/') or '/')


def _find_script(kind: str, cwd: str, piece: str) -> str:
    """Lists the agent's records modified lately, newest first: `mtime<TAB>has the prompt<TAB>path` per line."""
    q = shlex.quote
    if kind in ('claude', 'pi'):
        folder = f'"$HOME/.claude/projects/"{q(claude_folder(cwd))}' if kind == 'claude' else f'"$HOME/.pi/agent/sessions/"{q(pi_folder(cwd))}'
        listing = f'cd {folder} 2>/dev/null && ls -t -- *.jsonl 2>/dev/null | head -n 12 | sed "s|^|$PWD/|"'
        wanted = ''
    else:
        listing = 'ls -t $(find "$HOME/.codex/sessions" -name "rollout-*.jsonl" -mtime -14 2>/dev/null) 2>/dev/null | head -n 40'
        wanted = f' && head -c 20000 "$f" | grep -q -F -e {q(json.dumps(cwd.rstrip("/"))[1:-1])}'
    has = f'grep -q -F -e {q(piece)} "$f"' if piece else 'false'
    return (f'{listing} | while IFS= read -r f; do [ -f "$f" ]{wanted} || continue; '
            f'printf "%s\\t%s\\t%s\\n" "$(stat -c %Y "$f")" "$({has} && echo 1 || echo 0)" "$f"; done')


def find(src, kind: str, cwd: str, since: float | None, piece: str, any_session: bool) -> str:
    """The record of the agent's session for the task: the newest one written since `since` (unix seconds) that holds
    the prompt (`piece` of the title), or with `any_session`, the newest one at all. '' when there is none yet."""
    out = herdr.shell(src, _find_script(kind, cwd, piece)).decode(errors='replace')
    found = []
    for line in out.splitlines():
        parts = line.split('\t', 2)
        if len(parts) < 3 or not parts[0].isdigit():
            continue
        mtime, has, path = int(parts[0]), parts[1] == '1', parts[2]
        if since is None or mtime >= since - SLACK:
            found.append((has, mtime, path))
    with_prompt = [f for f in found if f[0]]
    pick = with_prompt or (found if any_session or not piece else [])
    return max(pick, key=lambda f: f[1])[2] if pick else ''


def _read(src, path: str, offset: int) -> bytes:
    return herdr.shell(src, f'tail -c +{offset + 1} -- {shlex.quote(path)} 2>/dev/null | head -c {MAX_READ}', timeout=30)


def trace(src, kind: str, cwd: str, since: float | None, title: str, path: str = '', start: int = 0, any_session: bool = False) -> dict:
    """The steps of the agent's session, from step `start` on (the client has those before it). `path`: the record
    found last time. Reads only what was written since the last call."""
    if kind not in KINDS:
        return {'found': False, 'reason': f"Marumado can't read {kind or 'this agent'}'s record yet: only Claude Code's, Codex's and Pi's.", 'steps': [], 'total': 0}
    piece = needle(title)
    if not path:
        key = (getattr(src, 'id', src), kind, cwd, since, piece)
        if time.monotonic() - _looked.get(key, 0) < FIND_EVERY:
            return {'found': False, 'reason': 'Looking for the agent’s record…', 'steps': [], 'total': 0}
        _looked[key] = time.monotonic()
        path = find(src, kind, cwd, since, piece, any_session)
        if not path:
            return {'found': False, 'reason': 'The agent hasn’t written a record of this task yet.', 'steps': [], 'total': 0}
    parser = _parser((getattr(src, 'id', src), path, since, piece), kind, cwd)
    with parser.lock:
        data = _read(src, path, parser.offset)
        if data:
            parser.feed(data)
        steps = parser.steps
        first = _first(steps, since, piece)
        settled = parser.settled()
        if start < 0:  # the last -start steps only (a long session's end)
            start = max(0, len(steps) + start)
        start = max(first, min(start, settled))
        # What the task used: from the prompt that gave it (or from when it was given, before that is written).
        begin = steps[first]['t'] if first < len(steps) else (since - SLACK) * 1000 if since is not None else None
        return {'found': True, 'path': path, 'first': first, 'from': start, 'total': len(steps), 'steps': steps[start:],
                'usage': parser.usage(None if since is None else begin)}


# A session record's path, as find() and _newest() give them: nothing else is read for an image.
RECORD = re.compile(r'^/(?:[^/\0]+/)*(?:\.claude/projects/[^/\0]+/[^/\0]+|\.codex/sessions/(?:[^/\0]+/)*rollout-[^/\0]+|\.pi/agent/sessions/[^/\0]+/[^/\0]+)\.jsonl$')
IMAGE_ID = re.compile(r'^(\d{1,12})\.(\d{1,4})$')
IMAGE_TYPES = ('image/png', 'image/jpeg', 'image/gif', 'image/webp')
MAX_LINE = 48 * 1024 * 1024  # a record line holding images is read whole, up to this much
_images_read: 'OrderedDict[tuple, tuple[str, bytes]]' = OrderedDict()
KEEP_IMAGES = 64


def image(src, path: str, image_id: str) -> tuple[str, bytes]:
    """One image of a step (its id, `<offset>.<n>`, from Parser._attach_images): (media type, bytes). The record only
    grows, so what was read is kept. ValueError when it isn't there."""
    m = IMAGE_ID.match(image_id or '')
    if not m or not RECORD.match(path or '') or '/../' in path:
        raise ValueError('Not an image of a session record.')
    key = (getattr(src, 'id', src), path, image_id)
    with _lock:
        if key in _images_read:
            _images_read.move_to_end(key)
            return _images_read[key]
    offset, n = int(m.group(1)), int(m.group(2))
    raw = herdr.shell(src, f'tail -c +{offset + 1} -- {shlex.quote(path)} 2>/dev/null | head -n 1 | head -c {MAX_LINE}', timeout=60)
    try:
        record = json.loads(raw)
    except ValueError:
        raise ValueError('That image is no longer in the record.')
    kind = 'codex' if '/.codex/' in path else 'pi' if '/.pi/agent/' in path else 'claude'
    found = [img for block in _image_blocks(kind, record if isinstance(record, dict) else {}) for img in _images(block)]
    if n >= len(found) or found[n][0] not in IMAGE_TYPES:
        raise ValueError('That image is no longer in the record.')
    try:
        data = base64.b64decode(found[n][1], validate=False)
    except ValueError:
        raise ValueError('That image could not be read.')
    with _lock:
        _images_read[key] = (found[n][0], data)
        while len(_images_read) > KEEP_IMAGES:
            _images_read.popitem(last=False)
    return found[n][0], data


def _parser(key: tuple, kind: str, cwd: str) -> Parser:
    """The record's parser, kept from the last read (the least recently read are let go past KEEP)."""
    with _lock:
        parser = _parsers.pop(key, None) or Parser(kind, cwd)
        _parsers[key] = parser
        while len(_parsers) > KEEP:
            _parsers.popitem(last=False)
    return parser


def _first(steps: list[dict], since: float | None, piece: str) -> int:
    """Where the task begins in the session: at the prompt that gave it, or at `since` when that can't be found (a
    task that follows an agent shows its whole session)."""
    if since is None:
        return 0
    floor = (since - SLACK) * 1000
    for s in steps:
        if s['kind'] == 'you' and s['t'] >= floor and piece and piece in s['detail']:
            return s['i']
    return next((s['i'] for s in steps if s['t'] >= floor), len(steps))


# ---------------------------------------------------------------- what agents wrote lately (home)

PULSE_HOURS = 24
PULSE_FIND = 30  # seconds between two looks for a folder's newest records
PULSE_EDITS = 3000  # the most edits one folder reports
PULSE_STEP_HOURS = 1  # how far back every step is reported, for the activity ribbon
PULSE_STEPS = 2000  # the most steps one folder reports
_newest_seen: dict[tuple, tuple[float, list[str]]] = {}


def _newest(src, kind: str, cwd: str) -> list[str]:
    """The folder's session records written in the last PULSE_HOURS, newest first. Looked for again every PULSE_FIND."""
    return [p for _, p in newest(src, kind, cwd)]


def newest(src, kind: str, cwd: str, every: float = PULSE_FIND) -> list[tuple[int, str]]:
    """The folder's session records written in the last PULSE_HOURS, newest first, with when each was last written
    (unix seconds). Looked for again after `every` seconds."""
    key = (getattr(src, 'id', src), kind, cwd)
    seen = _newest_seen.get(key)
    if seen and time.monotonic() - seen[0] < every:
        return seen[1]
    out = herdr.shell(src, _find_script(kind, cwd, '')).decode(errors='replace')
    floor = time.time() - PULSE_HOURS * 3600
    found = []
    for line in out.splitlines():
        parts = line.split('\t', 2)
        if len(parts) == 3 and parts[0].isdigit() and int(parts[0]) >= floor:
            found.append((int(parts[0]), parts[2]))
    found.sort(reverse=True)
    _newest_seen[key] = (time.monotonic(), found)
    return found


def pulse(src, kind: str, cwd: str, n: int = 1) -> dict:
    """What the `n` agents of one kind at work in a folder did in the last PULSE_HOURS, from the folder's `n` newest
    session records (which record is whose can't be told, so they are reported together): every edit as
    [ms, lines added, lines removed, index in `files`], how many steps of each kind, and the latest step (`now`).
    `steps`: every step of the last PULSE_STEP_HOURS as [ms, kind, ok], oldest first. `turn`: since you last wrote to
    them (`since`, ms, or None), how many steps they took, the files they edited and the steps that failed. `usage`: the
    tokens of the last PULSE_HOURS (usage.total), with how full the agent's context is when there is one agent."""
    if kind not in KINDS:
        return {'found': False, 'edits': [], 'files': [], 'kinds': {}, 'now': None, 'steps': [], 'turn': None}
    paths = _newest(src, kind, cwd)[:max(1, n)]
    floor = (time.time() - PULSE_HOURS * 3600) * 1000
    edits: list[list] = []
    files: dict[str, int] = {}
    kinds: dict[str, int] = {}
    now = None
    recent = (time.time() - PULSE_STEP_HOURS * 3600) * 1000
    steps: list[list] = []
    every: list[dict] = []
    calls: list[list] = []
    context = None
    for path in paths:
        parser = _parser((getattr(src, 'id', src), path, None, ''), kind, cwd)
        with parser.lock:
            data = _read(src, path, parser.offset)
            if data:
                parser.feed(data)
            calls += [e for e in parser.calls.values() if e[0] >= floor]
            if len(paths) == 1:
                context = parser.context
            for s in parser.steps:
                if s['t'] < floor:
                    continue
                every.append(s)
                if s['t'] >= recent:
                    steps.append([s['t'], s['kind'], s['ok']])
                kinds[s['kind']] = kinds.get(s['kind'], 0) + 1
                if s['kind'] != 'you' and (now is None or s['t'] >= now['t']):
                    now = {'kind': s['kind'], 'title': s['title'], 't': s['t']}
                if s['kind'] == 'edit' and s['ok'] is not False:
                    for f in s.get('files') or []:
                        i = files.setdefault(f['path'], len(files))
                        edits.append([s['t'], f.get('add', 0), f.get('del', 0), i])
    edits.sort(key=lambda e: e[0])
    steps.sort(key=lambda e: e[0])
    since = max((s['t'] for s in every if s['kind'] == 'you'), default=None)
    turn = None
    if since is not None:
        mine = [s for s in every if s['t'] >= since and s['kind'] != 'you']
        edited = {f['path'] for s in mine if s['kind'] == 'edit' and s['ok'] is not False for f in s.get('files') or []}
        turn = {'since': since, 'steps': len(mine), 'files': len(edited), 'failed': sum(1 for s in mine if s['ok'] is False)}
    return {'found': bool(paths), 'edits': edits[-PULSE_EDITS:], 'files': list(files), 'kinds': kinds, 'now': now,
            'steps': steps[-PULSE_STEPS:], 'turn': turn, 'usage': usage.total(calls, context) if paths else None}
