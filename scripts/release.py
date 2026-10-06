#!/usr/bin/env python3
"""Releases a version of Marumado: `make release VERSION=0.2.0` (or patch, minor, major).

Sets the version everywhere it is written (the desktop app, the web app, the backend, and their lock files), commits
it, tags it vX.Y.Z and pushes both. The tag starts the release on GitHub: image.yml publishes the Docker image of that
version, desktop.yml builds the app on every system and attaches its bundles to the GitHub release (see "Release it"
in desktop/README.md).

  --dry-run   show what would change, and change nothing
  --yes       don't ask before committing and pushing
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRANCH = 'main'
REMOTE = 'origin'


def json_version(path: str, count: int = 1):
    """A package.json or tauri.conf.json (its first "version"), or a package-lock.json (count=2: the root package's, at
    the top and under packages[""], its first two). Edited as text, so the file keeps its layout."""
    pattern = re.compile(r'("version":\s*")([^"]+)(")')

    def read(text: str) -> str:
        m = pattern.search(text)
        if not m:
            raise SystemExit(f'No version found in {path}')
        return m.group(2)

    def edit(text: str, new: str) -> str:
        return pattern.sub(lambda m: m.group(1) + new + m.group(3), text, count=count)

    return path, read, edit


def toml_version(path: str, package: str | None = None):
    """A Cargo.toml / pyproject.toml (its first `version = ...`), or a Cargo.lock / uv.lock (the named package's)."""
    pattern = (re.compile(r'(name = "%s"\nversion = ")([^"]+)(")' % re.escape(package)) if package
               else re.compile(r'^(version = ")([^"]+)(")', re.M))

    def read(text: str) -> str:
        m = pattern.search(text)
        if not m:
            raise SystemExit(f'No version found in {path}')
        return m.group(2)

    def edit(text: str, new: str) -> str:
        return pattern.sub(lambda m: m.group(1) + new + m.group(3), text, count=1)

    return path, read, edit


FILES = [
    json_version('desktop/src-tauri/tauri.conf.json'),
    toml_version('desktop/src-tauri/Cargo.toml'),
    toml_version('desktop/src-tauri/Cargo.lock', 'marumado-desktop'),
    json_version('desktop/package.json'),
    json_version('desktop/package-lock.json', 2),
    json_version('frontend/package.json'),
    json_version('frontend/package-lock.json', 2),
    toml_version('backend/pyproject.toml'),
    toml_version('backend/uv.lock', 'marumado-backend'),
]


def git(*args: str, check: bool = True) -> str:
    done = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True)
    if check and done.returncode:
        raise SystemExit(f'git {" ".join(args)} failed:\n{done.stderr.strip()}')
    return done.stdout.strip()


def stop(message: str) -> None:
    raise SystemExit(f'Not released: {message}')


def next_version(current: str, wanted: str) -> str:
    parts = current.split('.')
    if wanted in ('patch', 'minor', 'major'):
        if len(parts) != 3 or not all(p.isdigit() for p in parts):
            stop(f'the current version {current} is not X.Y.Z: give the new one (VERSION=1.2.3)')
        major, minor, patch = map(int, parts)
        return {'major': f'{major + 1}.0.0', 'minor': f'{major}.{minor + 1}.0', 'patch': f'{major}.{minor}.{patch + 1}'}[wanted]
    wanted = wanted.removeprefix('v')
    if not re.fullmatch(r'\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?', wanted):
        stop(f'{wanted!r} is not a version: give X.Y.Z, or patch, minor or major')
    return wanted


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    dry, yes = '--dry-run' in sys.argv, '--yes' in sys.argv
    texts = {path: (ROOT / path).read_text() for path, _, _ in FILES}
    versions = {path: read(texts[path]) for path, read, _ in FILES}
    current = versions['desktop/src-tauri/tauri.conf.json']
    if not args:
        print(f'Marumado is at {current}. Release with: make release VERSION=X.Y.Z (or patch, minor, major)')
        sys.exit(1 if not dry else 0)
    new = next_version(current, args[0])

    differ = {p: v for p, v in versions.items() if v != current}
    for path, v in differ.items():
        print(f'Note: {path} said {v}, not {current}: it gets {new} too.')

    # Release only what is on GitHub's main, with nothing left out.
    if git('rev-parse', '--abbrev-ref', 'HEAD') != BRANCH:
        stop(f'release from {BRANCH} (git switch {BRANCH})')
    if not dry and git('status', '--porcelain'):
        stop('there are uncommitted changes: commit or stash them first')
    git('fetch', '--quiet', '--tags', REMOTE, BRANCH)
    if git('rev-list', '--count', f'HEAD..{REMOTE}/{BRANCH}') != '0':
        stop(f'{REMOTE}/{BRANCH} has commits this one lacks: pull first')
    tag = f'v{new}'
    if git('tag', '--list', tag) or git('ls-remote', '--tags', REMOTE, f'refs/tags/{tag}'):
        stop(f'the tag {tag} exists already')
    if new == current and not differ:
        stop(f'Marumado is at {new} already')

    print(f'Marumado {current} → {new}')
    for path, _, edit in FILES:
        changed = edit(texts[path], new)
        if changed != texts[path]:
            print(f'  {path}')
            if not dry:
                (ROOT / path).write_text(changed)
    if dry:
        print(f'Dry run: then commit, tag {tag} and push it to {REMOTE}. Nothing changed.')
        return

    if not yes:
        answer = input(f'Commit, tag {tag} and push to {REMOTE}, which publishes the release? [y/N] ')
        if answer.strip().lower() not in ('y', 'yes'):
            git('checkout', '--', *[p for p, _, _ in FILES])
            stop('stopped; the version files are as they were')

    git('add', *[p for p, _, _ in FILES])
    git('commit', '--quiet', '-m', f'chore: release {tag}')
    git('tag', '-a', tag, '-m', f'Marumado {tag}')
    # Both or neither: a tag without its commit on main, or the reverse, would be a half release.
    git('push', '--atomic', REMOTE, BRANCH, tag)

    url = git('remote', 'get-url', REMOTE)
    m = re.search(r'github\.com[:/](.+?)(?:\.git)?$', url)
    print(f'Pushed {tag}.')
    if m:
        print(f'  The builds:  https://github.com/{m.group(1)}/actions')
        print(f'  The release: https://github.com/{m.group(1)}/releases/tag/{tag} (once the builds finish)')


if __name__ == '__main__':
    main()
