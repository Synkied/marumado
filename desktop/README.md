# Marumado desktop app

Marumado in a window of its own, with the tray icon, the agents' card and notifications. It sits beside the web app:
the browser keeps working as it does.

A browser can't hand an open tab to another program or bring it to the front, so every click in a tray opened a new
tab. The app owns its window, and every page opens in that one window (`#/m/agents`, an agent, Home), brought to the
front.

## How it fits

- The window loads Marumado from its address (`http://127.0.0.1:7878` by default, or another machine's). It doesn't
  bundle the web app: the API is on relative paths, the login is Marumado's HttpOnly cookie and the terminal's
  websocket uses the same address, so the frontend runs unchanged, and one build works with any Marumado.
- On first run, the bundled page in `setup/` asks for the address and the access token (`make access-token`), checks
  them by logging in (`POST /api/auth`), and keeps them in the app's config folder (`config.json`, readable by you
  only). The token stays with the app because the tray reads `GET /api/agents` on its own every 3 s. The window logs
  itself in with it too: Marumado's login page asks the app for it (`frontend/src/lib/desktop.ts`).
- The frontend checks whether it runs in the app (`window.__TAURI_INTERNALS__`) and only then adds the desktop's
  extras: the card (`#/card`, `frontend/src/modules/agentCard.tsx`), the automatic login, and leaving notifications
  to the app. Marumado's pages may call only the app's own commands (`login_token`, `open_page`, `hide_card`,
  `fit_card`, `working_since`, `reconnect`), granted at run time to the address you gave.
- Links to Marumado's pages stay in the app's window (a link that opens a new tab opens the page in it instead);
  links to other sites open in your browser.
- When the app starts and the Marumado on this machine (`127.0.0.1`, `localhost`) doesn't answer, the app starts its
  containers itself: `docker compose up -d` in the checkout the app was built from (`make up` there if it has no
  `.env` yet), retrying for a minute and a half while Docker starts with the session. Meanwhile the window shows *Starting
  Marumado…* (`setup/starting.html`, or why it couldn't), and opens Marumado as soon as it answers. A
  `"folder"` in `config.json` names another checkout. *Quit Marumado* stops the containers the app started
  (`docker compose stop`), and only those: a Marumado started with `make up`, or by Docker at boot, keeps running.
- Closing the window keeps the app in the tray. *Quit Marumado* in the tray's menu ends it. The window keeps its size
  and place, maximized or full screen, from one run to the next.

The tray icon: one arc per agent (wisteria while working, blue once it has finished its turn, grey when idle); in the
middle, how many need you on a persimmon disc, or else how many are working; a grey ring struck through when Marumado
can't be read. The icon and the menu are handed to the tray only when they change (GNOME closes an open menu when it
is replaced), so the menu holds no running times: the card has them.

The menu: *Show agents…* (the card), what is going on in a line, who needs you and who is working (past three
working agents, *See all N working agents…* opens the card instead), the Agents page, Marumado's home page, then
*Notify me*, *Start with the session*, *Connect to another Marumado…* and *Quit Marumado*.

## Command line

```sh
marumado-desktop                 # opens the window (a second launch brings the first one's to the front)
marumado-desktop '#/m/agents'    # that page, in the running app's window
marumado-desktop --card          # opens or closes the card: bind it to a key where the icon gets no clicks
marumado-desktop --hidden        # only the tray (how it starts with the session)
```

## Desktops

- **Windows, macOS**: a left click on the icon opens the card by the icon, a right click the menu.
- **Linux**: Tauri's tray goes through AppIndicator (libayatana-appindicator), which reports no clicks: a click opens
  the menu, whose first entry, *Show agents…*, opens the card at the top right of the main monitor. On GNOME, turn on
  the *AppIndicator and KStatusNotifierItem Support* extension (Ubuntu has it on already). The window is WebKitGTK.
  Under Wayland the card can't place itself, and the compositor puts it where it likes.

## Build it

```sh
cd desktop && npm install
npm run dev      # a debug build, run at once
npm run build    # the bundles, in src-tauri/target/release/bundle/
cd src-tauri && cargo test    # the tray's logic and icon, without a desktop
```

Rust and Tauri's [prerequisites](https://v2.tauri.app/start/prerequisites/) for your system, including on Linux
`libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev` (Debian, Ubuntu): without the AppIndicator one,
`npm run build` builds the program and then fails to bundle it ("Can't detect any appindicator library"). Install
the `.deb` from `bundle/deb/` to get Marumado in the app list, where Ubuntu can pin it to the dock. GitHub Actions builds it for
Linux, Windows and macOS on every change here (`.github/workflows/desktop.yml`) and keeps the bundles as the run's
artifacts. They aren't signed yet.

`npm run icons` remakes the app's icons from `app-icon.svg` (needs `rsvg-convert`). The tray icon's digits are Iosevka
Aile Bold, cut down to 0–9 (`src-tauri/assets`, SIL Open Font License).
