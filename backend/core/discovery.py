"""Find projects on disk and work out what they are, where they live online, and whether they run."""

import json
import os
import re
import subprocess
from pathlib import Path

from django.conf import settings

from .models import Project, ScanRoot

# File marker -> stack label. Checked in the project root and one folder below it.
STACK_MARKERS = [
    ('manage.py', 'Django'),
    ('pyproject.toml', 'Python'),
    ('requirements.txt', 'Python'),
    ('setup.py', 'Python'),
    ('package.json', 'Node'),
    ('next.config.js', 'Next.js'),
    ('next.config.ts', 'Next.js'),
    ('next.config.mjs', 'Next.js'),
    ('vite.config.ts', 'Vite'),
    ('vite.config.js', 'Vite'),
    ('app.json', 'Expo'),
    ('Cargo.toml', 'Rust'),
    ('src-tauri', 'Tauri'),
    ('go.mod', 'Go'),
    ('project.godot', 'Godot'),
    ('CMakeLists.txt', 'C/C++'),
    ('Makefile', 'Make'),
    ('Dockerfile', 'Docker'),
    ('docker-compose.yml', 'Compose'),
    ('docker-compose.yaml', 'Compose'),
    ('compose.yml', 'Compose'),
    ('compose.yaml', 'Compose'),
]
SKIP_DIRS = {'node_modules', '.venv', 'venv', '__pycache__', '.git', 'dist', 'build', '.next'}
SCANNED_FIELDS = ('description', 'online_url', 'repo_url')


def _git(path: Path, *args: str) -> str:
    try:
        out = subprocess.run(
            ['git', '-C', str(path), *args], capture_output=True, text=True, timeout=3
        )
    except (OSError, subprocess.TimeoutExpired):
        return ''
    return out.stdout.strip() if out.returncode == 0 else ''


def _repo_web_url(remote: str) -> str:
    """git@github.com:me/repo.git / https://github.com/me/repo.git -> https://github.com/me/repo"""
    m = re.match(r'^(?:git@|ssh://git@|https?://)([^/:]+)[:/](.+?)(?:\.git)?/?$', remote)
    return f'https://{m.group(1)}/{m.group(2)}' if m else ''


def _stacks(path: Path) -> list[str]:
    found: list[str] = []
    dirs = [path] + [
        d for d in sorted(path.iterdir()) if d.is_dir() and d.name not in SKIP_DIRS and not d.name.startswith('.')
    ][:30]
    for d in dirs:
        for marker, label in STACK_MARKERS:
            if (d / marker).exists() and label not in found:
                found.append(label)
        if any(d.glob('*.csproj')) and 'C#' not in found:
            found.append('C#')
    # Drop generic labels when a specific one covers them.
    if 'Django' in found and 'Python' in found:
        found.remove('Python')
    if {'Next.js', 'Vite', 'Expo'} & set(found) and 'Node' in found:
        found.remove('Node')
    return found


def _description(path: Path) -> str:
    for name in ('README.md', 'README', 'readme.md'):
        readme = path / name
        if not readme.is_file():
            continue
        try:
            text = readme.read_text(errors='ignore')[:4000]
        except OSError:
            return ''
        for line in text.splitlines():
            line = line.strip()
            if line and not line.startswith(('#', '!', '[', '<', '```', '---', '|')):
                return re.sub(r'[*_`]', '', line)[:280]
    return ''


def _online_url(path: Path, repo_url: str) -> str:
    cname = path / 'CNAME'
    if cname.is_file():
        host = cname.read_text(errors='ignore').strip().splitlines()[0:1]
        if host:
            return f'https://{host[0]}'
    pkg = path / 'package.json'
    if pkg.is_file():
        try:
            homepage = json.loads(pkg.read_text(errors='ignore')).get('homepage', '')
        except (ValueError, OSError):
            homepage = ''
        if isinstance(homepage, str) and homepage.startswith('http'):
            return homepage
    # user.github.io repos are published at that hostname.
    m = re.match(r'^https://github\.com/[^/]+/([^/]+\.github\.io)$', repo_url, re.I)
    if m:
        return f'https://{m.group(1).lower()}'
    return ''


