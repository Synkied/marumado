export type Check = {
  id: number
  target: 'local' | 'online'
  url: string
  ok: boolean
  status_code: number | null
  latency_ms: number | null
  error: string
  checked_at: string
}

export type TargetStatus = {
  latest: Check | null
  latency: (number | null)[]
  uptime_percent: number | null
}

export type Project = {
  id: number
  name: string
  path: string
  description: string
  local_url: string
  online_url: string
  repo_url: string
  tags: string[]
  pinned: boolean
  hidden: boolean
  source: 'scan' | 'manual'
  /** a link is a URL watched on its own, not a folder of code */
  kind: 'project' | 'link'
  /** what the owner decided in Momentum; archiving a project hides it */
  focus: '' | 'push' | 'park'
  detected: {
    stacks?: string[]
    /** notable libraries, as skill labels */
    libs?: string[]
    git?: boolean
    branch?: string
    last_commit_at?: string
    last_commit?: string
    dirty_files?: number
    /** commits per week on local branches, oldest first (12 weeks) */
    weekly_commits?: number[]
    missing?: boolean
  }
  locked_fields: string[]
  created_at: string
  updated_at: string
  status: { local: TargetStatus; online: TargetStatus }
  running: boolean
  runtime: {
    ports: { port: number; address: string; pid: number | null; process: string }[]
    containers: { id: string; name: string; status: string; health: string | null }[]
  }
  suggested_local_url: string
  /** where else it runs: other machines whose Marumado reports it (by Compose project or folder name) */
  places?: Place[]
}

/** The project on another machine: its folder there, and what of it runs. */
export type Place = {
  machine: number
  machine_name: string
  dir: string
  compose: string
  containers: { name: string; service: string; status: string; health: string | null }[]
  ports: number[]
  running: boolean
}

export type ProjectRef = { id: number; name: string } | null

export type System = {
  time: number
  host: {
    hostname: string
    os: string
    arch: string
    boot_time: number
    cpu_model: string
    cores_logical: number
    cores_physical: number
  }
  cpu: { percent: number; per_core: number[]; freq_mhz: number | null; load: number[] }
  memory: {
    total: number
    used: number
    available: number
    percent: number
    swap_total: number
    swap_used: number
    swap_percent: number
  }
  net: {
    rx_rate: number
    tx_rate: number
    rx_total: number
    tx_total: number
    interfaces: { name: string; up: boolean; speed_mbps: number; rx_rate: number; tx_rate: number }[]
  }
  disk_io: { read_rate: number; write_rate: number }
  disks: { device: string; mount: string; fstype: string; total: number; used: number; free: number; percent: number }[]
  temperatures: { chip: string; label: string; current: number; high: number | null }[]
  process_count?: number
  battery: { percent: number; plugged: boolean; secs_left: number | null } | null
}

export type HistoryPoint = { t: number; cpu: number; mem: number; rx: number; tx: number; dr: number; dw: number }

export type Proc = {
  pid: number
  ppid: number
  name: string
  user: string
  status: string
  cpu: number
  rss: number
  mem_percent: number
  threads: number
  started: number
  cwd: string
  cmdline: string
  project: ProjectRef
}

export type Port = {
  port: number
  address: string
  proto: string
  pid: number | null
  process: string
  cwd: string
  cmdline: string
  project: ProjectRef
}

export type Container = {
  id: string
  name: string
  image: string
  status: string
  state: string
  health: string | null
  started_at: string | null
  compose_project: string
  compose_service: string
  working_dir: string
  ports: { host_port: number; host_ip: string; container_port: string }[]
  cpu: number | null
  mem: number | null
  mem_limit: number | null
  project: ProjectRef
}

export type Docker = { available: boolean; error: string; containers: Container[] }

export type ScanRoot = {
  /** null for folders set in .env, which can only be changed there */
  id: number | null
  path: string
  source: 'env' | 'app'
  found: boolean
  projects: number
}

export type AgentStatus = 'working' | 'blocked' | 'idle' | 'done' | 'unknown'

