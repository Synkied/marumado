"""Files dropped into an agent's chat: written where the agent runs, each in a folder of its own under
/tmp/marumado-drops-<uid>, so the message can name it. Claude Code reads a file named @<path> into the message (a
picture as a picture); other agents are given the path and read it themselves.

Where Herdr runs decides how a file gets there: written here, on this machine; piped to `sh` in a VM or on an SSH
host; sent to the Marumado of a machine in Machines; and with Marumado in a container beside the host's Herdr (it can't
write the host's folders), fetched by the host from Marumado itself, at a one-time address, in a terminal of its own.
"""
import os
import re
import secrets
import shlex
import threading
import time
from pathlib import Path
from urllib.parse import urlencode

from marumado.settings import env

from . import herdr

MAX_BYTES = 25 * 1024 * 1024
KEEP_DAYS = 7  # older drops are removed as new ones come
FETCH_SECONDS = 120  # how long a one-time address lasts
NAME = re.compile(r'[^\w.+-]+')

_lock = threading.Lock()
_waiting: dict[str, tuple[float, bytes]] = {}  # one-time address -> (until, the file)


def clean_name(name: str) -> str:
    """The file's name, safe in a path and on a command line: no folders, spaces or leading dots."""
    base = NAME.sub('-', str(name).replace('\\', '/').rsplit('/', 1)[-1]).strip('.-')
    return base[-100:].lstrip('.-') or 'file'  # a long one keeps its end, where its extension is


def save(pane_id: str, source: 'int | herdr.Source', name: str, data: bytes) -> str:
    """Write `data` as `name` where the agent of `pane_id` runs, and return its path there. Raises ValueError,
    RuntimeError."""
    src = herdr.get_source(source)
    if not herdr.PANE_ID.match(pane_id):
        raise ValueError('Not a Herdr pane id.')
    if len(data) > MAX_BYTES:
        raise ValueError(f'That file is over {MAX_BYTES // (1024 * 1024)} MB.')
    name, folder = clean_name(name), secrets.token_hex(6)
    if src.kind == 'machine':
        return herdr._remote(src, 'POST', f'agents/{pane_id}/files', query=urlencode({'name': name}), raw=data)['path']
    if not any(herdr._elsewhere(src)) and not herdr._contained():
        return _save_here(folder, name, data)
    if any(herdr._elsewhere(src)):
        out = herdr.shell(src, _script(folder, name, 'cat > "$f"', len(data)), timeout=120, data=data).decode(errors='replace')
    else:
        nonce = secrets.token_urlsafe(24)
        with _lock:
            now = time.monotonic()
            for k in [k for k, (until, _) in _waiting.items() if until < now]:
                del _waiting[k]
            _waiting[nonce] = (now + FETCH_SECONDS, data)
        url = shlex.quote(f'{_own_address()}/api/drops/{nonce}')
        fetch = f'{{ curl -fsS -o "$f" {url} || wget -q -O "$f" {url}; }} 2>&1'
        try:
            _, out = herdr.execute(src, '/tmp', _script(folder, name, fetch, len(data)), timeout=90, near=pane_id)
        finally:
            with _lock:
                _waiting.pop(nonce, None)
    m = re.search(r'^marumado-drop:(.+)$', out, re.M)
    if not m:
        raise RuntimeError(f"Couldn't write it where the agent runs: {out.strip()[-300:] or 'no answer.'}")
    return m.group(1).strip()


def take(nonce: str) -> bytes | None:
    """The file waiting at a one-time address, once."""
    with _lock:
        until, data = _waiting.pop(nonce, (0.0, b''))
    return data if until >= time.monotonic() else None


def _script(folder: str, name: str, write: str, size: int) -> str:
    """sh that makes the drop folder (the user's own: not one someone else made first), forgets old drops, writes the
    file with `write` (to "$f") and says where, or why not."""
    return (
        'umask 077; r="/tmp/marumado-drops-$(id -u)"; '
        'mkdir -p "$r" 2>/dev/null; '
        'if [ -L "$r" ] || [ ! -O "$r" ]; then echo "$r is not yours."; exit 3; fi; '
        f'find "$r" -mindepth 1 -maxdepth 1 -mtime +{KEEP_DAYS} -exec rm -rf {{}} + 2>/dev/null; '
        f'mkdir "$r/{folder}" || exit 3; f="$r/{folder}/{name}"; '
        f'{write} || exit 3; '
        f'if [ "$(wc -c < "$f" | tr -d " ")" != {size} ]; then echo "Only part of it arrived."; exit 3; fi; '
        'echo "marumado-drop:$f"'
    )


def _save_here(folder: str, name: str, data: bytes) -> str:
    root = Path(f'/tmp/marumado-drops-{os.getuid()}')
    root.mkdir(mode=0o700, exist_ok=True)
    if root.is_symlink() or root.stat().st_uid != os.getuid():
        raise RuntimeError(f'{root} is not yours.')
    cutoff = time.time() - KEEP_DAYS * 86400
    for old in root.iterdir():
        try:
            if old.is_dir() and not old.is_symlink() and old.stat().st_mtime < cutoff:
                for f in old.iterdir():
                    f.unlink()
                old.rmdir()
        except OSError:
            pass  # in use, or not ours to remove: left for later
    (root / folder).mkdir(mode=0o700)
    path = root / folder / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(data)
    return str(path)


def _own_address() -> str:
    """This Marumado, as the host reaches it (the container shares the host's network)."""
    host = env('BIND', '127.0.0.1')
    host = '127.0.0.1' if host in ('', '0.0.0.0', '::') else host
    return f"http://{f'[{host}]' if ':' in host else host}:{env('PORT', '7878')}"
