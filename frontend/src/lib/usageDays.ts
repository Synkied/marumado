import type { UsageReport, UsageRow } from './types'

/** Tokens by kind, as in core/usage.py. */
export type Tokens = { input: number; cache_write: number; cache_read: number; output: number }

/** What a stretch of rows used: tokens by kind and in all, calls, the cost of the priced models, and whether every
    model had a price. */
export type Sum = { tokens: Tokens; total: number; calls: number; cost: number; priced: boolean }

export type Day = Sum & { day: string; models: Map<string, Sum>; projects: Map<string, Sum>; sources: Map<string, Sum> }

const empty = (): Sum => ({ tokens: { input: 0, cache_write: 0, cache_read: 0, output: 0 }, total: 0, calls: 0, cost: 0, priced: true })

function add(into: Sum, r: UsageRow, priced: boolean) {
  const [, , , , calls, input, write, write1h, read, output, cost] = r
  into.calls += calls
  into.tokens.input += input
  into.tokens.cache_write += write + write1h
  into.tokens.cache_read += read
  into.tokens.output += output
  into.total += input + write + write1h + read + output
  into.cost += cost
  into.priced &&= priced
}

function addTo(map: Map<string, Sum>, key: string, r: UsageRow, priced: boolean) {
  let s = map.get(key)
  if (!s) map.set(key, (s = empty()))
  add(s, r, priced)
}

/** A day as YYYY-MM-DD in this browser's time zone, `back` days before today. */
export function dayKey(back = 0, from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Every day from today back to the oldest in the report (at least `span` days), newest first; a day without use is
    there too, empty, so a chart has no holes. */
export function usageDays(report: UsageReport | undefined, span = 30): Day[] {
  const priced = new Set(report?.priced ?? [])
  const byDay = new Map<string, Day>()
  const day = (key: string) => {
    let d = byDay.get(key)
    if (!d) byDay.set(key, (d = { ...empty(), day: key, models: new Map(), projects: new Map(), sources: new Map() }))
    return d
  }
  for (const r of report?.rows ?? []) {
    const d = day(r[0])
    const p = priced.has(r[3])
    add(d, r, p)
    addTo(d.models, r[3], r, p)
    addTo(d.projects, r[2], r, p)
    addTo(d.sources, r[1], r, p)
  }
  const oldest = [...byDay.keys()].sort()[0]
  const out: Day[] = []
  for (let back = 0; ; back++) {
    const key = dayKey(back)
    if (back >= span && (!oldest || key < oldest)) break
    out.push(day(key))
  }
  return out
}

/** The sum of several days, with their models and projects summed too. */
export function sumDays(days: Day[]): Day {
  const out: Day = { ...empty(), day: '', models: new Map(), projects: new Map(), sources: new Map() }
  const merge = (into: Map<string, Sum>, from: Map<string, Sum>) => {
    for (const [k, s] of from) {
      const t = into.get(k) ?? empty()
      into.set(k, plus(t, s))
    }
  }
  for (const d of days) {
    Object.assign(out, plus(out, d))
    merge(out.models, d.models)
    merge(out.projects, d.projects)
    merge(out.sources, d.sources)
  }
  return out
}

function plus(a: Sum, b: Sum): Sum {
  return {
    tokens: {
      input: a.tokens.input + b.tokens.input,
      cache_write: a.tokens.cache_write + b.tokens.cache_write,
      cache_read: a.tokens.cache_read + b.tokens.cache_read,
      output: a.tokens.output + b.tokens.output,
    },
    total: a.total + b.total,
    calls: a.calls + b.calls,
    cost: a.cost + b.cost,
    priced: a.priced && b.priced,
  }
}

/** "Today", "Yesterday", or "Mon 26 Oct" (with the year when it isn't this one). */
export function dayLabel(key: string): string {
  if (key === dayKey(0)) return 'Today'
  if (key === dayKey(1)) return 'Yesterday'
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(y !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
}

/** "Oct 6": a chart's axis. */
export function shortDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