export type Agent = {
  pane_id: string
  /** The source (place Herdr runs) it is in: pane ids are only unique within one. Absent from older Marumados: 0. */
  source?: number
  name: string
  kind: string
  status: AgentStatus
  /** What the agent's terminal title says it is doing. */
  title: string
  cwd: string
  /** its Herdr workspace's label, and id (the id is absent from older Marumados) */
  workspace: string
  workspace_id?: string
  focused: boolean
  /** the project it works in, by folder (or by name, on another machine) */
  project?: ProjectRef
  /** the plans' steps waiting for it, next first (absent from older Marumados); `asking`: its turn has come and it
      waits for the owner's go */
  queued?: QueuedStep[]
}

export type QueuedStep = { id: number; title: string; plan: number; asking?: boolean }

/** control: the browser terminal types into agents; observe: it only watches; off: polled output only. */
export type TerminalMode = 'control' | 'observe' | 'off'

/** A place Herdr runs. 0 (`env`) is the one set in .env; the others (an SSH host, a smolvm machine) are added in the app. */
export type AgentSource = {
  id: number
  name: string
  /** machine: another machine in Machines, whose Herdr is reached through its Marumado */
  kind: 'env' | 'ssh' | 'smolvm' | 'machine'
  /** where it looks for Herdr, in words */
  where: string
  /** where it sees this machine's folders (absent from older Marumados) */
  folders?: SourceFolder[]
  available: boolean
  error: string
  /** how many panes it has open */
  agents: number
  /** its Herdr workspaces, in Herdr's order (absent from older Marumados) */
  workspaces?: Workspace[]
}

/** A Herdr workspace: tabs and panes kept together, as in Herdr's sidebar. */
export type Workspace = {
  id: string
  label: string
  /** the git checkout it is in, when it is one */
  cwd: string
  /** a git worktree's workspace: its repository's workspace id ('' otherwise) */
  worktree_of: string
  /** how many worktree workspaces are linked to it: Herdr closes it only with them */
  linked: number
}

/** An agent source as saved in the app (GET /agent-sources). */
/** A folder on this machine (`here`) and where an agent source sees it (`there`): /home/me/projects is /projects in the VM. */
export type SourceFolder = { here: string; there: string }

export type SavedAgentSource = { id: number; name: string; kind: 'ssh' | 'smolvm'; target: string; folders: SourceFolder[] }

/** `kinds`: the agents Herdr can start (for Tasks), most common first. `available`: at least one source answered.
 * `sources` is absent from Marumados older than agent sources. */
export type Agents = { available: boolean; error: string; where: string; terminal: TerminalMode; kinds?: string[]; sources?: AgentSource[]; agents: Agent[] }

/** todo → starting (being handed over) → working ⇄ blocked (needs you) → review (agent finished its turn) → done; or failed.
    queued: a step of a running plan, waiting for the steps above it or for its agent. */
export type TaskState = 'todo' | 'queued' | 'starting' | 'working' | 'blocked' | 'review' | 'done' | 'failed'

/** Who takes a plan's step: '' the agent of the step above it (or a new one), 'new' a new agent, 'agent' the one in want_pane. */
export type Runner = '' | 'new' | 'agent'

export type Task = {
  id: number
  /** a short name, made from the prompt unless written by hand */
  title: string
  /** what the agent is told, in full (empty: the title) */
  prompt: string
  project: number | null
  project_name: string
  state: TaskState
  pane_id: string
  /** the source the agent runs in (see Agent.source) */
  agent_source: number
  agent_name: string
  agent_kind: string
  /** the agent's last seen Herdr state */
  agent_state: AgentStatus | ''
  /** what the agent's terminal title last said it was doing */
  agent_title: string
  /** still followed by Marumado */
  live: boolean
  /** not sent yet: the new agent asked something first (trusting the folder, say); sent once that is answered */
  prompt_pending: boolean
  started_at: string | null
  finished_at: string | null
  /** done and put away (or its plan was): left out of the task list until restored */
  archived_at: string | null
  created_at: string
  updated_at: string
  /** the plan it is a step of: its row (rows run in order) and place in the row (side by side, at once) */
  plan: number | null
  plan_row: number
  plan_col: number
  runner: Runner
  want_pane: string
  want_source: number
  /** the branch of the git worktree its agent works in, when it got one */
  worktree: string
  /** a step that waits for the owner's go when its turn comes, and whether it was given */
  ask: boolean
  go: boolean
}

