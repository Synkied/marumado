"""The / commands an agent takes, for the Conversation view's chat box to suggest: its own (built in), and the ones
its owner added: Claude Code's commands (~/.claude/commands, <folder>/.claude/commands) and skills, Codex's prompts
(~/.codex/prompts, as /prompts:<name>), Pi's prompts and skills (/skill:<name>). Read where the agent runs."""
import re
import shlex
import time
from urllib.parse import urlencode

from . import herdr

BUILT_IN = {
    'claude': [
        ('add-dir', 'Add a working folder'), ('agents', 'Manage subagents'), ('clear', 'Start a new conversation'),
        ('compact', 'Summarize the conversation to free context'), ('config', 'Open the settings'),
        ('context', 'Show what fills the context'), ('cost', 'Show what this session cost'), ('doctor', 'Check the install'),
        ('exit', 'Quit'), ('export', 'Export the conversation'), ('help', 'Show the help'), ('hooks', 'Manage hooks'),
        ('init', 'Write a CLAUDE.md for this project'), ('mcp', 'Manage MCP servers'), ('memory', 'Edit memory files'),
        ('model', 'Choose the model'), ('permissions', 'Manage permissions'), ('plugin', 'Manage plugins'),
        ('resume', 'Resume a conversation'), ('review', 'Review a pull request'), ('rewind', 'Go back to an earlier point'),
        ('status', 'Show the version, model and account'), ('usage', 'Show the plan usage'),
    ],
    'codex': [
        ('model', 'Choose the model and reasoning'), ('approvals', 'Choose what it may do without asking'),
        ('review', 'Review the current changes'), ('new', 'Start a new conversation'), ('clear', 'Clear the screen and start anew'),
        ('resume', 'Resume a conversation'), ('fork', 'Fork this conversation'), ('init', 'Write an AGENTS.md for this project'),
        ('compact', 'Summarize the conversation to free context'), ('diff', 'Show the git diff'), ('mention', 'Mention a file'),
        ('status', 'Show the session and usage'), ('mcp', 'List MCP tools'), ('skills', 'Use a skill'), ('logout', 'Log out'),
        ('quit', 'Quit'),
    ],
    'pi': [
        ('new', 'Start a new session'), ('resume', 'Resume a session'), ('session', 'Show the session'),
        ('name', 'Name the session'), ('fork', 'Fork from an earlier message'), ('tree', 'Move in the session tree'),
        ('compact', 'Summarize the conversation to free context'), ('model', 'Choose the model'),
        ('scoped-models', 'Choose the models to cycle'), ('settings', 'Open the settings'), ('export', 'Export to HTML'),
        ('share', 'Share as a gist'), ('copy', 'Copy the last reply'), ('hotkeys', 'Show the keys'),
        ('changelog', 'Show what changed'), ('reload', 'Reload extensions, skills and prompts'),
        ('login', 'Log in'), ('logout', 'Log out'), ('quit', 'Quit'),
    ],
}

# Where each agent's own commands are: (glob, how its name is made). `{cwd}` is the agent's folder.
PLACES = {
    'claude': [('$HOME/.claude/commands', 'md'), ('{cwd}/.claude/commands', 'md'),
               ('$HOME/.claude/skills', 'skill'), ('{cwd}/.claude/skills', 'skill')],
    'codex': [('$HOME/.codex/prompts', 'prompt')],
    'pi': [('$HOME/.pi/agent/prompts', 'md'), ('{cwd}/.pi/prompts', 'md'),
           ('$HOME/.pi/agent/skills', 'pi-skill'), ('$HOME/.agents/skills', 'pi-skill'), ('{cwd}/.pi/skills', 'pi-skill')],
}
SEP = '\x1e'
EVERY = 60  # seconds a folder's commands are taken as known
DESCRIPTION = re.compile(r'^description:\s*(.+?)\s*$', re.M)
_seen: dict[tuple, tuple[float, list[dict]]] = {}


def _script(kind: str, cwd: str) -> str:
    parts = []
    for place, how in PLACES.get(kind, []):
        root = place.replace('{cwd}', shlex.quote(cwd.rstrip('/'))) if '{cwd}' in place else f'"{place}"'
        if '{cwd}' in place and not cwd:
            continue
        files = (f'find -L {root} -maxdepth 4 -name "*.md" -type f 2>/dev/null' if how == 'md'
                 else f'find -L {root} -maxdepth 1 -name "*.md" -type f 2>/dev/null' if how == 'prompt'
                 else f'ls -d {root}/*/SKILL.md 2>/dev/null')
        parts.append(f'{files} | head -n 200 | while IFS= read -r f; do printf "{SEP}%s\\t%s\\t%s\\n" {how} {root} "$f"; '
                     f'head -c 1500 "$f"; echo; done')
    return '; '.join(parts) or 'true'


def _name(how: str, root: str, path: str) -> str:
    rel = path[len(root):].lstrip('/') if path.startswith(root) else path.rsplit('/', 1)[-1]
    if how in ('skill', 'pi-skill'):
        name = rel.split('/')[0]
        return f'skill:{name}' if how == 'pi-skill' else name
    stem = rel.removesuffix('.md')
    return f'prompts:{stem}' if how == 'prompt' else stem.replace('/', ':')


def found(out: str) -> list[dict]:
    """The commands in what _script printed: {name, description, kind: 'custom'|'skill'}, by name, the first of a name."""
    seen, out_ = set(), []
    for chunk in out.split(SEP)[1:]:
        head, _, body = chunk.partition('\n')
        parts = head.split('\t')
        if len(parts) != 3:
            continue
        how, root, path = parts
        name = _name(how, root, path)
        if not name or name in seen or not re.fullmatch(r'[\w:.-]{1,80}', name):
            continue
        seen.add(name)
        m = DESCRIPTION.search(body.split('\n---', 1)[0]) if body.startswith('---') else None
        description = (m.group(1).strip('\'"') if m else next((ln.strip('# ').strip() for ln in body.splitlines() if ln.strip() and ln.strip() != '---'), ''))
        out_.append({'name': name, 'description': description[:160], 'kind': 'skill' if 'skill' in how else 'custom'})
    return out_


def commands(pane_id: str, source) -> dict:
    """The / commands the pane's agent takes: {kind, commands: [{name, description, kind: built-in|custom|skill}]}."""
    from .conversation import _pane
    src = herdr.get_source(source)
    if not herdr.PANE_ID.match(pane_id):
        raise ValueError('Not a Herdr pane id.')
    if src.kind == 'machine':
        return herdr._remote(src, 'GET', f'agents/{pane_id}/commands', query=urlencode({}))
    pane, _ = _pane(src, pane_id)
    kind, cwd = pane['kind'], pane['cwd']
    built = [{'name': n, 'description': d, 'kind': 'built-in'} for n, d in BUILT_IN.get(kind, [])]
    if kind not in PLACES:
        return {'kind': kind, 'commands': built}
    key = (src.id, kind, cwd)
    hit = _seen.get(key)
    if hit and time.monotonic() - hit[0] < EVERY:
        own = hit[1]
    else:
        try:
            own = found(herdr.shell(src, _script(kind, cwd)).decode(errors='replace'))
        except RuntimeError:
            own = []
        _seen[key] = (time.monotonic(), own)
    names = {c['name'] for c in own}
    return {'kind': kind, 'commands': own + [c for c in built if c['name'] not in names]}
