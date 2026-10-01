# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

- Backend: Python 3.14, Django + Django REST Framework, SQLite (`backend/`, managed with uv). Host sampling via psutil, Docker via the Docker SDK, URL checks via httpx. Served by waitress through `manage.py serve`.
- Deployment: Docker Compose is the recommended way to run it (`make up`, port 7878). The container shares the host's process and network namespaces (`pid: host`, `network_mode: host`) and reads `/var/run/docker.sock`, so it monitors the real machine. This requires a Linux host; under Docker Desktop it would monitor Docker's VM. Running without Docker (`make dev`) is also supported.
- Frontend: TypeScript + React (from the user's standing stack preferences: `/projects/tech-stack-preferences.md`). Built assets are served by Django/WhiteNoise at `/`.
- A Tauri wrapper is a possible later step, not a current commitment.

## Users

- **Primary:** the owner, a full-stack developer with many side projects in `/projects` (Django, React, Godot, Expo, Docker Compose stacks). They use Marumado at the desk as an always-open tab on a side screen, as a launchpad when they need it, and from their phone over the LAN.
- **Secondary:** teammates who may open the same instance. They don't know the owner's projects or jargon, so labels and states must explain themselves.

## Product Purpose

A single self-hosted hub on the machine it runs on. It links every project (local folders, running local URLs, online deployments, repos) and shows the health of the machine: CPU, memory, disk, network, processes, listening ports, Docker containers, and up/down status for project URLs.

Success: opening Marumado answers "where is X / is X up / why is the machine slow" without opening a terminal.

## Positioning

It runs *on* the machine it describes. It discovers projects by scanning folders and links them to live listening ports and Compose containers through their working directories. A generic bookmarks page or a cloud uptime monitor cannot know which local process belongs to which project.

## Operating Context

- Glanced at continuously on a side monitor, so it must stay calm and readable when everything is fine and draw attention only when something changes or fails.
- Opened on purpose to jump into a project or to investigate load.
- Used on a phone over the LAN.
- Multiple people may view the same instance.

## Capabilities and Constraints

- Projects: auto-discovered from the scan folders in `MARUMADO_PROJECT_DIRS` (comma separated, default `/projects`) plus any added in the app (Projects → Folders). `MARUMADO_MOUNTS` makes extra folders visible to the container without scanning them, so folders inside can be added from the app. In Docker, folders are mounted read-only. The scanner detects stack, git branch, last commit, dirty files, repo URL, and online URL (CNAME, package.json `homepage`, `*.github.io`). Projects can also be added by hand. Hand-edited fields are locked against rescans. Scanned projects are hidden, not deleted.
- Monitoring: system snapshot every 2s with about 30 minutes of in-memory history (`MARUMADO_HISTORY_POINTS`, default 900). Temperature sensors and battery are reported when the host exposes them. Processes can be sorted, searched, and killed (SIGTERM/SIGKILL; PID 1 and Marumado itself are refused). Ports, Docker (start/stop/restart/logs), and URL uptime checks (every 60s, with latency history) are also covered. URL checks cover project URLs plus standalone watches for any site or service that isn't a project (Add URL).
- Navigation: `/` or ⌘K / Ctrl+K searches projects, processes, ports, and containers from anywhere. Arrange chooses which modules sit on the home panel. Modules are listed in `frontend/src/modules/registry.ts`.
- Momentum: the scanner records commits per week on local branches for 12 weeks (`detected.weekly_commits`). A project is moving (commit within 14 days), slowing (15–45), or stalled (over 45). The owner's decision is `Project.focus` (push / park); archiving is `hidden`. A pushed project with no commit for 14 days raises an alert. Projects are rescanned hourly. Views: a heatmap (default; one row per project, one cell per week, shared square-root scale) or the list with the push/park/archive actions; the choice is per browser (`localStorage`).
- Skills: derived on the client from project stacks plus notable libraries (`detected.libs`, from package.json and Python requirements; mapping in `discovery.LIB_SKILLS`). Active within 30 days of a commit, cooling to 120, rusty after. The `Skill` model only stores the owner's plan (learn / grow / not a skill) and notes. Views: a card grid (default) or a list, per browser.
- Docker may be absent. The UI must treat "unavailable" as a normal state, not an error.
- Port→process mapping can be unavailable (sandboxed or containerized hosts, macOS without root). Missing PIDs must degrade gracefully.
- Security: open on localhost. Any non-localhost bind (phone or teammates) should set `MARUMADO_TOKEN`; destructive actions (kill, container stop) exist, so they need confirmation in the UI.
- **Open decision:** the user wants Marumado to grow into a hub for "many other things". No single area dominates. The structure must accept new modules without a redesign, and no module should be privileged as the permanent home.

## Evidence on Hand

- Real data: about 27 projects in `/projects`, live host metrics from the API.
- Approved design comps in `.impeccable/mocks/` (`home-3.png` is the approved one) and review screenshots of the built UI in `.impeccable/review/`.
- No logo or brand assets exist beyond the in-app wordmark. Don't fabricate any.

## Product Principles

1. **Hub, not a single-purpose dashboard.** Projects and machine health are the first two modules. New ones plug in alongside them on equal footing.
2. **Quiet until it matters.** Normal state is calm. Failures, spikes, and down URLs are what stand out.
3. **One click to the thing.** Every project gets direct links to its local URL, online URL, repo, and folder.
4. **Self-explanatory for someone who isn't the owner.** States, units, and actions are labeled plainly.
5. **Destructive actions are deliberate.** Killing processes and stopping containers always need confirmation.

## Accessibility & Inclusion

Must work from a desktop side monitor down to phone width. No other specific requirements have been established; default to WCAG AA contrast and full keyboard operation.
