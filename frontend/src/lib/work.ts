import type { Agent, Agents, AgentSource, Place, Project, Task } from './types'

/** A machine's id in Machines, for an agent source that is that machine (see core/herdr.py MACHINE_BASE). */
export const MACHINE_SOURCE_BASE = 1_000_000
export const machineOfSource = (s: Pick<AgentSource, 'id' | 'kind'>) => (s.kind === 'machine' ? s.id - MACHINE_SOURCE_BASE : null)

const OPEN: Task['state'][] = ['todo', 'queued', 'starting', 'working', 'blocked', 'review', 'failed']

/** The project's tasks still to finish, the ones that need you first. */
export function openTasks(p: Pick<Project, 'id'>, tasks: Task[] | undefined): Task[] {
  const rank = (t: Task) => ['blocked', 'failed', 'review', 'working', 'starting', 'queued', 'todo'].indexOf(t.state)
  return (tasks ?? []).filter((t) => t.project === p.id && OPEN.includes(t.state)).sort((a, b) => rank(a) - rank(b))
}

/** The agents open in the project's folder, here or on another machine (not plain shells). */
export function projectAgents(p: Pick<Project, 'id'>, agents: Agents | undefined): Agent[] {
  return (agents?.agents ?? []).filter((a) => a.kind !== 'terminal' && a.project?.id === p.id)
}

/** What is being done on the project right now, by agents or for you to review. */
export type Activity = { working: number; blocked: number; review: number; open: number }

export function activity(p: Pick<Project, 'id'>, tasks: Task[] | undefined, agents: Agents | undefined): Activity {
  const open = openTasks(p, tasks)
  const mine = projectAgents(p, agents)
  return {
    working: Math.max(mine.filter((a) => a.status === 'working').length, open.filter((t) => t.state === 'working' || t.state === 'starting').length),
    blocked: Math.max(mine.filter((a) => a.status === 'blocked').length, open.filter((t) => t.state === 'blocked').length),
    review: open.filter((t) => t.state === 'review').length,
    open: open.length,
  }
}

/** Something is moving the project along even without a fresh commit: an agent at work, or work waiting for review. */
export const atWork = (a: Activity) => a.working > 0 || a.blocked > 0 || a.review > 0

/** One short phrase for a project's work, for list rows: "agent working", "1 needs you", "2 open tasks". */
export function workLine(a: Activity): string {
  if (a.blocked) return `${a.blocked} need${a.blocked === 1 ? 's' : ''} you`
  if (a.working) return a.working === 1 ? 'agent working' : `${a.working} agents working`
  if (a.review) return `${a.review} to review`
  if (a.open) return `${a.open} open task${a.open === 1 ? '' : 's'}`
  return ''
}

/** The other machines it runs on, and those it only has a folder on. */
export const runningPlaces = (p: Pick<Project, 'places'>): Place[] => (p.places ?? []).filter((x) => x.running)

/** Running anywhere: on this machine, or on another. */
export const runsAnywhere = (p: Pick<Project, 'running' | 'places'>) => p.running || runningPlaces(p).length > 0

/** "Running", "Running on server-1", "Running here and on server-1 +1". */
export function whereRunning(p: Pick<Project, 'running' | 'places'>): string {
  const names = [...new Set(runningPlaces(p).map((x) => x.machine_name))]
  if (!names.length) return p.running ? 'Running' : ''
  const elsewhere = `${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ''}`
  return p.running ? `Running here and on ${elsewhere}` : `Running on ${elsewhere}`
}

/** The project's folder in an agent source: on another machine, as its Marumado reports it ('' if it has none there);
    elsewhere this machine's folder (a VM may share it, or Herdr starts in its default folder). */
export function folderIn(project: Pick<Project, 'path' | 'places'> | undefined, s: Pick<AgentSource, 'id' | 'kind'>): string {
  if (!project) return ''
  const machine = machineOfSource(s)
  if (machine == null) return project.path
  return project.places?.find((x) => x.machine === machine && x.dir)?.dir ?? ''
}

/** Where the project's agents start by default: its own pick, else its scan folder's; null when neither is set. */
export const defaultSource = (project: Pick<Project, 'agent_source' | 'folder_source'>): number | null => project.agent_source ?? project.folder_source ?? null

/** Where a new agent for the project can start: the sources that answer, the project's default first, then those
    that have its folder. */
export function startPlaces(project: Pick<Project, 'path' | 'places' | 'agent_source' | 'folder_source'> | undefined, agents: Agents | undefined): AgentSource[] {
  const rank = (s: AgentSource) =>
    !project ? 0 : s.id === defaultSource(project) ? -1 : machineOfSource(s) == null ? (s.kind === 'env' && project.path ? 0 : 1) : folderIn(project, s) ? 0 : 2
  return (agents?.sources ?? []).filter((s) => s.available).sort((a, b) => rank(a) - rank(b))
}
