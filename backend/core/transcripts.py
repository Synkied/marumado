"""What a coding agent thought and did, read from the record it keeps of its session.

Claude Code writes every session to ~/.claude/projects/<its folder, dashed>/<session>.jsonl, and Codex to
~/.codex/sessions/<date>/rollout-*.jsonl: one JSON object per line, with its thinking, what it said, every tool it
called and what came back. The terminal only shows the end of that; this reads all of it.

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
"""
import json
import re
import shlex
import threading
import time
from collections import OrderedDict
from datetime import datetime

from . import herdr, usage

KINDS = ('claude', 'codex')
MAX_READ = 8 * 1024 * 1024  # read at most this much of a record per poll
TEXT = 6000  # how much of a thought, a message or a command's output a step keeps
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
        self.prev = 0  # when the last record was written
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
        self.offset += len(data)
        lines = (self.buf + data).split(b'\n')
        self.buf = lines.pop()
        for raw in lines:
            if not raw.strip():
                continue
            try:
                record = json.loads(raw)
            except ValueError:
                continue
            if isinstance(record, dict):
                try:
                    (self._claude_usage if self.kind == 'claude' else self._codex_usage)(record)
                except (KeyError, TypeError, AttributeError, ValueError):
                    pass
                try:
                    (self._claude if self.kind == 'claude' else self._codex)(record)
                except (KeyError, TypeError, AttributeError, ValueError):
                    continue  # a record of a shape this doesn't know: skip it, keep the rest

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
            self.open[call] = step
        return step

    def close(self, call: str, t: int, ok: bool | None, detail: str = '') -> dict | None:
        step = self.open.pop(call, None)
        if step is None:
            return None
        step['end'] = max(t, step['t'])
        step['ok'] = ok
        if detail:
            step['detail'] = f"{step['detail']}\n\n{detail}".strip() if step['detail'] else detail
        return step

    def prompt(self, t: int, text: str) -> None:
        text = (text or '').strip()
        if not text or text.startswith('<') or text.startswith('Caveat:'):
            return  # what the agent's own tooling adds: reminders, command output, environment notes
        if text.startswith('[Request interrupted'):
            self.add('you', t, 'Interrupted', end=t)
            return
        self.add('you', t, first_line(text), clip(text), end=t)

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
        if r.get('type') not in ('user', 'assistant') or r.get('isSidechain') or r.get('isMeta'):
            return
        t = _ms(r.get('timestamp', ''))
        prev, self.prev = self.prev or t, t
        content = (r.get('message') or {}).get('content')
        if r['type'] == 'user':
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
                self.add('say', prev, first_line(text), clip(text), end=t)
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
        if r.get('type') != 'response_item':
            return  # event_msg and turn_context repeat what the response items say
        prev, self.prev = self.prev or t, t
        kind = p.get('type')
        if kind == 'message':
            text = '\n'.join(c.get('text', '') for c in p.get('content') or [] if isinstance(c, dict))
            if p.get('role') == 'user':
                self.prompt(t, text)
            elif p.get('role') == 'assistant' and text.strip():
                self.add('say', prev, first_line(text), clip(text), end=t)
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
    if kind == 'claude':
        listing = f'cd "$HOME/.claude/projects/"{q(claude_folder(cwd))} 2>/dev/null && ls -t -- *.jsonl 2>/dev/null | head -n 12 | sed "s|^|$PWD/|"'
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
        return {'found': False, 'reason': f"Marumado can't read {kind or 'this agent'}'s record yet: only Claude Code's and Codex's.", 'steps': [], 'total': 0}
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
        start = max(first, min(start, settled))
        # What the task used: from the prompt that gave it (or from when it was given, before that is written).
        begin = steps[first]['t'] if first < len(steps) else (since - SLACK) * 1000 if since is not None else None
        return {'found': True, 'path': path, 'first': first, 'from': start, 'total': len(steps), 'steps': steps[start:],
                'usage': parser.usage(None if since is None else begin)}


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
    key = (getattr(src, 'id', src), kind, cwd)
    seen = _newest_seen.get(key)
    if seen and time.monotonic() - seen[0] < PULSE_FIND:
        return seen[1]
    out = herdr.shell(src, _find_script(kind, cwd, '')).decode(errors='replace')
    floor = time.time() - PULSE_HOURS * 3600
    found = []
    for line in out.splitlines():
        parts = line.split('\t', 2)
        if len(parts) == 3 and parts[0].isdigit() and int(parts[0]) >= floor:
            found.append((int(parts[0]), parts[2]))
    paths = [p for _, p in sorted(found, reverse=True)]
    _newest_seen[key] = (time.monotonic(), paths)
    return paths


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
