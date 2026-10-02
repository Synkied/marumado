import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { agentHref, agentKey, sourceLabel } from './agents'
import { api, ApiError } from './api'
import { daysSince, PUSH_GRACE_DAYS } from './growth'
import type { MachineId } from './api'
import { useMachines } from './machines'
import type { Agents, Docker, HistoryPoint, Machine, Port, Project, Skill, System, Task } from './types'
import { usePoll } from './usePoll'

export type Alert = {
  id: string
  module: ModuleId
  title: string
  detail: string
  /** hash route that resolves it */
  href: string
  /** the machine `href` is on, when it isn't the one on screen: switch to it before following the link */
  machine?: MachineId
}

export type ModuleId = 'projects' | 'machine' | 'urls' | 'ports' | 'docker' | 'processes' | 'agents' | 'tasks' | 'momentum' | 'skills' | 'machines'

type Hub = {
  system?: System
  history: HistoryPoint[]
  projects?: Project[]
  ports?: Port[]
  docker?: Docker
  agents?: Agents
  tasks?: Task[]
  skills?: Skill[]
  alerts: Alert[]
  error: ApiError | Error | null
  refreshProjects: () => void
  refreshDocker: () => void
  refreshSkills: () => void
  refreshAgents: () => void
  refreshTasks: () => void
}

const HubContext = createContext<Hub | null>(null)

const HISTORY_SECONDS = 30 * 60
export const DISK_BUDGET = 90
export const MEM_BUDGET = 92
export const CPU_BUDGET = 90

/** Something wrong on a machine, read from its summary and digest; `module` is where to look on that machine. */
export type Issue = { id: string; module: ModuleId; title: string; detail: string }

/** What needs attention on a machine that isn't on screen (the one on screen has the full alerts). */
export function machineIssues(m: Machine): Issue[] {
  const out: Issue[] = []
  const s = m.summary
  if (s?.disk && s.disk.percent >= DISK_BUDGET) {
    out.push({ id: 'disk', module: 'machine', title: `Disk ${s.disk.mount} is ${Math.round(s.disk.percent)}% full`, detail: `Above the ${DISK_BUDGET}% budget` })
  }
  if (s && s.memory >= MEM_BUDGET) {
    out.push({ id: 'mem', module: 'machine', title: `Memory at ${Math.round(s.memory)}%`, detail: `Above the ${MEM_BUDGET}% budget` })
  }
  const o = m.overview
  for (const a of o?.agents.blocked ?? []) {
    const on = (o?.agents.sources ?? 1) > 1 && a.source_name ? ` on ${a.source_name}` : ''
    out.push({ id: `agent:${agentKey(a)}`, module: 'agents', title: `${a.label} in ${a.where}${on} is waiting for you`, detail: 'Approval or question' })
  }
  for (const name of o?.agents.unreachable ?? []) {
    if ((o?.agents.sources ?? 1) > 1) out.push({ id: `source:${name}`, module: 'agents', title: `Agents on ${name} can't be reached`, detail: 'Herdr or its VM is not answering' })
  }
  for (const u of o?.urls.down ?? []) {
    out.push({ id: `url:${u.id}`, module: 'urls', title: `${u.name} (live) is down`, detail: u.detail })
  }
  for (const name of o?.docker.unhealthy ?? []) {
    out.push({ id: `ctr:${name}`, module: 'docker', title: `${name} is unhealthy`, detail: 'Container health check failing' })
  }
  return out
}

/** Where an issue from `machineIssues` is resolved, once its machine is on screen. */
export function issueHref(module: ModuleId, id: string): string {
  if (id.startsWith('source:')) return '#/m/agents/sources'
  return id.startsWith('agent:') ? `#/m/agents/${id.slice(6)}` : `#/m/${module}`
}

/** The machines not on screen: unreachable, or with something that needs you (see the home view). */
function machineAlerts(machines: Machine[] = [], current: MachineId): Alert[] {
  const out: Alert[] = []
  for (const m of machines) {
    if (m.state === 'down') {
      out.push({ id: `machine:${m.id}`, module: 'machines', title: `${m.name} is unreachable`, detail: m.error || 'No answer', href: '#/m/machines' })
    }
    if (m.id === current) continue
    for (const i of machineIssues(m)) {
      out.push({ id: `machine:${m.id}:${i.id}`, module: 'machines', title: `${m.name}: ${i.title}`, detail: i.detail, href: issueHref(i.module, i.id), machine: m.id })
    }
  }
  return out
}

