# /// script
# requires-python = ">=3.11"
# dependencies = ["pystray>=0.19", "pillow>=10"]
# ///
"""Marumado in the system tray: every coding agent Marumado sees, at a glance, without a tab open.

The icon is the agent dock's round window in miniature: one arc per agent (pale wisteria when working, blue when it
has finished its turn, grey when idle), a persimmon disc when one needs you, a dashed ring when Marumado can't be
reached. Its menu lists who needs you and who is working; past three working agents, one entry opens a card that
lists them all with what each is doing. Choosing an agent opens its page in the browser.

It only reads Marumado's API (GET /api/agents, and each working agent's screen while the card is open).

    uv run tray/marumado_tray.py                       # Marumado on this machine, token from backend/data
    uv run tray/marumado_tray.py --url http://127.0.0.1:7878 --token-file ~/marumado-token

Settings, by flag or environment: --url / MARUMADO_URL (default http://127.0.0.1:7878), --token / MARUMADO_TOKEN,
--token-file / MARUMADO_TOKEN_FILE, --every (seconds, 3). Without a token it looks, in order, in this repo's .env, in
the `marumado` Docker container (`make up`), then in backend/data/access-token (`make dev`), and moves on to the next
one when Marumado refuses it.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
CONTAINER = 'marumado'  # compose.yaml's container_name
# Up to this many working agents are listed in the menu itself; past it, one entry opens the card with all of them.
MENU_WORKING = 3

# The night palette's pens (DESIGN.md), mid enough to hold on a light or a dark tray.
TRACK = (122, 119, 111)
IDLE = (150, 147, 139)
WORKING = (170, 146, 222)  # the agents' pen, wisteria
DONE = (111, 159, 199)  # still blue: finished its turn
SIGNAL = (224, 112, 63)  # persimmon: needs you
INK = (238, 235, 227)
GROUND = (34, 34, 31)  # the night ground, behind the icon where the tray can't show transparency
# The card exits with this to quit the tray too: the X11 tray has no menu to quit from.
QUIT_CODE = 3


def log(message: str):
    print(f'marumado-tray: {message}', file=sys.stderr, flush=True)


def has_tk() -> bool:
    """Whether this Python can open the card (Debian's leaves Tk to python3-tk)."""
    return all(importlib.util.find_spec(m) is not None for m in ('tkinter', '_tkinter'))

STATE_WORDS = {'blocked': 'needs you', 'working': 'working', 'done': 'finished its turn', 'idle': 'idle', 'unknown': 'state unknown'}


# ---------- reading Marumado ----------


@dataclass
class Config:
    url: str
    token: str
    every: float = 3.0
    token_from: str = ''
    # Other places a token may be, tried in turn when Marumado refuses this one.
    spare: list[tuple[str, Callable[[], str]]] = field(default_factory=list)

    def next_token(self) -> bool:
        while self.spare:
            where, find = self.spare.pop(0)
            token = find()
            if token and token != self.token:
                self.token, self.token_from = token, where
                return True
        return False

    def get(self, path: str, timeout: float = 8):
        req = urllib.request.Request(f'{self.url}/api/{path}', headers={'Authorization': f'Bearer {self.token}', 'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.load(res)

    def agent_href(self, a: dict) -> str:
        return f'{self.url}/#/m/agents/{a.get("source", 0)}/{a["pane_id"]}'


def from_file(path: Path) -> Callable[[], str]:
    def find() -> str:
        try:
            return path.expanduser().read_text().strip()
        except OSError:
            return ''
    return find


def from_env_file(path: Path) -> str:
    """MARUMADO_TOKEN from the repo's .env, when it sets one (it's empty when Marumado made its own)."""
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return ''
    for line in lines:
        name, _, value = line.partition('=')
        if name.strip() == 'MARUMADO_TOKEN':
            return value.split(' #')[0].strip().strip('\'"')
    return ''


def from_docker() -> str:
    """The token Marumado made on its first run, inside its container (the data volume isn't this repo's backend/data)."""
    try:
        out = subprocess.run(['docker', 'exec', CONTAINER, 'python', 'manage.py', 'token'], capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.SubprocessError):
        return ''
    lines = out.stdout.strip().splitlines()
    return lines[-1].strip() if out.returncode == 0 and lines else ''


def load_config(argv: list[str] | None = None) -> tuple[Config, argparse.Namespace]:
    p = argparse.ArgumentParser(description='Marumado agents in the system tray.')
    p.add_argument('--url', default=os.environ.get('MARUMADO_URL', 'http://127.0.0.1:7878'))
    p.add_argument('--token', default=os.environ.get('MARUMADO_TOKEN', ''))
    p.add_argument('--token-file', default=os.environ.get('MARUMADO_TOKEN_FILE', ''))
    p.add_argument('--every', type=float, default=3.0, help='seconds between readings')
    p.add_argument('--card', action='store_true', help=argparse.SUPPRESS)  # the agents' card, run by the tray
    args = p.parse_args(argv)
    if args.token.strip():
        places = [('--token', lambda: args.token.strip())]
    elif args.token_file:
        places = [(args.token_file, from_file(Path(args.token_file)))]
    else:
        places = [
            (str(REPO / '.env'), lambda: from_env_file(REPO / '.env')),
            (f'the {CONTAINER} container', from_docker),
            (str(REPO / 'backend' / 'data' / 'access-token'), from_file(REPO / 'backend' / 'data' / 'access-token')),
        ]
    cfg = Config(args.url.rstrip('/'), '', max(1.0, args.every), spare=places)
    if not cfg.next_token():
        tried = ', '.join(where for where, _ in places)
        p.error(f'No access token (tried {tried}). Print it with `make access-token` and pass it with --token, or set MARUMADO_TOKEN.')
    return cfg, args


def key(a: dict) -> str:
    """Pane ids are only unique within one Herdr: an agent is its source and its pane."""
    return f'{a.get("source", 0)}/{a["pane_id"]}'


def name_of(a: dict) -> str:
    return a.get('name') or a.get('kind') or a['pane_id']


def doing(a: dict) -> str:
    """What the agent's terminal title says it is doing (Claude Code titles it with the task), if it says more than its kind."""
    title = (a.get('title') or '').strip()
    return '' if title.lower() in ('', (a.get('kind') or '').lower(), 'claude code') else title


def ago(seconds: float) -> str:
    m = int(seconds // 60)
    if m < 1:
        return 'just now'
    if m < 60:
        return f'{m} min'
    return f'{m // 60} h {m % 60:02d}'


# ---------- what the tray shows ----------


@dataclass
class Reading:
    """One look at Marumado: the agents (plain terminals aside), or why there are none."""

    agents: list[dict] = field(default_factory=list)
    sources: dict[int, str] = field(default_factory=dict)
    error: str = ''
    refused: bool = False  # the access token was refused

    def having(self, status: str) -> list[dict]:
        return [a for a in self.agents if a['status'] == status]


def read(cfg: Config) -> Reading:
    try:
        data = cfg.get('agents')
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return Reading(error=f'Marumado refused the access token (from {cfg.token_from}).', refused=True)
        return Reading(error=f'Marumado answered {exc.code}.')
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return Reading(error=f"Can't reach Marumado at {cfg.url} ({getattr(exc, 'reason', exc)}).")
    if not data.get('available'):
        return Reading(error=data.get('error') or 'Herdr is not running.')
    return Reading(
        agents=[a for a in data.get('agents', []) if a.get('kind') != 'terminal'],
        sources={s['id']: s['name'] for s in data.get('sources', [])},
    )


def summary(r: Reading) -> str:
    """The tooltip and the menu's first line."""
    if r.error:
        return r.error
    if not r.agents:
        return 'No agents running'
    counts = [(len(r.having('blocked')), 'needs you', 'need you'), (len(r.having('working')), 'working', 'working'),
              (len(r.having('done')), 'finished', 'finished'), (len(r.having('idle')), 'idle', 'idle')]
    return ' · '.join(f'{n} {one if n == 1 else many}' for n, one, many in counts if n)


def where(a: dict, r: Reading) -> str:
    """The agent's project, and the place it runs when there are several."""
    bits = [a['project']['name']] if a.get('project') else []
    if len(r.sources) > 1:
        bits.append(r.sources.get(a.get('source', 0), ''))
    return ' · '.join(b for b in bits if b)


def agent_line(a: dict, r: Reading, since: dict[str, float], now: float) -> str:
    """A menu entry: name, where, and how long it has been at it."""
    line = name_of(a)
    if at := where(a, r):
        line += f' · {at}'
    if a['status'] == 'working' and key(a) in since:
        line += f' — {ago(now - since[key(a)])}'
    if queued := a.get('queued') or []:
        line += f' · {len(queued)} queued' + (', next waits for your go' if queued[0].get('asking') else '')
    return line


@dataclass
class Entry:
    """A menu entry, kept free of pystray so it can be checked without a desktop. `href`: open it in the browser;
    `card`: open the agents' card; neither: a line of text."""

    text: str
    href: str = ''
    card: bool = False
    rule: bool = False  # a separator
    default: bool = False  # what a click on the icon does, where the desktop has one (Windows, X11)


def menu_model(cfg: Config, r: Reading, since: dict[str, float], now: float, card: bool = False) -> list[Entry]:
    """`card`: whether the agents' card can open here. A click on the icon then opens it: on X11 trays, which have
    no menu, it is the only way in."""
    entries = [Entry(summary(r))]
    if card:
        entries.append(Entry('Show agents…', card=True, default=True))
    if r.error:
        return entries + [Entry('', rule=True), Entry('Open Marumado', href=f'{cfg.url}/', default=not card)]
    blocked, working = r.having('blocked'), r.having('working')
    if blocked:
        entries += [Entry('', rule=True), Entry('Needs you')]
        entries += [Entry(f'   {agent_line(a, r, since, now)}', href=cfg.agent_href(a)) for a in blocked]
    if working:
        entries += [Entry('', rule=True)]
        if len(working) > MENU_WORKING:
            entries.append(Entry(f'See all {len(working)} working agents…', card=True, default=not card))
        else:
            entries.append(Entry('Working'))
            entries += [Entry(f'   {agent_line(a, r, since, now)}', href=cfg.agent_href(a)) for a in working]
    carded = any(e.default for e in entries)
    entries += [Entry('', rule=True), Entry('Agents', href=f'{cfg.url}/#/m/agents', default=not carded), Entry('Open Marumado', href=f'{cfg.url}/')]
    return entries


def draw_icon(r: Reading, size: int = 64, opaque: bool = False):
    """The round window: one arc per agent from twelve o'clock, drawn 4× and scaled down so the arcs stay smooth.
    `opaque`: on the night ground, for trays that can't show transparency (X11's), which would otherwise turn it black."""
    from PIL import Image, ImageDraw

    s = size * 4
    img = Image.new('RGBA', (s, s), GROUND + (255,) if opaque else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad, width = s * 0.1, round(s * 0.13)
    box = (pad, pad, s - pad, s - pad)
    if r.error:
        # Nothing to read: an empty ring, struck through.
        d.ellipse(box, outline=TRACK + (255,), width=round(s * 0.08))
        d.line((s * 0.24, s * 0.76, s * 0.76, s * 0.24), fill=SIGNAL + (255,), width=round(s * 0.1))
        return img.resize((size, size), Image.LANCZOS)
    blocked = r.having('blocked')
    if blocked:
        c = s / 2
        d.ellipse((c - s * 0.2, c - s * 0.2, c + s * 0.2, c + s * 0.2), fill=SIGNAL + (255,))
    if not r.agents:
        d.ellipse(box, outline=TRACK + (255,), width=max(2, round(s * 0.035)))
    # Who needs you first, then who's working, finished, idle: the same order as the counts.
    order = {'blocked': 0, 'working': 1, 'done': 2, 'idle': 3, 'unknown': 4}
    agents = sorted(r.agents, key=lambda a: order.get(a['status'], 5))
    colour = {'blocked': SIGNAL, 'working': WORKING, 'done': DONE}
    n = len(agents)
    if n == 1:
        d.ellipse(box, outline=colour.get(agents[0]['status'], IDLE) + (255,), width=width)
    elif n:
        gap = max(14, 360 / n * 0.22)  # wide enough to count them at 16 px
        for i, a in enumerate(agents):
            start = -90 + i * 360 / n + gap / 2
            d.arc(box, start, start + 360 / n - gap, fill=colour.get(a['status'], IDLE) + (255,), width=width)
    if not blocked:
        c, hub = s / 2, s * 0.06
        d.ellipse((c - hub, c - hub, c + hub, c + hub), fill=(WORKING if r.having('working') else TRACK) + (255,))
    return img.resize((size, size), Image.LANCZOS)


# ---------- the screen, for the card ----------

BORDER = re.compile(r'[│┃║╭╮╰╯┌┐└┘├┤─━═╌╍▏▕]')
# Claude Code's activity line: "✻ Pondering… (12s · ↑ 1.2k tokens · esc to interrupt)".
ACTIVITY = re.compile(r'esc to interrupt', re.I)
NOISE = re.compile(r'^(>|\?\s|⏵⏵|bypass permissions|accept edits)|for shortcuts', re.I)


def screen_line(screen: str) -> str:
    """The one line of an agent's screen worth showing: its activity line if it has one, else the last line of text."""
    lines = [BORDER.sub('', line).strip() for line in screen.splitlines()]
    lines = [line for line in lines if re.search(r'\w', line)]
    for line in reversed(lines):
        if ACTIVITY.search(line):
            return re.sub(r'\s*[·(]?\s*esc to interrupt\)?', ')', line).replace('())', '').replace(' )', ')').strip()
    for line in reversed(lines):
        if not NOISE.search(line):
            return line
    return ''


# ---------- the tray ----------


class Tray:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.reading = Reading(error='Reading Marumado…')
        self.since: dict[str, float] = {}  # when each agent was first seen working, this time
        self.last: dict[str, str] = {}
        self.card: subprocess.Popen | None = None
        self.can_card = has_tk()
        self.opaque = False
        self.icon = None
        self.stop = threading.Event()

    def run(self):
        import pystray

        self.pystray = pystray
        self.icon = pystray.Icon('marumado', None, 'Marumado', menu=pystray.Menu(self.items))
        backend = type(self.icon).__module__.rsplit('.', 1)[-1].lstrip('_')
        self.opaque = backend == 'xorg'
        self.icon.icon = draw_icon(self.reading, opaque=self.opaque)
        log(f'reading {self.cfg.url} with the token from {self.cfg.token_from}; tray: {backend}')
        if not self.icon.HAS_MENU:
            log('this tray has no menus (pystray\'s X11 fallback): a click opens the agents card'
                + ('' if self.can_card else ', but this Python has no Tk, so it opens the Agents page')
                + '. For a menu, see tray/README.md (Linux).')
        elif not self.can_card:
            log('this Python has no Tk: the card opens the Agents page instead (see tray/README.md).')
        self.icon.run(setup=self.start)

    def start(self, icon):
        icon.visible = True
        threading.Thread(target=self.poll, daemon=True).start()

    def poll(self):
        while not self.stop.is_set():
            r = read(self.cfg)
            while r.refused and self.cfg.next_token():
                log(f'token refused; trying the one from {self.cfg.token_from}')
                r = read(self.cfg)
            if r.error != self.reading.error:
                log(r.error or f'reading: {summary(r)}')
            self.update(r)
            self.stop.wait(self.cfg.every)

    def update(self, r: Reading):
        now = time.time()
        if not r.error:
            for a in r.agents:
                k, was = key(a), self.last.get(key(a))
                if a['status'] == 'working':
                    self.since.setdefault(k, now)
                else:
                    self.since.pop(k, None)
                # Tell the desktop when one starts waiting or finishes, as the browser's notifications do.
                if was and was != a['status']:
                    if a['status'] == 'blocked':
                        self.notify(f'{name_of(a)} needs you', doing(a) or where(a, r))
                    elif a['status'] in ('done', 'idle') and was == 'working':
                        self.notify(f'{name_of(a)} finished its turn', doing(a) or where(a, r))
            self.last = {key(a): a['status'] for a in r.agents}
        self.reading = r
        if self.icon:
            self.icon.icon = draw_icon(r, opaque=self.opaque)
            self.icon.title = f'Marumado: {summary(r)}'[:127]  # Windows cuts tooltips at 128
            self.icon.update_menu()

    def notify(self, title: str, message: str):
        if self.icon and getattr(self.icon, 'HAS_NOTIFICATION', False):
            try:
                self.icon.notify(message or ' ', title)
            except Exception:
                pass  # a desktop without notifications: the icon still says it

    def items(self):
        pystray = self.pystray
        for e in menu_model(self.cfg, self.reading, self.since, time.time(), card=self.can_card):
            if e.rule:
                yield pystray.Menu.SEPARATOR
            elif e.card:
                yield pystray.MenuItem(e.text, lambda *_: self.open_card(), default=e.default)
            elif e.href:
                yield pystray.MenuItem(e.text, (lambda href: lambda *_: webbrowser.open(href))(e.href), default=e.default)
            else:
                yield pystray.MenuItem(e.text, None, enabled=False)
        yield pystray.Menu.SEPARATOR
        yield pystray.MenuItem('Quit', lambda *_: self.quit())

    def open_card(self):
        if self.card and self.card.poll() is None:
            return  # already open
        if not self.can_card:
            webbrowser.open(f'{self.cfg.url}/#/m/agents')
            return
        env = {**os.environ, 'MARUMADO_URL': self.cfg.url, 'MARUMADO_TOKEN': self.cfg.token, 'MARUMADO_TRAY_SINCE': json.dumps(self.since)}
        try:
            self.card = card = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--card'], env=env)
        except OSError as exc:
            log(f"couldn't open the card: {exc}")
            webbrowser.open(f'{self.cfg.url}/#/m/agents')
            return

        def wait():
            code = card.wait()
            if code == QUIT_CODE:
                self.quit()
            elif code:
                log(f'the card closed with an error ({code}); its output is above')

        threading.Thread(target=wait, daemon=True).start()

    def quit(self):
        self.stop.set()
        if self.card and self.card.poll() is None:
            self.card.terminate()
        if self.icon:
            self.icon.stop()


def main(argv: list[str] | None = None):
    cfg, args = load_config(argv)
    if args.card:
        from card import run_card  # beside this script

        run_card(cfg, json.loads(os.environ.get('MARUMADO_TRAY_SINCE') or '{}'))
        return
    Tray(cfg).run()


if __name__ == '__main__':
    sys.path.insert(0, str(HERE))
    main()
