import { CPU_BUDGET, DISK_BUDGET, MEM_BUDGET, type ModuleId } from '../lib/hub'
import type { Machine } from '../lib/types'

/** One reading on a machine's block on home. A module that adds a reading adds one entry to READOUTS. */
export type ReadoutId = 'cpu' | 'memory' | 'disk' | 'urls' | 'agents' | 'docker' | 'tasks' | 'projects' | 'ports'

/** One part of a seal: on (running, working, up), off (idle, stopped), or fault (needs you). */
export type Part = 'on' | 'off' | 'fault'

/** What a readout cell shows: its seal (a small round chart in the module's pen), its value, and under it a line of
    words or the CPU's trace. The value stays a number or a word or two ("8%", "2 of 4", "1 down", "off"), so it
    reads large in a cell as narrow as 140px; what it means goes in the words.
    ok is drawn in the module's pen, off pale (the module isn't there), fault in the alarm pen. */
export type Reading = {
  value: string
  detail?: string
  state: 'ok' | 'off' | 'fault'
  /** share: an arc of 0..1 with a budget tick; parts: one arc per item, as on the module's disc */
  seal?: { kind: 'share'; value: number; limit?: number } | { kind: 'parts'; items: Part[] }
  graphic?: { kind: 'trace'; values: (number | null)[]; limit: number }
  /** the longer story, for the cell's tooltip */
  title?: string
}

export type Readout = {
  id: ReadoutId
  label: string
  /** the module this reading opens, on its machine */
  module: ModuleId
  /** whose pen draws it, when not its module's */
  pen?: ModuleId
  /** what the reading says, for the arrange list */
  blurb: string
  /** null: the machine hasn't told us (unreachable, still reading, or an older Marumado) */
  read: (m: Machine) => Reading | null
}

const names = (all: string[]) => (all.length ? `${all[0]}${all.length > 1 ? ` +${all.length - 1}` : ''}` : '')

const MAX_PARTS = 12

/** A seal of parts from counts, in order: the ones that need you, then those on, then the rest. Past 12 items the
    parts would be specks, so it becomes a share of the ring instead. */
function parts(total: number, on: number, fault = 0): Reading['seal'] {
  if (!total) return undefined
  if (total > MAX_PARTS) return { kind: 'share', value: (on + fault) / total }
  return { kind: 'parts', items: [...Array<Part>(fault).fill('fault'), ...Array<Part>(on).fill('on'), ...Array<Part>(Math.max(0, total - on - fault)).fill('off')] }
}

const percent = (v: number, budget: number): Pick<Reading, 'value' | 'state' | 'seal'> => ({
  value: `${Math.round(v)}%`,
  state: v >= budget ? 'fault' : 'ok',
  seal: { kind: 'share', value: v / 100, limit: budget / 100 },
})

/** Every reading a machine block can show, in the default order: the vitals first, then what needs you most often,
    then the counts checked least. */
