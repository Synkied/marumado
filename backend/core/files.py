"""Browse and read files in project folders, read-only.

Only paths inside a scan folder or a project's folder are served, judged after resolving symlinks and `..`,
so nothing else on the machine can be reached through these endpoints.
"""
import os
import stat
from pathlib import Path

from . import discovery
from .models import Project

MAX_ENTRIES = 5000
MAX_READ = 1024 * 1024  # bytes shown of a file; longer files are cut
SNIFF = 8192  # bytes looked at to tell text from binary


class Refused(Exception):
    """The path is outside the project folders, or can't be read; the message says which, plainly."""


def _allowed_roots() -> list[str]:
    paths = [r['path'] for r in discovery.roots()]
    paths += list(Project.objects.exclude(path='').values_list('path', flat=True))
    return sorted({os.path.realpath(p) for p in paths})


def resolve(raw: str) -> Path:
    """`raw` as a real path, if it lies inside a project or scan folder."""
    if not raw or not os.path.isabs(raw):
        raise Refused('Use a full path.')
    real = os.path.realpath(discovery.normalize(raw))
    if not any(discovery.under(real, root) for root in _allowed_roots()):
        raise Refused('Only files inside project folders can be opened.')
    return Path(real)


def listing(raw: str) -> dict:
    folder = resolve(raw)
    if not folder.is_dir():
        raise Refused("That folder doesn't exist any more." if not folder.exists() else 'That is a file, not a folder.')
    entries = []
    try:
        with os.scandir(folder) as it:
            for e in it:
                try:
                    st = e.stat(follow_symlinks=True)
                    kind = 'dir' if stat.S_ISDIR(st.st_mode) else 'file'
                    size, mtime = (st.st_size if kind == 'file' else None), st.st_mtime
                except OSError:
                    kind, size, mtime = 'broken', None, None  # a dangling symlink, say
                entries.append({'name': e.name, 'kind': kind, 'link': e.is_symlink(), 'size': size, 'mtime': mtime})
    except PermissionError:
        raise Refused("Marumado isn't allowed to read that folder.")
    entries.sort(key=lambda x: (x['kind'] != 'dir', x['name'].lower()))
    return {'path': str(folder), 'entries': entries[:MAX_ENTRIES], 'total': len(entries)}


def read(raw: str) -> dict:
    path = resolve(raw)
    if not path.is_file():
        raise Refused("That file doesn't exist any more." if not path.exists() else 'That is a folder, not a file.')
    try:
        size = path.stat().st_size
        with path.open('rb') as f:
            data = f.read(MAX_READ)
    except PermissionError:
        raise Refused("Marumado isn't allowed to read that file.")
    except OSError as exc:
        raise Refused(f"Couldn't read that file ({exc.strerror or exc}).")
    binary = b'\0' in data[:SNIFF]
    return {
        'path': str(path),
        'size': size,
        'mtime': path.stat().st_mtime,
        'binary': binary,
        'truncated': size > MAX_READ,
        'text': '' if binary else data.decode('utf-8', errors='replace'),
    }
