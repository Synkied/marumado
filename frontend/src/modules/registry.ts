import type { IconName } from '../components/Icon'
import { ago } from '../lib/format'
import { downsample, niceMax } from '../lib/chart'
import type { HistoryPoint } from '../lib/types'
import type { ModuleId } from '../lib/hub'
import { VIEW_OF } from '../lib/route'
import { useHub } from '../lib/hub'
import { useMachines } from '../lib/machines'

/** One item on a lanes chart: on (running, working, up), done, off (idle, stopped), or fault (needs you). */
export type Lane = 'on' | 'done' | 'off' | 'fault'

/** What a channel's pen has drawn on its disc.
    trace: readings 0..1, oldest first, a null where there was none (a gap); ticks: event counts per slot;
    lanes: one arc per item. `span` is how much time the disc holds, printed at its foot. */
export type Chart =
  | { kind: 'trace'; values: (number | null)[]; span: string }
  | { kind: 'ticks'; values: number[]; span: string }
  | { kind: 'lanes'; items: Lane[] }

const minutes = (history: HistoryPoint[]) => (history.length > 1 ? `${Math.max(1, Math.round((history[history.length - 1].t - history[0].t) / 60))} min` : 'now')

export type Summary = {
  value: string
  fraction: number | null
  caption?: string
  fault: boolean
  off?: boolean
  /** Nothing to look at right now (nothing running, nothing open): the pen draws lighter. */
  quiet?: boolean
  /** Something is at work (an agent, a task, a busy CPU): the pen tip pulses. */
  busy?: boolean
  /** The one thing that matters most, by name ("zen-designer · working"), shown on the disc on the home table. */
  subject?: string
  /** The channel's recent record, drawn around its disc. */
  chart?: Chart
}

/** A first name, and how many more stand behind it: "web", "web +2". */
const names = (all: string[]) => (all.length ? `${all[0]}${all.length > 1 ? ` +${all.length - 1}` : ''}` : undefined)

export type ModuleMeta = { id: ModuleId; label: string; icon: IconName; blurb: string }

export const MODULES: ModuleMeta[] = [
  { id: 'projects', label: 'Projects', icon: 'folder', blurb: 'Every project folder and its links' },
  { id: 'machine', label: 'Machine', icon: 'chip', blurb: 'CPU, memory, disks and network' },
  { id: 'processes', label: 'Processes', icon: 'processes', blurb: 'What is running, and what is heavy' },
  { id: 'ports', label: 'Ports', icon: 'ports', blurb: 'What is listening, and for which project' },
  { id: 'docker', label: 'Docker', icon: 'container', blurb: 'Containers and their logs' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks', blurb: 'A to-do list you can hand to agents, and what they did' },
  { id: 'agents', label: 'Agents', icon: 'agent', blurb: 'Coding agents in Herdr and what they are doing' },
  { id: 'urls', label: 'URLs', icon: 'globe', blurb: 'Up or down, checked every minute' },
  { id: 'momentum', label: 'Momentum', icon: 'momentum', blurb: 'Which projects are moving, and what to push or park' },
  { id: 'skills', label: 'Skills', icon: 'skills', blurb: 'What you use, what is getting rusty, what to learn' },
  { id: 'machines', label: 'Machines', icon: 'server', blurb: 'Other machines, reached over SSH, side by side' },
]

export const meta = (id: ModuleId) => MODULES.find((m) => m.id === id)!

/** The modules that can sit on the panel: everything but the views inside another module. */
export const PANEL_MODULES = MODULES.filter((m) => !VIEW_OF[m.id])

/** A module's page and the views read as its tabs, in order. */
export const viewsOf = (home: ModuleId) => [home, ...MODULES.filter((m) => VIEW_OF[m.id] === home).map((m) => m.id)]

/** Commits per week summed over every project, oldest first. */
function weeklyCommits(projects: { detected: { weekly_commits?: number[] } }[]): number[] {
  const weeks = Math.max(0, ...projects.map((p) => p.detected.weekly_commits?.length ?? 0))
  const out = Array<number>(weeks).fill(0)
  for (const p of projects) {
    const w = p.detected.weekly_commits ?? []
    w.forEach((n, i) => (out[weeks - w.length + i] += n))
  }
  return out
}

/** Every live URL's latency, aligned on the newest check (one a minute): the slowest site at each minute, scaled to
    a round top, and a gap wherever any site failed. */
function latencyTrace(series: (number | null)[][]): Chart {
  const n = Math.max(0, ...series.map((s) => s.length))
  const values: (number | null)[] = []
  for (let i = 0; i < n; i++) {
    const at = series.map((s) => s[s.length - n + i]).filter((v) => v !== undefined)
    values.push(at.some((v) => v === null) ? null : Math.max(0, ...(at as number[])))
  }
  const top = niceMax(Math.max(0, ...values.filter((v): v is number => v != null)))
  return { kind: 'trace', values: values.map((v) => (v == null ? null : v / top)), span: `${n} min` }
}

/** One dial's worth of state for every module. */
export function useSummaries(): Record<ModuleId, Summary | null> {
  const { system, history, projects, agents, tasks, alerts } = useHub()
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
      // Commits per week across every project, as event ticks round the rim.
      chart: { kind: 'ticks', values: weeklyCommits(code), span: '12 wk' },
    }
  }

  const machineSum: Summary | null = system
    ? {
        value: `${Math.round(system.cpu.percent)}%`,
        fraction: system.cpu.percent / 100,
        caption: `cpu · mem ${Math.round(system.memory.percent)}%`,
        // Its tabs' alarms (an unhealthy container) show on its dial.
        fault: ['machine', 'processes', 'ports', 'docker'].some((id) => faulty.has(id as ModuleId)),
        quiet: system.cpu.percent < 15 && system.memory.percent < 70,
        busy: system.cpu.percent >= 50,
        chart: { kind: 'trace', values: downsample(history.map((h) => h.cpu / 100), 180), span: minutes(history) },
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
          chart: latencyTrace(checked.map((p) => p.status.online.latency)),
        }
      : { value: '—', fraction: null, caption: 'no live URLs yet', fault: false, quiet: true }
  }

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
          chart: { kind: 'lanes', items: live.map((a) => (a.status === 'blocked' ? 'fault' : a.status === 'working' ? 'on' : 'off')) },
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
      // The latest tasks, oldest first: done ones faded, the ones at work inked, the ones that need you in the alarm pen.
      chart: {
        kind: 'lanes',
        items: [...tasks]
          .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
          .slice(-24)
          .map((t) => (t.state === 'blocked' || t.state === 'failed' ? 'fault' : t.state === 'working' || t.state === 'starting' ? 'on' : t.state === 'done' || t.state === 'review' ? 'done' : 'off')),
      },
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
      chart: { kind: 'lanes', items: machines.map((m) => (m.state === 'down' ? 'fault' : m.state === 'up' ? 'on' : 'off')) },
    }
  }

  return { tasks: tasksSum, machines: machinesSum, momentum: null, skills: null, agents: agentsSum, projects: projectsSum, machine: machineSum, urls: urlsSum, ports: null, docker: null, processes: null }
}
