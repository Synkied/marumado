import type { IconName } from '../components/Icon'
import type { ModuleId } from '../lib/hub'
import { useHub } from '../lib/hub'

export type Summary = {
  value: string
  fraction: number | null
  caption?: string
  fault: boolean
  off?: boolean
}

export type ModuleMeta = { id: ModuleId; label: string; icon: IconName; blurb: string }

export const MODULES: ModuleMeta[] = [
  { id: 'projects', label: 'Projects', icon: 'folder', blurb: 'Every project folder and its links' },
  { id: 'machine', label: 'Machine', icon: 'chip', blurb: 'CPU, memory, disks and network' },
  { id: 'agents', label: 'Agents', icon: 'agent', blurb: 'Coding agents in Herdr and what they are doing' },
  { id: 'urls', label: 'URLs', icon: 'globe', blurb: 'Up or down, checked every minute' },
  { id: 'ports', label: 'Ports', icon: 'ports', blurb: 'What is listening, and for which project' },
  { id: 'docker', label: 'Docker', icon: 'container', blurb: 'Containers and their logs' },
  { id: 'processes', label: 'Processes', icon: 'processes', blurb: 'What is running, and what is heavy' },
]

export const meta = (id: ModuleId) => MODULES.find((m) => m.id === id)!

/** One dial's worth of state for every module. */
export function useSummaries(): Record<ModuleId, Summary | null> {
  const { system, projects, ports, docker, agents, alerts } = useHub()
  const faulty = new Set(alerts.map((a) => a.module))

  const code = projects?.filter((p) => p.kind === 'project')
  const projectsSum: Summary | null = code
    ? {
        value: String(code.length),
        fraction: code.length ? code.filter((p) => p.running).length / code.length : 0,
        caption: `${code.filter((p) => p.running).length} running`,
        fault: faulty.has('projects'),
      }
    : null

  const machineSum: Summary | null = system
    ? { value: `${Math.round(system.cpu.percent)}%`, fraction: system.cpu.percent / 100, caption: `cpu · mem ${Math.round(system.memory.percent)}%`, fault: faulty.has('machine') }
    : null

  let urlsSum: Summary | null = null
  if (projects) {
    const checked = projects.filter((p) => p.online_url && p.status.online.latest)
    const up = checked.filter((p) => p.status.online.latest!.ok).length
    urlsSum = checked.length
      ? { value: `${Math.round((up / checked.length) * 100)}%`, fraction: up / checked.length, caption: `${up} of ${checked.length} up`, fault: faulty.has('urls') }
      : { value: '—', fraction: null, caption: 'no live URLs yet', fault: false }
  }

  const portsSum: Summary | null = ports
    ? {
        value: String(ports.length),
        fraction: ports.length ? ports.filter((p) => p.project).length / ports.length : 0,
        caption: `${ports.filter((p) => p.project).length} linked`,
        fault: false,
      }
    : null

  let dockerSum: Summary | null = null
  if (docker) {
    const running = docker.containers.filter((c) => c.status === 'running').length
    dockerSum = docker.available
      ? { value: String(running), fraction: docker.containers.length ? running / docker.containers.length : 0, caption: `${docker.containers.length} total`, fault: faulty.has('docker') }
      : { value: 'OFF', fraction: null, caption: 'not available', fault: false, off: true }
  }

  const processesSum: Summary | null = system
    ? { value: String(system.process_count ?? '—'), fraction: Math.min(1, system.cpu.load[0] / system.host.cores_logical), caption: `load ${system.cpu.load[0].toFixed(2)}`, fault: false }
    : null

  let agentsSum: Summary | null = null
  if (agents) {
    const live = agents.agents
    const working = live.filter((a) => a.status === 'working').length
    const blocked = live.filter((a) => a.status === 'blocked').length
    agentsSum = agents.available
      ? {
          value: String(live.length),
          fraction: live.length ? working / live.length : 0,
          caption: blocked ? `${blocked} waiting` : `${working} working`,
          fault: faulty.has('agents'),
        }
      : { value: 'OFF', fraction: null, caption: 'Herdr not running', fault: false, off: true }
  }

  return { agents: agentsSum, projects: projectsSum, machine: machineSum, urls: urlsSum, ports: portsSum, docker: dockerSum, processes: processesSum }
}
