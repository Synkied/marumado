#!/usr/bin/env python3
"""The desktop app's update manifest, latest.json: for each system and kind of install, the release's signed bundle and
its signature. The app reads it from the latest release (plugins.updater in desktop/src-tauri/tauri.conf.json).

  latest_json.py BUNDLES_DIR VERSION REPO > latest.json

BUNDLES_DIR holds the bundles of a tag's build, each with the .sig `tauri build` writes next to it when it makes the
updater's artifacts (desktop.yml). Every bundle named here must be there: an update the app can't find is worse than
the build failing.
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# The updater's targets ({os}-{arch}-{installer}, else {os}-{arch}), and the bundle each is updated from.
TARGETS = {
    'linux-x86_64-appimage': '*.AppImage',
    'linux-x86_64-deb': '*.deb',
    'linux-x86_64-rpm': '*.rpm',
    'linux-x86_64': '*.AppImage',
    'windows-x86_64-nsis': '*-setup.exe',
    'windows-x86_64-msi': '*.msi',
    'windows-x86_64': '*-setup.exe',
    # One universal app for both.
    'darwin-aarch64-app': '*.app.tar.gz',
    'darwin-x86_64-app': '*.app.tar.gz',
    'darwin-aarch64': '*.app.tar.gz',
    'darwin-x86_64': '*.app.tar.gz',
}


def main(bundles: Path, version: str, repo: str) -> dict:
    platforms = {}
    for target, pattern in TARGETS.items():
        found = sorted(bundles.rglob(pattern))
        if len(found) != 1:
            raise SystemExit(f'{target}: {len(found)} bundles match {pattern} in {bundles}, not one')
        bundle = found[0]
        sig = bundle.with_name(bundle.name + '.sig')
        if not sig.is_file():
            raise SystemExit(f'{target}: {bundle} has no signature ({sig.name})')
        platforms[target] = {
            'signature': sig.read_text().strip(),
            'url': f'https://github.com/{repo}/releases/download/v{version}/{bundle.name}',
        }
    return {
        'version': version,
        'notes': f'https://github.com/{repo}/releases/tag/v{version}',
        'pub_date': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'platforms': platforms,
    }


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    print(json.dumps(main(Path(sys.argv[1]), sys.argv[2], sys.argv[3]), indent=2))
