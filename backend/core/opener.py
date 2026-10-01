"""Open a folder in the file manager of the desktop Marumado runs on, or hand the browser a link.

When Marumado runs somewhere your desktop isn't (Docker, a VM, a server), set
MARUMADO_OPEN_URL to a link template with {path}, opened by the browser instead, e.g.
  vscode://vscode-remote/ssh-remote+my-vm{path}   VS Code over SSH
  vscode://file{path}                              VS Code on the same machine
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

from marumado.settings import env


def url_template() -> str:
    """The MARUMADO_OPEN_URL link template, or ''."""
    template = env('OPEN_URL').strip()
    return template if '{path}' in template else ''


def unavailable_reason() -> str:
    """Why folders can't be opened from here, or '' when they can."""
    if Path('/.dockerenv').exists():
        return "Marumado runs in Docker, which can't reach your desktop. Set MARUMADO_OPEN_URL in .env (for example vscode://vscode-remote/ssh-remote+my-vm{path}), or run it with make dev."
    if sys.platform.startswith('linux'):
        if not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
            return 'No desktop session on this machine. Set MARUMADO_OPEN_URL in .env to open folders through a link instead (for example in VS Code).'
        if not shutil.which('xdg-open'):
            return 'xdg-open is not installed.'
    return ''


def open_folder(path: str) -> None:
    if os.name == 'nt':
        os.startfile(path)  # Explorer
        return
    cmd = ['open', path] if sys.platform == 'darwin' else ['xdg-open', path]
    subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
