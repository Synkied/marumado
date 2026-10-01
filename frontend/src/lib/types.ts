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
  name: string
  kind: string
  status: AgentStatus
  /** What the agent's terminal title says it is doing. */
  title: string
  cwd: string
  workspace: string
  focused: boolean
}

/** control: the browser terminal types into agents; observe: it only watches; off: polled output only. */
export type TerminalMode = 'control' | 'observe' | 'off'

export type Agents = { available: boolean; error: string; where: string; terminal: TerminalMode; agents: Agent[] }

/** What the owner wants to do with a skill. The skill itself comes from project stacks and libraries. */
export type SkillIntent = '' | 'learn' | 'grow' | 'ignore'

export type Skill = { id: number; name: string; intent: SkillIntent; note: string; created_at: string; updated_at: string }
