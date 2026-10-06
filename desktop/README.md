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
- On first run, the bundled page in `setup/` offers two ways:
  - **On this computer** (Linux, Docker installed): the app runs Marumado itself (`src-tauri/src/host.rs`). It writes
    a compose file into its config folder (`marumado/compose.yaml`, as `compose.yaml` and `make up` would make it, with
    the published image `ghcr.io/synkied/marumado:<the app's version>` instead of a build), with the folders you picked
    mounted read-only, Herdr and smolvm found where they are installed, and your `~/.ssh` if you said so. It makes the
    access token and the secret key itself. `docker compose up -d` pulls the image the first time; an updated app
    names a new tag, so the next start pulls it and recreates the container (its data volume is kept). Set
    `MARUMADO_IMAGE` (or `"image"` under `"host"` in `config.json`) to run another image, a test build say.
  - **Another machine**: its address and access token (`make access-token` there), checked by logging in
    (`POST /api/auth`).

  Either way the address and the token are kept in the app's config folder (`config.json`, readable by you only). The
  token stays with the app because the tray reads `GET /api/agents` on its own every 3 s. The window logs itself in
  with it too: Marumado's login page asks the app for it (`frontend/src/lib/desktop.ts`). *Set up or connect
  Marumado…* in the tray's menu opens the page again, to change the folders or the Marumado.
- The frontend checks whether it runs in the app (`window.__TAURI_INTERNALS__`) and only then adds the desktop's
  extras: the card (`#/card`, `frontend/src/modules/agentCard.tsx`), the automatic login, and leaving notifications
  to the app. Marumado's pages may call only the app's own commands (`login_token`, `open_page`, `hide_card`,
  `fit_card`, `working_since`, `reconnect`), granted at run time to the address you gave.
- Links to Marumado's pages stay in the app's window (a link that opens a new tab opens the page in it instead);
  links to other sites open in your browser.
- When the app starts and the Marumado on this machine doesn't answer, it starts it: its own (above), or else, on a
  developer's machine, the checkout the app was built from (`docker compose up -d` there, `make up` if it has no
  `.env` yet; a `"folder"` in `config.json` names another checkout). It retries for a minute and a half while Docker
  starts with the session. Meanwhile the window shows *Starting Marumado…* (`setup/starting.html`, or why it
  couldn't), and opens Marumado as soon as it answers. *Quit Marumado* stops the containers the app started
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

## Release it

The app runs the image of its own version, so the two are released together, as a GitHub release with the app's
bundles and a Docker image of the same version:

1. From an up-to-date `main` with nothing uncommitted, at the repository's root:

   ```sh
   make release VERSION=0.2.0       # or VERSION=patch, minor or major
   make release VERSION=0.2.0 DRY_RUN=1   # only show what it would change
   ```

   It sets the version in every file that holds one (`tauri.conf.json`, `Cargo.toml`, the two `package.json`,
   `pyproject.toml`, and their lock files), asks, then commits `chore: release v0.2.0`, tags `v0.2.0` and pushes both
   (`scripts/release.py`; `YES=1` skips the question).
2. The tag starts the release on GitHub. `.github/workflows/image.yml` checks the tag against `tauri.conf.json`, then publishes
   `ghcr.io/synkied/marumado:0.2.0` (and `:latest`) for amd64 and arm64. `desktop.yml` builds the bundles on Linux,
   Windows and macOS, checks the tag against all four versions, then creates the release `v0.2.0` with the `.deb`,
   `.rpm`, `.AppImage`, `.msi`, `-setup.exe` and `.dmg` attached, and notes made from the commits and pull requests
   since the last release (edit them on GitHub afterwards).
3. The first time only: make the package public (GitHub → the package → *Package settings* → *Change visibility*),
   or nobody else can pull it.

Pushes to `main` publish `:main` too, to try the image without a release (`MARUMADO_IMAGE=ghcr.io/synkied/marumado:main`).

`npm run icons` remakes the app's icons from `app-icon.svg` (needs `rsvg-convert`). The tray icon's digits are Iosevka
Aile Bold, cut down to 0–9 (`src-tauri/assets`, SIL Open Font License).
