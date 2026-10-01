import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, ApiError } from './api'
import type { Agents, Docker, HistoryPoint, Port, Project, System } from './types'
import { usePoll } from './usePoll'

export type Alert = {
  id: string
  module: ModuleId
  title: string
  detail: string
  /** hash route that resolves it */
  href: string
}

export type ModuleId = 'projects' | 'machine' | 'urls' | 'ports' | 'docker' | 'processes' | 'agents'

type Hub = {
  system?: System
  history: HistoryPoint[]
  projects?: Project[]
  ports?: Port[]
  docker?: Docker
  agents?: Agents
  alerts: Alert[]
  error: ApiError | Error | null
  refreshProjects: () => void
  refreshDocker: () => void
}

const HubContext = createContext<Hub | null>(null)

const HISTORY_SECONDS = 10 * 60
const DISK_BUDGET = 90
const MEM_BUDGET = 92
const CPU_BUDGET = 90

function deriveAlerts(system?: System, history: HistoryPoint[] = [], projects?: Project[], docker?: Docker, agents?: Agents): Alert[] {
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
      out.push({ id: `agent:${a.pane_id}`, module: 'agents', title: `${a.name || a.kind} in ${where} is waiting for you`, detail: a.title || 'Approval or question', href: '#/m/agents' })
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
  const system = usePoll<System>('system', 2000)
  const projects = usePoll<Project[]>('projects', 10000)
  const ports = usePoll<Port[]>('ports', 5000)
  const docker = usePoll<Docker>('docker', 5000)
  const agents = usePoll<Agents>('agents', 4000)
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
    () => deriveAlerts(system.data, history, projects.data, docker.data, agents.data),
    [system.data, history, projects.data, docker.data, agents.data],
  )

  const value: Hub = {
    system: system.data,
    history,
    projects: projects.data,
    ports: ports.data,
    docker: docker.data,
    agents: agents.data,
    alerts,
    error: system.error ?? projects.error,
    refreshProjects: projects.refresh,
    refreshDocker: docker.refresh,
  }
  return <HubContext.Provider value={value}>{children}</HubContext.Provider>
}

export function useHub(): Hub {
  const hub = useContext(HubContext)
  if (!hub) throw new Error('useHub outside HubProvider')
  return hub
}