export const READOUTS: Readout[] = [
  {
    id: 'cpu',
    label: 'CPU',
    module: 'machine',
    blurb: 'Load now, and its line over the last half hour',
    read: (m) => {
      const s = m.summary
      if (!s) return null
      return {
        ...percent(s.cpu, CPU_BUDGET),
        graphic: { kind: 'trace', values: (s.trace?.length ? s.trace : [s.cpu]).map((v) => (v == null ? null : v / 100)), limit: CPU_BUDGET / 100 },
        title: `CPU ${Math.round(s.cpu)}% · load ${s.load.map((l) => l.toFixed(2)).join(' ')}`,
      }
    },
  },
  {
    id: 'memory',
    label: 'RAM',
    module: 'machine',
    pen: 'processes',
    blurb: 'Memory in use, against its budget',
    read: (m) => (m.summary ? { ...percent(m.summary.memory, MEM_BUDGET), detail: `budget ${MEM_BUDGET}%`, title: `Memory ${Math.round(m.summary.memory)}% · budget ${MEM_BUDGET}%` } : null),
  },
  {
    id: 'disk',
    label: 'Disk',
    module: 'machine',
    pen: 'momentum',
    blurb: 'The fullest disk, against its budget',
    read: (m) => {
      const d = m.summary?.disk
      if (!m.summary) return null
      if (!d) return { value: '—', state: 'off', detail: 'no disk read' }
      return { ...percent(d.percent, DISK_BUDGET), detail: `budget ${DISK_BUDGET}%`, title: `Fullest disk: ${d.mount}, ${Math.round(d.percent)}% · budget ${DISK_BUDGET}%` }
    },
  },
  {
    id: 'urls',
    label: 'URLs',
    module: 'urls',
    blurb: 'Live sites up or down',
    read: (m) => {
      const u = m.overview?.urls
      if (!u) return null
      if (!u.checked) return { value: '—', detail: 'no live URLs', state: 'off' }
      if (u.down.length) {
        const first = u.down[0]
        return {
          value: `${u.down.length} down`,
          detail: `${names(u.down.map((d) => d.name))} · ${first.detail}`,
          state: 'fault',
          seal: parts(u.checked, u.up, u.down.length),
          title: u.down.map((d) => `${d.name}: ${d.detail}`).join('\n'),
        }
      }
      return { value: `${u.up} of ${u.checked}`, detail: 'up', state: 'ok', seal: parts(u.checked, u.up) }
    },
  },
  {
    id: 'agents',
    label: 'Agents',
    module: 'agents',
    blurb: 'Coding agents working, or waiting on you',
    read: (m) => {
      const a = m.overview?.agents
      if (!a) return null
      if (!a.available) return { value: 'off', detail: 'no Herdr', state: 'off' }
      if (a.blocked.length) {
        const b = a.blocked[0]
        return {
          value: String(a.blocked.length),
          detail: `waiting · ${b.label} · ${b.where}`,
          state: 'fault',
          seal: parts(a.total, a.working, a.blocked.length),
          title: a.blocked.map((x) => `${x.label} in ${x.where} is waiting for you`).join('\n'),
        }
      }
      if (!a.total) return { value: '0', detail: 'none running', state: 'ok' }
      return { value: `${a.working} of ${a.total}`, detail: 'working', state: 'ok', seal: parts(a.total, a.working) }
    },
  },
  {
    id: 'docker',
    label: 'Docker',
    module: 'docker',
    blurb: 'Containers running, and any unhealthy',
    read: (m) => {
      const d = m.overview?.docker
      if (!d) return null
      if (!d.available) return { value: 'off', detail: 'not available', state: 'off' }
      if (d.unhealthy.length) {
        const n = d.unhealthy.length
        return { value: String(n), detail: `unhealthy · ${names(d.unhealthy)}`, state: 'fault', title: d.unhealthy.join('\n'), seal: parts(d.total, Math.max(0, d.running - n), n) }
      }
      if (!d.total) return { value: '0', detail: 'no containers', state: 'ok' }
      return { value: `${d.running} of ${d.total}`, detail: 'running', state: 'ok', seal: parts(d.total, d.running) }
    },
  },
  {
    id: 'tasks',
    label: 'Tasks',
    module: 'tasks',
    blurb: 'Open tasks, and any waiting on you',
    read: (m) => {
      const t = m.overview?.tasks
      if (!t) return null
      const seal = parts(t.open, t.working, t.blocked)
      if (t.blocked) return { value: String(t.blocked), detail: t.blocked === 1 ? 'needs you' : 'need you', state: 'fault', seal }
      const detail = t.working ? `${t.working} working` : t.failed ? `${t.failed} failed` : t.open ? 'open' : 'all done'
      return { value: String(t.open), detail, state: 'ok', seal }
    },
  },
  {
    id: 'projects',
    label: 'Projects',
    module: 'projects',
    blurb: 'Projects, and how many are running',
    read: (m) => {
      const p = m.overview?.projects
      if (!p) return null
      return { value: String(p.total), detail: `${p.running} running`, state: 'ok', seal: parts(p.total, p.running) }
    },
  },
  {
    id: 'ports',
    label: 'Ports',
    module: 'ports',
    blurb: 'Ports listening',
    // A count with no state: its parts are drawn pale, one per port.
    read: (m) => (m.overview ? { value: String(m.overview.ports), detail: 'listening', state: 'ok', seal: parts(m.overview.ports, 0) } : null),
  },
]

export const DEFAULT_READOUTS: ReadoutId[] = READOUTS.map((r) => r.id)
export const readout = (id: ReadoutId) => READOUTS.find((r) => r.id === id)