function deriveAlerts(system?: System, history: HistoryPoint[] = [], projects?: Project[], docker?: Docker, agents?: Agents, tasks?: Task[]): Alert[] {
  const out: Alert[] = []
  for (const p of projects ?? []) {
    const latest = p.status.online.latest
    if (p.online_url && latest && !latest.ok) {
      out.push({
        id: `url:${p.id}`,
        module: 'urls',
        title: `${p.name} (live) is down`,
        detail: latest.status_code ? `HTTP ${latest.status_code}` : latest.error.split(':')[0] || 'No response',
        href: '#/m/urls',
      })
    }
  }
  if (system) {
    for (const d of system.disks) {
      if (d.percent >= DISK_BUDGET) {
        out.push({ id: `disk:${d.mount}`, module: 'machine', title: `Disk ${d.mount} is ${Math.round(d.percent)}% full`, detail: `Above the ${DISK_BUDGET}% budget`, href: '#/m/machine' })
      }
    }
    if (system.memory.percent >= MEM_BUDGET) {
      out.push({ id: 'mem', module: 'machine', title: `Memory at ${Math.round(system.memory.percent)}%`, detail: `Above the ${MEM_BUDGET}% budget`, href: '#/m/machine' })
    }
    // CPU only counts when it stays high for the last 30 seconds.
    const recent = history.filter((h) => h.t > system.time - 30)
    if (recent.length >= 10 && recent.every((h) => h.cpu >= CPU_BUDGET)) {
      out.push({ id: 'cpu', module: 'machine', title: `CPU above ${CPU_BUDGET}% for 30s`, detail: `${Math.round(system.cpu.percent)}% now`, href: '#/m/processes' })
    }
  }
  for (const a of agents?.agents ?? []) {
    if (a.status === 'blocked') {
      const where = a.cwd.split('/').filter(Boolean).pop() || a.cwd
      const on = sourceLabel(agents, a)
      out.push({ id: `agent:${agentKey(a)}`, module: 'agents', title: `${a.name || a.kind} in ${where}${on ? ` on ${on}` : ''} is waiting for you`, detail: a.title || 'Approval or question', href: agentHref(a) })
    }
  }
  // With one source, an unreachable Herdr is the Agents module being off, not an alarm. With several, one that drops is news.
  const sources = agents?.sources ?? []
  if (sources.length > 1) {
    for (const s of sources.filter((x) => !x.available)) {
      out.push({ id: `source:${s.id}`, module: 'agents', title: `Agents on ${s.name} can't be reached`, detail: s.error || 'Herdr is not answering', href: '#/m/agents/sources' })
    }
  }
  for (const t of tasks ?? []) {
    if (t.state === 'failed') {
      out.push({ id: `task:${t.id}`, module: 'tasks', title: `Task “${t.title}” failed`, detail: 'Open it to see why, then assign it again or move it back to do', href: `#/m/tasks/${t.id}` })
    }
  }
  // A project marked "push" that hasn't moved is a promise slipping.
  for (const p of projects ?? []) {
    const days = daysSince(p.detected.last_commit_at)
    if (p.kind === 'project' && p.focus === 'push' && days != null && days > PUSH_GRACE_DAYS) {
      out.push({ id: `push:${p.id}`, module: 'momentum', title: `${p.name} is marked push but hasn't moved`, detail: `No commit for ${days} days`, href: '#/m/momentum' })
    }
  }
  for (const c of docker?.containers ?? []) {
    if (c.health === 'unhealthy') {
      out.push({ id: `ctr:${c.id}`, module: 'docker', title: `${c.name} is unhealthy`, detail: c.image, href: '#/m/docker' })
    }
  }
  return out
}

export function HubProvider({ children }: { children: ReactNode }) {
  const { machines, current } = useMachines()
  const system = usePoll<System>('system', 2000)
  const projects = usePoll<Project[]>('projects', 10000)
  const ports = usePoll<Port[]>('ports', 5000)
  const docker = usePoll<Docker>('docker', 5000)
  const agents = usePoll<Agents>('agents', 4000)
  const skills = usePoll<Skill[]>('skills', 30000)
  const tasks = usePoll<Task[]>('tasks', 5000)
  const [history, setHistory] = useState<HistoryPoint[]>([])
  const lastT = useRef(0)

  useEffect(() => {
    api<HistoryPoint[]>('system/history')
      .then((pts) => {
        setHistory(pts.slice(-HISTORY_SECONDS / 2))
        lastT.current = pts.length ? pts[pts.length - 1].t : 0
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const s = system.data
    if (!s || s.time <= lastT.current) return
    lastT.current = s.time
    const point: HistoryPoint = {
      t: s.time,
      cpu: s.cpu.percent,
      mem: s.memory.percent,
      rx: s.net.rx_rate,
      tx: s.net.tx_rate,
      dr: s.disk_io.read_rate,
      dw: s.disk_io.write_rate,
    }
    setHistory((h) => [...h.filter((p) => p.t > s.time - HISTORY_SECONDS), point])
  }, [system.data])

  const alerts = useMemo(
    () => [...deriveAlerts(system.data, history, projects.data, docker.data, agents.data, tasks.data), ...machineAlerts(machines, current)],
    [system.data, history, projects.data, docker.data, agents.data, tasks.data, machines, current],
  )

  const value: Hub = {
    system: system.data,
    history,
    projects: projects.data,
    ports: ports.data,
    docker: docker.data,
    agents: agents.data,
    tasks: tasks.data,
    skills: skills.data,
    alerts,
    error: system.error ?? projects.error,
    refreshProjects: projects.refresh,
    refreshDocker: docker.refresh,
    refreshSkills: skills.refresh,
    refreshAgents: agents.refresh,
    refreshTasks: tasks.refresh,
  }
  return <HubContext.Provider value={value}>{children}</HubContext.Provider>
}

export function useHub(): Hub {
  const hub = useContext(HubContext)
  if (!hub) throw new Error('useHub outside HubProvider')
  return hub
}
