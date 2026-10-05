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

A single self-hosted hub with two layers. **Your work** (projects, tasks, agents, skills, URLs) lives on the Marumado you open. **Machines** are where it runs: this one and the user's others (mostly Linux servers), each running its own Marumado, reached over SSH, showing its CPU, memory, disk, network, processes, listening ports and Docker containers. A project is one thing with several places (its folder here, its containers on a server, its live URL, the agents on it); the other machines needn't have any projects of their own.

Success: opening Marumado answers "where is X / is X up / why is the machine slow" without opening a terminal.

## Positioning

It runs *on* the machine it describes, on every machine, and any one of them can show all the others: each instance stays on its own localhost and the one you open reaches the rest through SSH tunnels, so nothing new is exposed to the network. It discovers projects by scanning folders and links them to live listening ports and Compose containers through their working directories. A generic bookmarks page or a cloud uptime monitor cannot know which local process belongs to which project.

## Operating Context

- Glanced at continuously on a side monitor, so it must stay calm and readable when everything is fine and draw attention only when something changes or fails.
- Opened on purpose to jump into a project or to investigate load.
- Used on a phone over the LAN.
- Multiple people may view the same instance.

## Capabilities and Constraints

- Projects: auto-discovered from the scan folders in `MARUMADO_PROJECT_DIRS` (comma separated; unset, `/projects` only where it exists; empty, none) plus any added in the app (Projects → Folders). `MARUMADO_MOUNTS` makes extra folders visible to the container without scanning them, so folders inside can be added from the app. In Docker, folders are mounted read-only. The scanner detects stack, git branch, last commit, dirty files, repo URL, and online URL (CNAME, package.json `homepage`, `*.github.io`). Projects can also be added by hand. Hand-edited fields are locked against rescans. Scanned projects are hidden, not deleted.
- Monitoring: system snapshot every 2s with about 30 minutes of in-memory history (`MARUMADO_HISTORY_POINTS`, default 900). Temperature sensors and battery are reported when the host exposes them. Processes can be sorted, searched, and killed (SIGTERM/SIGKILL; PID 1 and Marumado itself are refused). Ports, Docker (start/stop/restart/logs), and URL uptime checks (every 60s, with latency history) are also covered. URL checks cover project URLs plus standalone watches for any site or service that isn't a project (Add URL).
- Two layers: the machine picker switches only the machine modules (Machine, Processes, Ports, Docker: `MACHINE_MODULES` in `lib/hub.tsx`, `MACHINE_PATHS` in `lib/api.ts`). Everything else is this Marumado's, whichever machine is picked. Other machines' Marumados report what runs there by Compose project or folder (`overview.places`); the hub matches those to its projects by name (`discovery.project_by_name`, `core/places.py`), shows them on the project page, and links those machines' ports, containers and processes to its projects (`views._as_our_projects`).
- Plans (`core/plans.py`, `#/m/tasks/plan/<id>`): steps for agents to take over on their own. A plan's steps are tasks in rows: a row starts once every step above it is finished (to review or done), and a row's steps start at once. A step under another continues with that step's agent (keeping its context and folder); a first-row step, one past the width of the row above, or one set to "new agent" gets a new agent of the plan's kind, where the plan says; a step can also be given to a chosen open agent. A new agent for a step beside others works in its own git worktree (`herdr worktree create`, branch `marumado/p<plan>-<task>-<slug>`); merging is the owner's. An agent takes a step only when free (idle or finished its turn). A failed step holds back the rows under it. Steps waiting in a running plan are `queued`; paused, nothing new starts. Each agent lists what is queued for it (`/api/agents` → `queued`), shown in the tray. To do is the ideas list: plans pull from it, and steps taken out of a plan (or a deleted plan's) go back to it. A step can ask first (`ask`): when its turn comes it waits for the owner's go (`POST /api/tasks/<id>/go`) instead of starting, so earlier work can be checked before the chain moves on; it counts as needing the owner. On the Agents page, a modal queues what an agent does next (`POST /api/agents/<pane>/queue`: a step in that agent's own queue, a plan made for it the first time, one row per step, all on that agent) and opens every plan without leaving the page.
- Complementary modules: the project page gathers its places, open tasks, agents in its folder, push/park, and skills. Momentum counts agent work as movement and offers a next task for a pushed project with none. A skill's page starts a task. An agent at work becomes a task (`tasks/<id>/follow`, nothing sent to it).
- Navigation: `/` or ⌘K / Ctrl+K searches projects, processes, ports, and containers from anywhere. Your work (Projects, Tasks, Agents, URLs) sits in the top bar as small dials, from anywhere; the Agents dial counts what waits on you and opens its inbox. The machine is reached by the CPU/RAM readout beside them, other machines from the machine picker. The sidebar holds only the pinned projects (`Project.pinned`, toggled by the pin on each card, row or project page; their first letters on the rail, and no sidebar when none is pinned); they also open the Projects page in their own Pinned group, and come first in the search box before anything is typed. Momentum and Skills are tabs of Projects; Processes, Ports and Docker are tabs of Machine (`VIEW_OF` in `lib/route.ts`). Home shows your work first, then every machine. Modules are listed in `frontend/src/modules/registry.ts`.
- Agents: coding agents in Herdr, from every source at once. One source comes from `MARUMADO_HERDR_*` in `.env` (this machine, a smolvm machine, an exec command or an SSH host); more are added in the app (Agents → Sources: SSH hosts and smolvm machines, the `AgentSource` model). Every machine in Machines whose Marumado sees a Herdr is a source too (kind `machine`, id `1_000_000 + machine id`), asked through that Marumado's API (`?machines=0`, so two never ask each other in a loop); a task started there opens in the project's folder on that machine. Pane ids are only unique within one Herdr, so every agent is addressed by source and pane (`?source=<id>` on the API, `#/m/agents/<source>/<pane>` in the UI). A source that fails is skipped for 15 seconds so one VM that is off doesn't slow every listing; with several sources, one that stops answering raises an alert. Exec commands stay in `.env`: the app only takes SSH targets and smolvm names, which are validated. The web's job beside the Herdr TUI is dispatch and answering, not being a better terminal: **Needs you** (`#/m/agents/inbox`) lists every waiting agent from every source with its screen and the keys to answer (numbered choices become buttons); the tab title counts them, and a per-browser notification (HTTPS or localhost only) says when one starts waiting or finishes; the desktop app's tray (`desktop/`, Tauri) shows every running agent from the desktop (the agent dock, `modules/agentDock.tsx`, is kept in the code but no longer shown); a project's page and ⌘K start an agent in its folder (`POST agents/start`). Herdr's workspaces are picked, made and closed on the Agents page (`agents/workspaces`, `agents/workspaces/<id>/close`; each source lists its `workspaces`, each agent its `workspace_id`): the pick is per browser (`localStorage`), shows only that workspace's agents (Needs you still counts every one), and new terminals and agents open as tabs in it (`workspace` on `agents/terminal` and `agents/start`). Closing a repository's workspace closes its worktrees' workspaces too (Herdr's `--group`), said in the confirmation. Each source can say where it sees this machine's folders (shared folders, `/home/me/projects` → `/projects` in a VM; `AgentSource.folders`, and the `env_source_folders` setting for the .env one): agents and tasks start in the project's folder there, agents' folders are mapped back to find their project, and a start whose folder Herdr can't find fails with the reason rather than opening a shell in its home folder.
- Momentum: the scanner records commits per week on local branches for 12 weeks (`detected.weekly_commits`). A project is moving (commit within 14 days), slowing (15–45), or stalled (over 45). The owner's decision is `Project.focus` (push / park); archiving is `hidden`. A pushed project with no commit for 14 days raises an alert. Projects are rescanned hourly. Views: a heatmap (default; one row per project, one cell per week, shared square-root scale) or the list with the push/park/archive actions; the choice is per browser (`localStorage`).
- Skills: derived on the client from project stacks plus notable libraries (`detected.libs`, from package.json and Python requirements; mapping in `discovery.LIB_SKILLS`). Active within 30 days of a commit, cooling to 120, rusty after. The `Skill` model only stores the owner's plan (learn / grow / not a skill) and notes. Views: a card grid (default) or a list, per browser.
- Docker may be absent. The UI must treat "unavailable" as a normal state, not an error.
- Port→process mapping can be unavailable (sandboxed or containerized hosts, macOS without root). Missing PIDs must degrade gracefully.
- Security: an access token is always required, localhost included (`MARUMADO_TOKEN`, or one generated on first run in `data/access-token`). Browsers trade it once for an HttpOnly session cookie; changes made with the cookie need the `X-Marumado` header; other Marumados send it as a bearer token. Wrong guesses are rate-limited per address. Destructive actions (kill, container stop) exist, so they also need confirmation in the UI.
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
