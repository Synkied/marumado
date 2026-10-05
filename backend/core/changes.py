"""Read-only Git changes in a selected Herdr pane's repository, on its own source."""
import shlex
from urllib.parse import urlencode

from . import herdr

LIMIT = 256 * 1024


def read(pane_id, source=0, path=None):
    src = herdr.get_source(source)
    if not herdr.PANE_ID.match(pane_id):
        raise ValueError('Not a Herdr pane id.')
    if src.kind == 'machine':
        return herdr._remote(src, 'GET', f'agents/{pane_id}/changes', query=urlencode({'path': path} if path is not None else {}))
    listed = herdr._list(src)
    if not listed['available']:
        raise RuntimeError(listed['error'])
    pane = next((a for a in listed['agents'] if a['pane_id'] == pane_id), None)
    if not pane or not pane['cwd']:
        raise ValueError('This agent has no working folder to inspect.')
    prefix = f'cd {shlex.quote(pane["cwd"])} && '
    root = herdr.shell(src, prefix + 'git rev-parse --show-toplevel 2>/dev/null').decode(errors='replace').strip()
    if not root:
        return {'repository': None, 'files': []}
    prefix = f'export GIT_OPTIONAL_LOCKS=0; cd {shlex.quote(root)} && '
    raw = herdr.shell(src, prefix + f'git status --porcelain=v1 -z --untracked-files=all 2>/dev/null | head -c {LIMIT + 1}')
    if len(raw) > LIMIT:
        raise RuntimeError('Too many changed files to display.')
    entries = iter(raw.decode(errors='replace').split('\0'))
    files = []
    for entry in entries:
        if not entry:
            continue
        status, name = entry[:2], entry[3:]
        original = next(entries, '') if 'R' in status or 'C' in status else None
        files.append({'path': name, 'status': status, 'original': original})
    if path is None:
        return {'repository': root, 'files': files}
    file = next((f for f in files if f['path'] == path), None)
    if file is None:
        raise ValueError('That file is no longer in the changed files list.')
    names = ' '.join(shlex.quote(n) for n in [path, file['original']] if n)
    options = '--no-ext-diff --no-textconv --no-color'
    if file['status'] == '??':
        command = f'git --literal-pathspecs diff {options} --no-index -- /dev/null {shlex.quote(path)}'
    else:
        command = f'if git rev-parse --verify HEAD >/dev/null 2>&1; then git --literal-pathspecs diff {options} HEAD -- {names}; else git --literal-pathspecs diff {options} --cached -- {names}; git --literal-pathspecs diff {options} -- {names}; fi'
    raw = herdr.shell(src, prefix + f'({command}) 2>/dev/null | head -c {LIMIT + 1}')
    return {'path': path, 'diff': raw[:LIMIT].decode(errors='replace'), 'truncated': len(raw) > LIMIT}
