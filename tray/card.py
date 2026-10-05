"""The agents' card: a small window by the tray listing every agent, with what each is doing.

Run by the tray in its own process (Tk wants the main thread, which the tray icon already holds). Who needs you comes
first, then who is working, then the rest. Each row is an agent: its name and kind, its state (how long it has been
working), what its terminal title says it is doing, where it runs, what a plan has queued for it, and, for one working
or waiting on you, the last line of its screen. Choosing a row opens the agent in the browser. Escape closes the card;
Quit tray closes the tray too (X11 trays have no menu to quit from).
"""

from __future__ import annotations

import queue
import sys
import threading
import time
import tkinter as tk
import urllib.parse
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from tkinter import font as tkfont

from marumado_tray import (DONE, IDLE, QUIT_CODE, STATE_WORDS, Config, Reading, ago, doing, key, name_of, read,
                           screen_line, summary, where)

# The recorder at night (DESIGN.md, tokens.css).
GROUND = '#22221f'
SHEET = '#292925'
RAISED = '#2d2d29'
INK = '#eeebe3'
INK_2 = '#bdbab0'
RULE = '#3e3d38'
PEN = '#b9a3e6'  # the agents' pen, wisteria
SIGNAL_TEXT = '#ec8a5c'
SIGNAL = '#e0703f'

ORDER = {'blocked': 0, 'working': 1, 'done': 2, 'idle': 3, 'unknown': 4}
LAMP = {'blocked': SIGNAL, 'working': PEN, 'done': '#{:02x}{:02x}{:02x}'.format(*DONE), 'idle': '#{:02x}{:02x}{:02x}'.format(*IDLE)}
SCREENED = ('working', 'blocked')  # the agents whose screen line is worth reading

WIDTH = 500


def pick(root: tk.Tk, wanted: str, fallback: str) -> str:
    return wanted if wanted in tkfont.families(root) else tkfont.nametofont(fallback).actual('family')


