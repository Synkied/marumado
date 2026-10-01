import type { IconName } from '../components/Icon'
import { pace, skillMap, tracked } from '../lib/growth'
import type { ModuleId } from '../lib/hub'
import { useHub } from '../lib/hub'
import { useMachines } from '../lib/machines'

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
  { id: 'momentum', label: 'Momentum', icon: 'momentum', blurb: 'Which projects are moving, and what to push or park' },
  { id: 'skills', label: 'Skills', icon: 'skills', blurb: 'What you use, what is getting rusty, what to learn' },
  { id: 'machines', label: 'Machines', icon: 'server', blurb: 'Other machines, reached over SSH, side by side' },
]

export const meta = (id: ModuleId) => MODULES.find((m) => m.id === id)!

/** One dial's worth of state for every module. */
export function useSummaries(): Record<ModuleId, Summary | null> {
  const { system, projects, ports, docker, agents, skills, alerts } = useHub()
  const { machines } = useMachines()
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

  let momentumSum: Summary | null = null
  if (projects) {
    const judged = tracked(projects).filter((p) => pace(p) !== 'none')
    const moving = judged.filter((p) => pace(p) === 'moving').length
    const undecided = judged.filter((p) => pace(p) === 'stalled' && !p.focus).length
    momentumSum = {
      value: String(moving),
      fraction: judged.length ? moving / judged.length : 0,
      caption: faulty.has('momentum') ? 'push slipping' : undecided ? `${undecided} to decide` : 'moving',
      fault: faulty.has('momentum'),
    }
  }

  let skillsSum: Summary | null = null
  if (projects && skills) {
    const rows = skillMap(projects, skills).filter((r) => r.intent !== 'ignore')
    const used = rows.filter((r) => r.projects.length)
    const active = used.filter((r) => r.use === 'active').length
    const learning = rows.filter((r) => r.intent === 'learn').length
    skillsSum = {
      value: String(active),
      fraction: used.length ? active / used.length : 0,
      caption: learning ? `active · ${learning} to learn` : 'active',
      fault: false,
    }
  }

  let machinesSum: Summary | null = null
  if (machines) {
    const up = machines.filter((m) => m.state === 'up').length
    const down = machines.filter((m) => m.state === 'down').length
    machinesSum = {
      value: machines.length > 1 ? `${up}/${machines.length}` : '1',
      fraction: up / machines.length,
      caption: machines.length === 1 ? 'only this one' : down ? `${down} unreachable` : 'all reachable',
      fault: faulty.has('machines'),
    }
  }

  return { machines: machinesSum, momentum: momentumSum, skills: skillsSum, agents: agentsSum, projects: projectsSum, machine: machineSum, urls: urlsSum, ports: portsSum, docker: dockerSum, processes: processesSum }
}
