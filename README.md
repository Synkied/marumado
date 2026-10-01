# Marumado

One hub for every project on this machine, and for the machine itself.

![Marumado's Agents module: the list of coding agents on the left, and the live terminal of the selected one filling the page](docs/agents.png)

- **Projects**: every subfolder of your scan folders is a project, with its stack, git branch, last commit, repo and live URLs detected. Scan folders come from `MARUMADO_PROJECT_DIRS` in `.env` (comma separated, default `/projects`) plus any you add in the app (**Projects → Folders**). Add projects by hand too; fields you edit by hand survive rescans. **Files** on a project browses its folder and opens files read-only in a code viewer (CodeMirror), limited to project and scan folders. A project whose folder you delete disappears on the next rescan, unless you pinned, edited or decided on it.
- **Machine**: CPU, memory, disks, network, and sensors, with about 30 minutes of history.
- **URLs**: every live and local URL is checked every minute, with up/down status and response time. **Add URL** watches any site or service that isn't a project.
- **Ports**: what is listening, and which project it belongs to.
- **Docker**: containers, start/stop/restart, and logs.
- **Processes**: search, sort, and stop (with confirmation).
- **Momentum**: how each project is moving, from 12 weeks of git history (moving, slowing, stalled). Mark projects *push* or *park*, or archive them; a pushed project with no commit for 14 days shows up under "needs you". Projects are rescanned every hour. A heatmap shows every project's last 12 weeks on one screen.
- **Skills**: a skill map built from project stacks and libraries (React, Django REST, Three.js…), with how recently each was used (active, cooling, rusty). Add skills you want to learn, mark ones to grow, hide ones that aren't skills, and keep notes. Shown as a grid of cards or a list.
- **Agents**: the coding agents running in [Herdr](https://herdr.dev), with their state and a live terminal you can watch and type into from the browser, including from your phone. Point `MARUMADO_HERDR_*` in `.env` at wherever Herdr runs (this machine, a VM or over SSH); `MARUMADO_HERDR_TERMINAL` sets whether the browser can type (`control`), only watch (`observe`) or neither (`off`).
- **Machines**: watch other machines from this one. Each runs its own Marumado (bound to 127.0.0.1); this one reaches them through SSH tunnels it keeps open. The picker next to the wordmark switches every module to another machine, and the Machines module lists them all with their CPU, memory, and fullest disk. A machine that stops answering, or runs out of disk or memory, shows up under "needs you" whichever machine you're looking at. See [Other machines](#other-machines).


Press `/` (or ⌘K / Ctrl+K) anywhere to search projects, processes, ports, and containers. **Arrange** chooses which modules sit on the home panel.

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
MARUMADO_MOUNTS=/home/me                        # visible only, so folders inside can be added in the app
```

After changing them, run `make up` (or `make restart`).

### Opening it to your phone or teammates

In `.env`, set `MARUMADO_BIND=0.0.0.0` and `MARUMADO_TOKEN=$(make token)`, then run `make up`. Browsers ask for the token once. Never expose Marumado without a token: it can stop processes and containers, and type into your agents.

### Other machines

1. Run Marumado on the other machine too (`make up`), leaving `MARUMADO_BIND` at 127.0.0.1. Give it a `MARUMADO_TOKEN` if other people can log into that machine.
2. Make sure `ssh you@that-machine` works from this one with key login and no password prompt, and connect once by hand to trust its host key.
3. If this Marumado runs in Docker, set `MARUMADO_SSH_DIR=~/.ssh` in `.env` and run `make up`, so the container gets your SSH keys and config. Changes you make to them on the host are picked up on the next connection.
4. In the app: **Machines → Add machine**, with the SSH target (`you@host`, `ssh://you@host:2222` for a non-standard SSH port, or a `~/.ssh/config` alias), its Marumado port, and its token.

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
| `PRODUCT.md`, `.impeccable/` | Product and design records. |