/** Steps for agents to take over on their own (core/plans.py). New agents are `kind`, started in `source`. */
export type Plan = {
  id: number
  title: string
  project: number | null
  project_name: string
  kind: string
  source: number
  running: boolean
  /** an agent's own queue: the steps queued from its page (empty for other plans) */
  pane_id: string
  pane_source: number
  /** finished and put away, its steps with it: left out of the plans list until restored */
  archived_at: string | null
  created_at: string
  updated_at: string
  /** row by row, left to right */
  steps: Task[]
  /** the steps whose turn has come, waiting for the owner's go */
  asking: number[]
}

export type TaskEventKind = 'created' | 'assigned' | 'prompt' | 'state' | 'activity' | 'changes' | 'closed' | 'error' | 'done' | 'reopened' | 'moved' | 'archived' | 'restored'

export type TaskChanges = {
  commits: { sha: string; subject: string }[]
  /** A added, M modified, D deleted, R renamed, ? new and not in git yet */
  files: { status: string; path: string }[]
  file_count: number
  stat: string
}

export type TaskEvent = {
  id: number
  at: string
  kind: TaskEventKind
  /** for `state`: the agent's state from then on (`starting`: a new agent coming up) */
  state: AgentStatus | 'starting' | ''
  text: string
  /** the end of the agent's terminal at that moment */
  output: string
  data: Partial<TaskChanges>
}

export type TaskDetail = Task & { events: TaskEvent[] }

/** What the owner wants to do with a skill. The skill itself comes from project stacks and libraries. */
export type SkillIntent = '' | 'learn' | 'grow' | 'ignore'

export type Skill = { id: number; name: string; intent: SkillIntent; note: string; created_at: string; updated_at: string }

export type Machine = {
  id: 'local' | number
  name: string
  ssh_target: string
  port: number | null
  has_token: boolean
  local: boolean
  /** connecting: the tunnel is opening; down: it failed or the other Marumado isn't answering (see error) */
  state: 'connecting' | 'up' | 'down'
  error: string
  /** when it entered this state (unix seconds) */
  since: number | null
  summary: {
    hostname: string
    os: string
    cores: number
    boot_time: number
    cpu: number
    load: number[]
    memory: number
    disk: { mount: string; percent: number } | null
    time: number
    /** CPU % over the last half hour, about one point every 30s, oldest first; null where nothing was sampled */
    trace?: (number | null)[]
  } | null
  /** its digest for the home view; null while unreachable, or from a Marumado older than /overview */
  overview: Overview | null
}

/** One machine at a glance (GET /api/overview on that machine). */
export type Overview = {
  time: number
  projects: { total: number; running: number }
  urls: { checked: number; up: number; down: { id: number; name: string; detail: string }[] }
  docker: { available: boolean; running: number; total: number; unhealthy: string[] }
  agents: {
    available: boolean
    total: number
    working: number
    blocked: { pane_id: string; source?: number; source_name?: string; label: string; where: string }[]
    /** how many sources it watches, and those that don't answer (absent from older Marumados) */
    sources?: number
    unreachable?: string[]
  }
  ports: number
  /** open tasks (absent from older Marumados) */
  tasks?: { open: number; working: number; blocked: number; failed: number }
}

/** One thing an agent did, from its session record (core/transcripts.py). Times are unix milliseconds;
    `end` is null while a tool it called hasn't answered. `ok` false: the tool or command failed. */
export type TraceKind = 'think' | 'say' | 'read' | 'search' | 'edit' | 'run' | 'agent' | 'tool' | 'you' | 'ask'
export type TraceStep = {
  i: number
  kind: TraceKind
  t: number
  end: number | null
  title: string
  /** the command, when the title is the agent's description of it */
  sub?: string
  detail: string
  ok: boolean | null
  files?: { path: string; add?: number; del?: number }[]
}

/** GET tasks/<id>/trace?from=n: the steps from `from` on (those before are final); `first`, where the task begins. */
export type Trace =
  | { found: false; reason: string; steps: []; total: number }
  | { found: true; path: string; first: number; from: number; total: number; steps: TraceStep[] }
