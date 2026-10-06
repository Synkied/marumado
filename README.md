# Marumado

One hub for your projects, wherever they run, and for the machines they run on.

Two layers. **Your work** (projects, tasks, agents, skills, URLs) lives on the Marumado you open. **Machines** (CPU, processes, ports, Docker) are each machine's own, and the machine picker switches only those. A project is one thing with several places: its folder here, its containers on a server, its live URL, the agents working on it.

![Marumado's Agents module: the list of coding agents on the left, and the live terminal of the selected one filling the page](docs/agents.png)

- **Projects**: every subfolder of your scan folders is a project, with its stack, git branch, last commit, repo and live URLs detected. Scan folders come from `MARUMADO_PROJECT_DIRS` in `.env` (comma separated; unset, `/projects` when the machine has it) plus any you add in the app (**Projects → Folders**). A machine with no projects (most servers) needs none. A project's page gathers everything about it: where it is (its folder here, and the other machines it runs on), its open tasks and the agents in its folder, push or park, and the skills it uses. Add projects by hand too; fields you edit by hand survive rescans. **Files** on a project browses its folder and opens files read-only in a code viewer (CodeMirror), limited to project and scan folders. A project whose folder you delete disappears on the next rescan, unless you pinned, edited or decided on it.
- **Machine**: CPU, memory, disks, network, and sensors, with about 30 minutes of history.
- **URLs**: every live and local URL is checked every minute, with up/down status and response time. **Add URL** watches any site or service that isn't a project.
- **Ports**: what is listening, and which project it belongs to.
- **Docker**: containers, start/stop/restart, and logs.
- **Processes**: search, sort, and stop (with confirmation).
- **Momentum**: how each project is moving, from 12 weeks of git history and the agents at work on it (moving, slowing, stalled). Mark projects *push* or *park*, or archive them; a pushed project with no commit for 14 days and no agent on it shows up under "needs you", with a shortcut to write its next task. Projects are rescanned every hour. A heatmap shows every project's last 12 weeks on one screen.
- **Skills**: a skill map built from project stacks and libraries (React, Django REST, Three.js…), with how recently each was used (active, cooling, rusty). Add skills you want to learn, mark ones to grow, hide ones that aren't skills, and keep notes. Shown as a grid of cards or a list. A skill's page turns the plan into a task in one of your projects.
- **Agents**: the coding agents running in [Herdr](https://herdr.dev), with their state and a live terminal you can watch and type into from the browser, including from your phone. Point `MARUMADO_HERDR_*` in `.env` at wherever Herdr runs (this machine, a VM or over SSH). Agents running in several VMs or servers show up together: add each one under **Agents → Sources** (an SSH host, or a smolvm machine by name). A machine in **Machines** whose Marumado sees a Herdr is a source on its own, reached through that Marumado. The list groups agents under the source they run in, with whether it answers, and a source that stops answering shows up under "needs you". Tasks can start a new agent in any of them, in the project's folder there. A scan folder can have a default source for all its projects (**Projects → Folders**), and a project can pick its own (**Make default** next to the place picker under its Work), which wins over its folder's: tasks, plans and ⌘K start its agents there first. An agent already at work becomes a task with **Make it a task**: nothing is sent to it, Marumado follows it. A finished task opens on its **Review**: the commits and files its agent changed, with their diffs; a plan step's own branch can be merged, opened as a pull request (with `gh`, where the agent runs) or discarded, and any task can be sent back to its agent with what to change. A plan can have a **check** (`make test`, say): it runs in each step's folder once its agent finishes, a failure goes back to the agent to fix, and the steps under it start only once it passes. Tasks, plans and Home show the tokens agents used, what they would cost at API prices, and how full an agent's context is. **Workspaces** work as in Herdr: the picker above the list shows one Herdr workspace's agents at a time; **+** opens a new one (in a project's folder, or Herdr's home folder) and **×** closes the one picked, with every terminal and agent in it (and its worktrees' workspaces, which Herdr closes with it). While a workspace is picked, new terminals and agents started from a project page or ⌘K open as new tabs in it. `MARUMADO_HERDR_TERMINAL` sets whether the browser can type (`control`), only watch (`observe`) or neither (`off`).
- **Machines**: watch other machines from this one. Each runs its own Marumado (bound to 127.0.0.1); this one reaches them through SSH tunnels it keeps open. The picker next to the wordmark (on Machine, Processes, Ports and Docker) switches those modules to another machine; the Machines module lists them all with their CPU, memory, and fullest disk. What runs on each machine is matched to your projects by Compose project or folder name, so a project's page shows the servers it runs on, and their ports and containers link back to it. A machine that stops answering, or runs out of disk or memory, shows up under "needs you" whichever machine you're looking at. See [Other machines](#other-machines).


Press `/` (or ⌘K / Ctrl+K) anywhere to search projects, processes, ports, and containers. Projects, Tasks, Agents and URLs sit in the top bar as small dials, next to up to four of your running agents as critters (the ones that need you or are at work first; each opens its agent); the sidebar lists your pinned projects. Home shows what your agents are doing (one ribbon per agent: what it did each minute of the last hour, reading, editing, running or thinking, where you wrote to it and where a step failed; what it did last; and how its turn goes: how long it has been at it or waiting, files changed, steps failed; read from Claude Code's and Codex's session records), then every machine, as rows or side-by-side columns.

## The desktop app

Marumado runs in the browser, and also as a desktop app (`desktop/`, Tauri) for Linux, Windows and macOS, beside it.
The app is one window that every page opens in (the browser can't hand an open tab to another program), the tray,
and notifications:

- **The tray icon**: one arc per agent, wisteria while working, blue once it has finished its turn, grey when idle; in
  the middle, how many need you on a persimmon disc, or else how many are working; a grey ring struck through when
  Marumado can't be read. Its menu starts with *Show agents…* (the card), then who needs you and who is working, each
  opening its page in the app's window.
- **The card**: a small window by the icon (Windows, macOS: a click on the icon) or at the top right of the main
  monitor (Linux: *Show agents…*), listing every agent: who needs you first, then who is working and for how long,
  what each is doing, where, what a plan has queued for it, and the last line of its screen.
- **Notifications** when an agent starts waiting on you or finishes its turn, whether the window is open or not.

On first run it offers two ways, and can start with your session:

- **On this computer** (Linux, with Docker installed): pick the folders that hold your projects, and the app runs
  Marumado itself, from the published image (`ghcr.io/synkied/marumado`, the version that goes with the app). No
  checkout, no command, no token to copy: an updated app brings its updated Marumado.
- **Another machine**: its address and access token (`make access-token` there).

Download it from the [Releases](https://github.com/Synkied/marumado/releases) page: on Debian or Ubuntu, the `.deb`
(`sudo apt install ./Marumado_*_amd64.deb`); on Fedora, the `.rpm`; on any other Linux, the `.AppImage`
(`chmod +x` it, then run it); the `.dmg` on macOS and the `-setup.exe` or `.msi` on Windows.

It loads Marumado from its address rather than bundling the web app, so one build works with any Marumado. Builds for each system come from GitHub Actions (`.github/workflows/desktop.yml`);
see [desktop/README.md](desktop/README.md) to build it yourself and for Linux's tray.

### Uninstalling the app

1. In the tray's menu, turn off *Start with the session*, then *Quit Marumado*.
2. If the app ran Marumado on this computer, remove its container, in the folder the app wrote its compose file to:

   ```sh
   cd ~/.config/dev.marumado.desktop/marumado
   docker compose down               # the container; its data is kept
   docker compose down -v --rmi all  # or the data and the image too
   ```

   Its data volume (`marumado_marumado-data`) is the same one a checkout's `make up` uses: `-v` deletes your tasks,
   plans and projects added by hand for both.
3. Remove the app itself:
   - **Linux**: `sudo apt remove marumado` (.deb), `sudo dnf remove marumado` (.rpm), or delete the `.AppImage`.
   - **macOS**: move *Marumado* from Applications to the Trash.
   - **Windows**: Settings → Apps → Installed apps → Marumado → Uninstall.
4. Delete its settings (address, access token, window size) and its web view's data:
   - **Linux**: `~/.config/dev.marumado.desktop`, `~/.local/share/dev.marumado.desktop`, `~/.cache/dev.marumado.desktop`
   - **macOS**: `~/Library/Application Support/dev.marumado.desktop`, `~/Library/Caches/dev.marumado.desktop`,
     `~/Library/WebKit/dev.marumado.desktop`
   - **Windows**: `%APPDATA%\dev.marumado.desktop`, `%LOCALAPPDATA%\dev.marumado.desktop`

## Run it with Docker (recommended)

```sh
make up        # creates .env on first run, builds, starts → http://127.0.0.1:7878
make logs      # follow logs
make down      # stop
make           # every shortcut
```

The container shares the host's process and network namespaces (`pid: host`, `network_mode: host`) and reads `/var/run/docker.sock`, so it monitors the real machine rather than itself. This needs a **Linux host**; under Docker Desktop it would monitor Docker's VM instead.

### Project folders

The container only sees folders mounted into it. `make up` generates `compose.override.yaml` with a read-only mount (at the same path) for every folder in `MARUMADO_PROJECT_DIRS` and `MARUMADO_MOUNTS`:

```sh
MARUMADO_PROJECT_DIRS=/projects,/home/me/code   # scanned
MARUMADO_MOUNTS=/srv,/mnt/data                  # visible only, so folders inside can be added in the app
```

`MARUMADO_MOUNTS` left empty shares your home folder, so any folder in it can be added from the app without touching `.env` (set it to `none` to share nothing beyond `MARUMADO_PROJECT_DIRS`). In the app, `~` means your home on the host, not the container's.

Leave `MARUMADO_PROJECT_DIRS` unset to use `/projects` only where it exists, or set it empty on a machine with no projects. Folders that don't exist are left out of the mounts.

After changing them, run `make up` (or `make restart`).

### Access token

Marumado always asks for an access token, on localhost too: it can stop processes and containers, and type into your agents. Each browser asks for it once, then stays logged in for 30 days with an HttpOnly cookie. The lock button in the top bar logs that browser out.

- Without `MARUMADO_TOKEN` in `.env`, Marumado makes a random token on first run and keeps it in its data folder. `make access-token` prints it (`uv run python manage.py token` without Docker).
- To choose your own, set `MARUMADO_TOKEN=$(make token)` in `.env` and run `make restart`. Changing it logs every browser out.
- To log in with something easier to remember, run `make password` and pick a password (stored hashed in the data folder). The access token keeps working, so a forgotten password never locks you out: log in with the token, or run `make password` again. `make password ARGS=--clear` removes it. Setting or changing it logs every browser out. Each machine has its own: set one wherever you open Marumado in a browser.
- After 10 different wrong passwords or tokens in 15 minutes, an address is locked out for the rest of those 15 minutes.

### Opening it to your phone or teammates

In `.env`, set `MARUMADO_BIND=0.0.0.0`, then run `make up`. Everyone who opens it needs the access token, so only share it with people who may do everything you can. Over the LAN it travels as plain HTTP, so on networks you don't trust, reach Marumado through an SSH tunnel, a VPN (Tailscale, WireGuard) or an HTTPS reverse proxy instead.

### Other machines

1. Run Marumado on the other machine too (`make up`), leaving `MARUMADO_BIND` at 127.0.0.1. Note its access token (`make access-token` there). It needs no projects of its own: they stay on the Marumado you open.
2. Make sure `ssh you@that-machine` works from this one with key login and no password prompt, and connect once by hand to trust its host key.
3. If this Marumado runs in Docker, set `MARUMADO_SSH_DIR=~/.ssh` in `.env` and run `make up`, so the container gets your SSH keys and config. Changes you make to them on the host are picked up on the next connection.
4. In the app: **Machines → Add machine**, with the SSH target (`you@host`, `ssh://you@host:2222` for a non-standard SSH port, or a `~/.ssh/config` alias), its Marumado port, and its access token.

Nothing is opened to the network: the other Marumado stays on its localhost, and SSH is the only way in.

## Run it without Docker

```sh
cd backend && uv run python manage.py serve     # API (+ built UI) on :7878
cd frontend && npm install && npx vite          # dev UI on :5173, proxies /api
```

`make dev` runs both.

## Layout

| Path | What |
|---|---|
| `backend/` | Django + DRF API. `core/monitor.py` samples the host on background threads; `core/discovery.py` scans projects. |
| `frontend/` | React + TypeScript (Vite). `src/modules/` holds one sheet per module; `src/modules/registry.ts` lists the modules. Add a new module there to put it on the hub. |
| `desktop/` | The desktop app (Tauri 2): `src-tauri/` the window, tray, card window and notifications in Rust; `setup/` the first-run page. The card itself is the frontend's `#/card` page. |
| `PRODUCT.md`, `.impeccable/` | Product and design records. |
