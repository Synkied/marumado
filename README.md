# Marumado

One hub for every project on this machine, and for the machine itself.

- **Projects**: every subfolder of your scan folders is a project, with its stack, git branch, last commit, repo and live URLs detected. Scan folders come from `MARUMADO_PROJECT_DIRS` in `.env` (comma separated, default `/projects`) plus any you add in the app (**Projects → Folders**). Add projects by hand too; fields you edit by hand survive rescans.
- **Machine**: CPU, memory, disks, network, and sensors, with about 30 minutes of history.
- **URLs**: every live and local URL is checked every minute, with up/down status and response time. **Add URL** watches any site or service that isn't a project.
- **Ports**: what is listening, and which project it belongs to.
- **Docker**: containers, start/stop/restart, and logs.
- **Processes**: search, sort, and stop (with confirmation).

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

In `.env`, set `MARUMADO_BIND=0.0.0.0` and `MARUMADO_TOKEN=$(make token)`, then run `make up`. Browsers ask for the token once. Never expose Marumado without a token: it can stop processes and containers.

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
