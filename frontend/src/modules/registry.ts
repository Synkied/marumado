import type { IconName } from '../components/Icon'
import { ago } from '../lib/format'
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
  /** Nothing to look at right now (nothing running, nothing open): the stone pales but keeps its mineral. */
  quiet?: boolean
  /** Something is at work (an agent, a task, a busy CPU): ripples spread slowly from the stone. */
  busy?: boolean
  /** The one thing that matters most, by name ("zen-designer · working"), shown on the stone in the garden. */
  subject?: string
}

/** A first name, and how many more stand behind it: "web", "web +2". */
const names = (all: string[]) => (all.length ? `${all[0]}${all.length > 1 ? ` +${all.length - 1}` : ''}` : undefined)

export type ModuleMeta = { id: ModuleId; label: string; icon: IconName; blurb: string }

export const MODULES: ModuleMeta[] = [
  { id: 'projects', label: 'Projects', icon: 'folder', blurb: 'Every project folder and its links' },
  { id: 'machine', label: 'Machine', icon: 'chip', blurb: 'CPU, memory, disks and network' },
  { id: 'agents', label: 'Agents', icon: 'agent', blurb: 'Coding agents in Herdr and what they are doing' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks', blurb: 'A to-do list you can hand to agents, and what they did' },
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
  const { system, projects, ports, docker, agents, tasks, skills, alerts } = useHub()
  const { machines } = useMachines()
  const faulty = new Set(alerts.map((a) => a.module))

  const code = projects?.filter((p) => p.kind === 'project')
  let projectsSum: Summary | null = null
  if (code) {
    const running = code.filter((p) => p.running)
    const latest = code.filter((p) => p.detected.last_commit_at).sort((a, b) => Date.parse(b.detected.last_commit_at!) - Date.parse(a.detected.last_commit_at!))[0]
    projectsSum = {
      value: String(code.length),
      fraction: code.length ? running.length / code.length : 0,
      caption: `${running.length} running`,
      fault: faulty.has('projects'),
      quiet: !running.length,
      subject: running.length ? `${names(running.map((p) => p.name))} running` : latest ? `${latest.name} · ${ago(latest.detected.last_commit_at)}` : undefined,
    }
  }

  const machineSum: Summary | null = system
    ? {
        value: `${Math.round(system.cpu.percent)}%`,
        fraction: system.cpu.percent / 100,
        caption: `cpu · mem ${Math.round(system.memory.percent)}%`,
        fault: faulty.has('machine'),
        quiet: system.cpu.percent < 15 && system.memory.percent < 70,
        busy: system.cpu.percent >= 50,
      }
    : null

  let urlsSum: Summary | null = null
  if (projects) {
    const checked = projects.filter((p) => p.online_url && p.status.online.latest)
    const up = checked.filter((p) => p.status.online.latest!.ok).length
    const down = checked.filter((p) => !p.status.online.latest!.ok).map((p) => p.name)
    urlsSum = checked.length
      ? {
          value: `${Math.round((up / checked.length) * 100)}%`,
          fraction: up / checked.length,
          caption: `${up} of ${checked.length} up`,
          fault: faulty.has('urls'),
          quiet: !down.length,
          subject: down.length ? `${names(down)} down` : undefined,
        }
      : { value: '—', fraction: null, caption: 'no live URLs yet', fault: false, quiet: true }
  }

  let portsSum: Summary | null = null
  if (ports) {
    const linked = ports.filter((p) => p.project)
    portsSum = {
      value: String(ports.length),
      fraction: ports.length ? linked.length / ports.length : 0,
      caption: `${linked.length} linked`,
      fault: false,
      quiet: !linked.length,
      subject: linked.length ? names(linked.map((p) => `:${p.port} ${p.project!.name}`)) : undefined,
    }
  }

  let dockerSum: Summary | null = null
  if (docker) {
    const running = docker.containers.filter((c) => c.status === 'running')
    dockerSum = docker.available
      ? {
          value: String(running.length),
          fraction: docker.containers.length ? running.length / docker.containers.length : 0,
          caption: `${docker.containers.length} total`,
          fault: faulty.has('docker'),
          quiet: !running.length,
          subject: running.length ? names(running.map((c) => c.compose_project || c.name)) : undefined,
        }
      : { value: 'OFF', fraction: null, caption: 'not available', fault: false, off: true }
  }

  const processesSum: Summary | null = system
    ? {
        value: String(system.process_count ?? '—'),
        fraction: Math.min(1, system.cpu.load[0] / system.host.cores_logical),
        caption: `load ${system.cpu.load[0].toFixed(2)}`,
        fault: false,
        quiet: system.cpu.load[0] / system.host.cores_logical < 0.3,
        busy: system.cpu.load[0] / system.host.cores_logical >= 0.7,
      }
    : null

  let agentsSum: Summary | null = null
  if (agents) {
    const live = agents.agents.filter((a) => a.kind !== 'terminal')
    const working = live.filter((a) => a.status === 'working')
    const blocked = live.filter((a) => a.status === 'blocked')
    agentsSum = agents.available
      ? {
          value: String(live.length),
          fraction: live.length ? working.length / live.length : 0,
          caption: blocked.length ? `${blocked.length} waiting` : `${working.length} working`,
          fault: faulty.has('agents'),
          quiet: !working.length && !blocked.length,
          busy: working.length > 0,
          subject: blocked.length
            ? `${names(blocked.map((a) => a.name || a.kind))} · needs you`
            : working.length
              ? `${names(working.map((a) => a.name || a.kind))} · working`
              : live.length
                ? 'all resting'
                : undefined,
        }
      : { value: 'OFF', fraction: null, caption: 'Herdr not running', fault: false, off: true }
  }

  let tasksSum: Summary | null = null
  if (tasks) {
    const open = tasks.filter((t) => t.state !== 'done')
    const working = open.filter((t) => t.state === 'working' || t.state === 'starting')
    const blocked = open.filter((t) => t.state === 'blocked')
    const review = open.filter((t) => t.state === 'review')
    const todo = open.filter((t) => t.state === 'todo')
    // The task to look at first: one that needs you, then one at work, then one to review, then the next to do.
    const first = blocked[0] ?? working[0] ?? review[0] ?? todo[0]
    tasksSum = {
      value: String(open.length),
      fraction: tasks.length ? (tasks.length - open.length) / tasks.length : 0,
      caption: blocked.length
        ? `${blocked.length} need${blocked.length === 1 ? 's' : ''} you`
        : working.length
          ? `${working.length} working`
          : review.length
            ? `${review.length} to review`
            : open.length
              ? 'to do'
              : 'all done',
      fault: faulty.has('tasks'),
      quiet: !open.length,
      busy: working.length > 0,
      subject: first?.title,
    }
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
      quiet: !moving && !undecided,
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
      quiet: !active && !learning,
    }
  }

  let machinesSum: Summary | null = null
  if (machines) {
    const up = machines.filter((m) => m.state === 'up').length
    const down = machines.filter((m) => m.state === 'down')
    machinesSum = {
      value: machines.length > 1 ? `${up}/${machines.length}` : '1',
      fraction: up / machines.length,
      caption: machines.length === 1 ? 'only this one' : down.length ? `${down.length} unreachable` : 'all reachable',
      fault: faulty.has('machines'),
      quiet: !down.length,
      subject: down.length ? `${names(down.map((m) => m.name))} unreachable` : undefined,
    }
  }

  return { tasks: tasksSum, machines: machinesSum, momentum: momentumSum, skills: skillsSum, agents: agentsSum, projects: projectsSum, machine: machineSum, urls: urlsSum, ports: portsSum, docker: dockerSum, processes: processesSum }
}
