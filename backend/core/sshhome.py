"""The host's SSH keys and config, made usable inside the Docker container.

compose-mounts.sh mounts the host's ~/.ssh read-only at its own path and names it in MARUMADO_SSH_SOURCE.
ssh can't use it as is: the container runs as root, and ssh refuses a config file owned by another user.
So before each ssh call, prepare() copies the folder into root's ~/.ssh (owned by root, private), again
whenever a file changes on the host. Keeping the host path mounted lets absolute paths in the config
(IdentityFile /home/you/.ssh/id_ed25519) still resolve. Without MARUMADO_SSH_SOURCE (not in Docker) it
does nothing and ssh uses the user's own ~/.ssh.

MARUMADO_SSH_USER is the host user's name. ssh in the container would log in as root by default, where
`ssh server` on the host logs in as you, so the copied config ends with a fallback `User` line. A User
in the target (you@server) or in the host's own config for that host still wins.

MARUMADO_SSH_KEYS (comma separated, e.g. id_rsa) copies only those keys, their .pub and known_hosts, not
the config. With many keys, ssh offers them one by one and servers cut it off after a few (MaxAuthTries)
before the right one; a config with IdentityFile lines would bring them back.
"""
import os
import shutil
import stat
import threading
from pathlib import Path

_lock = threading.Lock()
_copied: tuple | None = None


def _files(source: Path) -> list[Path]:
    """The files to copy: regular files only (skips ControlMaster sockets and the like), or the chosen keys."""
    keys = [k.strip() for k in os.environ.get('MARUMADO_SSH_KEYS', '').split(',') if k.strip()]
    if not keys:
        return sorted(p for p in source.rglob('*') if p.is_file())
    names = {'known_hosts', *keys, *(f'{k}.pub' for k in keys)}
    return sorted(source / n for n in names if (source / n).is_file())


def prepare():
    global _copied
    source = os.environ.get('MARUMADO_SSH_SOURCE', '').strip()
    # Only ever in Docker: it replaces root's ~/.ssh, which must never be a real user's.
    if not source or not Path('/.dockerenv').exists():
        return
    source = Path(source)
    target = Path.home() / '.ssh'
    if source.resolve() == target.resolve():
        return
    with _lock:
        try:
            files = _files(source)
            signature = tuple((str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in files)
        except OSError:
            return
        if signature == _copied:
            return
        # The container's ~/.ssh mirrors the chosen files exactly: drop anything left from an earlier choice.
        shutil.rmtree(target, ignore_errors=True)
        target.mkdir(mode=0o700, parents=True, exist_ok=True)
        for src in files:
            dest = target / src.relative_to(source)
            dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            try:
                shutil.copyfile(src, dest)
            except OSError:
                continue
            dest.chmod(stat.S_IRUSR | stat.S_IWUSR)
        user = os.environ.get('MARUMADO_SSH_USER', '').strip()
        if user:
            config = target / 'config'
            # ssh keeps the first value it finds, so a fallback goes last.
            text = config.read_text(errors='replace') if config.is_file() else ''
            config.write_text(f'{text.rstrip()}\n\n# Added by Marumado: log in as the host user, like ssh on the host does.\nMatch all\n  User {user}\n'.lstrip())
            config.chmod(stat.S_IRUSR | stat.S_IWUSR)
        _copied = signature