class Card:
    def __init__(self, cfg: Config, since: dict[str, float]):
        self.cfg = cfg
        self.since = since
        self.reading = Reading()
        self.screens: dict[str, str] = {}
        self.inbox: queue.Queue = queue.Queue()
        self.shown: list[tuple[str, str]] = []
        self.rows: dict[str, dict] = {}

        self.root = root = tk.Tk()
        root.title('Agents · Marumado')
        root.configure(bg=GROUND)
        root.minsize(360, 160)
        sans, mono = pick(root, 'Iosevka Aile', 'TkDefaultFont'), pick(root, 'Iosevka', 'TkFixedFont')
        self.f = {
            'title': (sans, 15), 'name': (sans, 12, 'bold'), 'body': (sans, 11), 'small': (sans, 10),
            'mono': (mono, 10), 'mono-sm': (mono, 9),
        }

        head = tk.Frame(root, bg=GROUND)
        head.pack(fill='x', padx=16, pady=(14, 8))
        self.title = tk.Label(head, text='Reading Marumado…', font=self.f['title'], fg=INK, bg=GROUND, anchor='w')
        self.title.pack(side='left')
        self.link(head, 'Agents page', lambda: webbrowser.open(f'{cfg.url}/#/m/agents')).pack(side='right')

        foot = tk.Frame(root, bg=GROUND)
        foot.pack(side='bottom', fill='x', padx=16, pady=(0, 12))
        self.link(foot, 'Open Marumado', lambda: webbrowser.open(f'{cfg.url}/')).pack(side='left')
        self.link(foot, 'Quit tray', lambda: (root.destroy(), sys.exit(QUIT_CODE))).pack(side='right')
        self.hint = tk.Label(root, text='', font=self.f['small'], fg=INK_2, bg=GROUND, anchor='w', justify='left', wraplength=WIDTH - 32)

        # The list scrolls when there are more agents than the screen holds.
        self.body = body = tk.Frame(root, bg=GROUND)
        body.pack(fill='both', expand=True, padx=(16, 4), pady=(0, 14))
        self.canvas = tk.Canvas(body, bg=GROUND, highlightthickness=0, bd=0)
        self.scroll = tk.Scrollbar(body, orient='vertical', command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=self.scroll.set)
        self.canvas.pack(side='left', fill='both', expand=True)
        self.list = tk.Frame(self.canvas, bg=GROUND)
        self.window = self.canvas.create_window((0, 0), window=self.list, anchor='nw')
        self.list.bind('<Configure>', lambda _e: self.fit())
        self.canvas.bind('<Configure>', lambda e: self.canvas.itemconfigure(self.window, width=e.width - 12))
        root.bind_all('<MouseWheel>', lambda e: self.canvas.yview_scroll(-1 if e.delta > 0 else 1, 'units'))
        root.bind_all('<Button-4>', lambda _e: self.canvas.yview_scroll(-1, 'units'))
        root.bind_all('<Button-5>', lambda _e: self.canvas.yview_scroll(1, 'units'))
        root.bind('<Escape>', lambda _e: root.destroy())

        self.place()
        threading.Thread(target=self.watch, daemon=True).start()
        root.after(100, self.drain)
        root.after(1000, self.tick)

    def link(self, parent: tk.Widget, text: str, act) -> tk.Label:
        link = tk.Label(parent, text=text, font=self.f['small'], fg=INK_2, bg=GROUND, cursor='hand2')
        link.bind('<Button-1>', lambda _e: act())
        link.bind('<Enter>', lambda _e: link.configure(fg=INK, font=self.f['small'] + ('underline',)))
        link.bind('<Leave>', lambda _e: link.configure(fg=INK_2, font=self.f['small']))
        return link

    # ---------- where it sits ----------

    def place(self):
        """By the tray: bottom right on Windows, top right elsewhere (macOS's menu bar, most Linux panels)."""
        self.root.update_idletasks()
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        h = min(560, int(sh * 0.7))
        y = sh - h - 64 if sys.platform == 'win32' else 40
        self.root.geometry(f'{WIDTH}x{h}+{sw - WIDTH - 16}+{y}')
        self.root.lift()
        self.root.focus_force()

    def fit(self):
        self.canvas.configure(scrollregion=self.canvas.bbox('all'))
        overflow = self.list.winfo_reqheight() > self.canvas.winfo_height()
        if overflow and not self.scroll.winfo_ismapped():
            self.scroll.pack(side='right', fill='y')
        elif not overflow and self.scroll.winfo_ismapped():
            self.scroll.pack_forget()

    # ---------- reading, off the Tk thread ----------

    def watch(self):
        pool = ThreadPoolExecutor(max_workers=6)
        last_screens = 0.0
        while True:
            r = read(self.cfg)
            self.inbox.put(('reading', r))
            if not r.error and time.time() - last_screens > 5:
                last_screens = time.time()
                screened = [a for a in r.agents if a['status'] in SCREENED]
                for a, screen in zip(screened, pool.map(self.screen, screened)):
                    self.inbox.put(('screen', (key(a), screen)))
            time.sleep(self.cfg.every)

    def screen(self, a: dict) -> str:
        q = urllib.parse.urlencode({'lines': 40, 'source': a.get('source', 0)})
        try:
            return screen_line(self.cfg.get(f'agents/{urllib.parse.quote(a["pane_id"], safe="")}/output?{q}')['output'])
        except Exception:
            return ''

    def drain(self):
        try:
            while True:
                kind, value = self.inbox.get_nowait()
                if kind == 'reading':
                    self.show(value)
                else:
                    k, line = value
                    self.screens[k] = line
                    if k in self.rows:
                        self.rows[k]['screen'].configure(text=line)
        except queue.Empty:
            pass
        except tk.TclError:
            return  # closed
        self.root.after(150, self.drain)

    def tick(self):
        """Working times move on between readings."""
        now = time.time()
        for k, row in self.rows.items():
            if k in self.since and row['status'] == 'working':
                row['since'].configure(text=f'working {ago(now - self.since[k])}')
        self.root.after(15_000, self.tick)

    # ---------- the list ----------

    def show(self, r: Reading):
        self.reading = r
        agents = sorted(r.agents, key=lambda a: ORDER.get(a['status'], 5))
        now = time.time()
        for a in agents:
            if a['status'] == 'working':
                self.since.setdefault(key(a), now)
            else:
                self.since.pop(key(a), None)
        if r.error:
            self.title.configure(text='Marumado can\'t be read', fg=SIGNAL_TEXT, font=self.f['title'])
            hint = r.error
            if r.refused:
                hint += ' Print the right one with `make access-token` and start the tray with --token.'
            self.hint.configure(text=hint)
            if not self.hint.winfo_ismapped():
                self.hint.pack(fill='x', padx=16, pady=(0, 8), before=self.body)
        else:
            self.title.configure(text=summary(r), fg=INK, font=self.f['title'])
            self.hint.pack_forget()
        keys = [(key(a), a['status']) for a in agents]
        if keys != self.shown:
            for child in self.list.winfo_children():
                child.destroy()
            self.rows = {}
            for a in agents:
                self.rows[key(a)] = self.row(a, r)
            self.shown = keys
        else:
            for a in agents:
                row = self.rows[key(a)]
                row['doing'].configure(text=self.doing(a))
                row['where'].configure(text=self.where(a, r))

    def doing(self, a: dict) -> str:
        return doing(a) or ('working' if a['status'] == 'working' else '')

    def where(self, a: dict, r: Reading) -> str:
        """Where it works, and what a plan has queued for it next."""
        folder = (a.get('cwd') or '').rstrip('/').rsplit('/', 1)[-1]
        bits = [where(a, r)]
        if folder and not (a.get('project') and a['project']['name'] == folder):
            bits.append(folder)
        line = ' · '.join(b for b in bits if b) or 'no project'
        queued = a.get('queued') or []
        if queued:
            line += f'\nnext: {queued[0]["title"]}' + (' (waits for your go)' if queued[0].get('asking') else '') + (f' (+{len(queued) - 1} queued)' if len(queued) > 1 else '')
        return line

    def row(self, a: dict, r: Reading) -> dict:
        k, status = key(a), a['status']
        frame = tk.Frame(self.list, bg=SHEET, cursor='hand2', highlightthickness=1, highlightbackground=RULE, highlightcolor=RULE)
        frame.pack(fill='x', pady=(0, 6))
        top = tk.Frame(frame, bg=SHEET)
        top.pack(fill='x', padx=12, pady=(10, 2))
        lamp = tk.Canvas(top, width=10, height=10, bg=SHEET, highlightthickness=0)
        colour = LAMP.get(status, LAMP['idle'])
        if status in ('idle', 'unknown'):
            lamp.create_oval(1, 1, 9, 9, outline=colour, width=2)  # off: a ring
        else:
            lamp.create_oval(1, 1, 9, 9, fill=colour, outline=colour)
        lamp.pack(side='left', padx=(0, 8))
        name = tk.Label(top, text=name_of(a), font=self.f['name'], fg=INK, bg=SHEET)
        name.pack(side='left')
        kind = tk.Label(top, text=f'  {a.get("kind", "")}', font=self.f['small'], fg=INK_2, bg=SHEET)
        kind.pack(side='left')
        state = f'working {ago(time.time() - self.since.get(k, time.time()))}' if status == 'working' else STATE_WORDS.get(status, status)
        since = tk.Label(top, text=state, font=self.f['mono-sm'], fg=SIGNAL_TEXT if status == 'blocked' else INK_2, bg=SHEET)
        since.pack(side='right')
        what = tk.Label(frame, text=self.doing(a), font=self.f['body'], fg=INK, bg=SHEET, anchor='w', justify='left', wraplength=WIDTH - 70)
        what.pack(fill='x', padx=(30, 12))
        place = tk.Label(frame, text=self.where(a, r), font=self.f['small'], fg=INK_2, bg=SHEET, anchor='w', justify='left')
        place.pack(fill='x', padx=(30, 12), pady=(0, 10))
        parts = [frame, top, lamp, name, kind, since, what, place]
        screen = tk.Label(frame, text=self.screens.get(k, ''), font=self.f['mono'], fg=INK_2, bg=SHEET, anchor='w', justify='left', wraplength=WIDTH - 70)
        if status in SCREENED:
            place.pack_configure(pady=0)
            screen.pack(fill='x', padx=(30, 12), pady=(4, 10))
            parts.append(screen)
        href = self.cfg.agent_href(a)

        def paint(bg: str):
            for w in parts:
                w.configure(bg=bg)

        for w in parts:
            w.bind('<Button-1>', lambda _e: webbrowser.open(href))
            w.bind('<Enter>', lambda _e: paint(RAISED))
            w.bind('<Leave>', lambda _e: paint(SHEET))
        return {'doing': what, 'where': place, 'screen': screen, 'since': since, 'status': status}


def run_card(cfg: Config, since: dict[str, float]):
    Card(cfg, since).root.mainloop()