def inspect(path: Path) -> dict:
    """Everything the scanner knows about one folder."""
    remote = _git(path, 'remote', 'get-url', 'origin')
    repo_url = _repo_web_url(remote) if remote else ''
    last_commit = _git(path, 'log', '-1', '--format=%cI%x00%s')
    commit_at, _, commit_msg = last_commit.partition('\x00')
    dirty = _git(path, 'status', '--porcelain')
    return {
        'description': _description(path),
        'repo_url': repo_url,
        'online_url': _online_url(path, repo_url),
        'detected': {
            'stacks': _stacks(path),
            'git': bool((path / '.git').exists()),
            'branch': _git(path, 'rev-parse', '--abbrev-ref', 'HEAD'),
            'last_commit_at': commit_at,
            'last_commit': commit_msg[:200],
            'dirty_files': len(dirty.splitlines()) if dirty else 0,
        },
    }


def roots() -> list[dict]:
    """Every scanned folder: those from MARUMADO_PROJECT_ROOTS (.env) first, then those added in the app."""
    out, seen = [], set()
    for p in settings.MARUMADO_PROJECT_ROOTS:
        path = normalize(str(p))
        if path not in seen:
            seen.add(path)
            out.append({'id': None, 'path': path, 'source': 'env'})
    for r in ScanRoot.objects.all():
        if r.path not in seen:
            seen.add(r.path)
            out.append({'id': r.id, 'path': r.path, 'source': 'app'})
    return out


def normalize(path: str) -> str:
    return os.path.normpath(os.path.expanduser(path.strip()))


def under(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip('/') + '/')


def candidate_dirs():
    for r in roots():
        root = Path(r['path'])
        if not root.is_dir():
            continue
        for d in sorted(root.iterdir()):
            if not d.is_dir() or d.name.startswith('.') or d.name in SKIP_DIRS:
                continue
            try:
                names = {p.name for p in d.iterdir()}
            except OSError:
                continue
            # Any non-empty folder counts; markers only decide what we can say about it.
            if names:
                yield d


def scan() -> dict:
    """Create or refresh scanned projects. Hand-edited fields are left alone."""
    created = updated = 0
    seen = set()
    for d in candidate_dirs():
        path = str(d)
        seen.add(path)
        info = inspect(d)
        project = Project.objects.filter(path=path).first()
        if project is None:
            Project.objects.create(
                name=d.name, path=path, source=Project.SOURCE_SCAN,
                detected=info['detected'], **{f: info[f] for f in SCANNED_FIELDS},
            )
            created += 1
            continue
        for field in SCANNED_FIELDS:
            if field not in project.locked_fields:
                setattr(project, field, info[field])
        project.detected = {**info['detected'], 'missing': False}
        project.save()
        updated += 1
    missing = removed = 0
    root_paths = [r['path'] for r in roots()]
    for project in Project.objects.filter(source=Project.SOURCE_SCAN).exclude(path__in=seen):
        # Outside every scanned folder (its folder was removed from the list): drop it,
        # unless it was edited or pinned by hand, which keeps it as a missing project.
        outside = not any(under(project.path, root) for root in root_paths)
        if outside and not project.locked_fields and not project.pinned:
            project.delete()
            removed += 1
            continue
        project.detected = {**project.detected, 'missing': True}
        project.save(update_fields=['detected', 'updated_at'])
        missing += 1
    return {'created': created, 'updated': updated, 'missing': missing, 'removed': removed}


def project_for_path(path: str, projects: list[Project]) -> Project | None:
    """The project whose folder contains `path` (longest match wins)."""
    if not path:
        return None
    best = None
    for p in projects:
        if p.path and (path == p.path or path.startswith(p.path.rstrip('/') + '/')):
            if best is None or len(p.path) > len(best.path):
                best = p
    return best
