# Marumado tray

Your coding agents in the system tray, read from Marumado's API, so you can follow them without a tab open.

```sh
uv run tray/marumado_tray.py                                   # Marumado on this machine
uv run tray/marumado_tray.py --url http://127.0.0.1:7878 --token-file ~/marumado-token
```

`uv` installs its two dependencies (pystray, Pillow) on the first run. It needs Marumado's address (`--url` or
`MARUMADO_URL`, default `http://127.0.0.1:7878`) and its access token: `--token` / `MARUMADO_TOKEN`, or `--token-file`
/ `MARUMADO_TOKEN_FILE`. Given neither, it looks in this repo's `.env`, then asks the `marumado` Docker container
(`make up` keeps its token in the container's data volume, not in `backend/data`), then reads
`backend/data/access-token` (`make dev`), moving on whenever Marumado refuses one. It says in the terminal which one it
uses. For a Marumado on another machine, open an SSH tunnel to its port first, or point `--url` at its address on the
LAN, and pass its token (`make access-token` there prints it).

## What it shows

- **The icon**: one arc per agent, wisteria while working, blue once it has finished its turn, grey when idle; in the
  middle, how many need you on a persimmon disc, or else how many are working; a grey ring struck through in persimmon
  when Marumado can't be read (wrong address or token: the terminal says which). The tooltip says it in words.
- **The card**, on a click on the icon (or *Show agents…* in the menu; a second click closes it): every agent, who needs you first, then who is
  working and for how long, then the rest; what its terminal title says it is doing, its project and source, what a
  plan has queued for it, and the last line of its screen. Choosing an agent opens its page in the browser.
- **The menu**: who needs you, then who is working (past three, *See all N working agents…* opens the card).
- **Notifications** when an agent starts waiting for you or finishes its turn, where the desktop supports them.

## Desktops

- **Windows, macOS**: work as they are: a left click opens the card, a right click the menu.
- **Linux (GNOME, KDE)**: the tray's own icon (AppIndicator) needs PyGObject. uv's Pythons don't have it, so the tray
  borrows the system Python's (`/usr/bin/python3`): it uses that Python's copy when the versions match, and otherwise
  starts again on that Python by itself (`uv run --python /usr/bin/python3 …`). It also needs AppIndicator's
  introspection data: `sudo apt install python3-gi gir1.2-ayatanaappindicator3-0.1` (Debian, Ubuntu) or `sudo dnf
  install python3-gobject libayatana-appindicator-gtk3` (Fedora). On GNOME, also turn on the *AppIndicator and
  KStatusNotifierItem Support* extension (Ubuntu has it on already). A click then shows the menu, whose *Show agents…*
  opens the card. The terminal says `tray: appindicator` when it all worked.
- **Linux, otherwise**: without them, pystray falls back to a plain X11 icon, which has no menu and no notifications
  (GNOME shows it only as a legacy icon): a click opens the card, and the card's *Quit tray* closes the tray.
- **The card** needs Tk. uv's own Pythons include it; a system Python may not (Debian: `python3-tk`), and then the
  card's entry opens the Agents page instead.

Start it with your session (Windows: a shortcut in `shell:startup`; macOS: a Login Item; Linux: a `.desktop` file in
`~/.config/autostart`) to keep it there.

Tests (no desktop needed): `uv run --no-project --with pillow python -m unittest tray/test_tray.py`
