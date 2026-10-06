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

A config with IdentityFile lines (work.pem) stops ssh from trying the usual keys (id_rsa, id_ed25519…). On the host
ssh-agent offers them anyway, but the container has no agent: so the copied config names the usual keys last.

MARUMADO_SSH_KEYS (comma separated, e.g. id_rsa) copies only those keys, their .pub and known_hosts, not
the config. With many keys, ssh offers them one by one and servers cut it off after a few (MaxAuthTries)
before the right one; a config with IdentityFile lines would bring them back.
"""
import os
import shutil
import stat
import threading
from pathlib import Path

# The keys ssh tries when no IdentityFile is set.
DEFAULT_KEYS = ('id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk', 'id_xmss', 'id_dsa')

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
        config = target / 'config'
        text = config.read_text(errors='replace') if config.is_file() else ''
        # ssh keeps the first value it finds, so a fallback goes last. IdentityFile lines add up instead.
        fallback = ''
        user = os.environ.get('MARUMADO_SSH_USER', '').strip()
        if user:
            fallback += f'\n\n# Added by Marumado: log in as the host user, like ssh on the host does.\nMatch all\n  User {user}\n'
        defaults = [k for k in DEFAULT_KEYS if (target / k).is_file()]
        if text and defaults:
            fallback += (
                '\n\n# Added by Marumado: the usual keys too, as the host\'s ssh-agent offers them.\nMatch all\n'
                + ''.join(f'  IdentityFile ~/.ssh/{k}\n' for k in defaults)
            )
        if fallback:
            config.write_text(f'{text.rstrip()}{fallback}'.lstrip())
            config.chmod(stat.S_IRUSR | stat.S_IWUSR)
        _copied = signature
