import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { api } from '../lib/api'
import { Secret } from '../lib/streaming'
import type { Task, Trace, TraceKind, TraceStep } from '../lib/types'

/** What the agent thought and did for a task, read from its session record: a recording with one channel per kind of
    work, the files it touched, and every step in order. */

type Lane = 'think' | 'read' | 'edit' | 'run' | 'you'
const LANES: { id: Lane; label: string }[] = [
  { id: 'think', label: 'Thinking' },
  { id: 'read', label: 'Reading' },
  { id: 'edit', label: 'Editing' },
  { id: 'run', label: 'Running' },
  { id: 'you', label: 'You' },
]
const LANE_OF: Record<TraceKind, Lane> = { think: 'think', say: 'think', read: 'read', search: 'read', edit: 'edit', run: 'run', agent: 'run', tool: 'run', you: 'you', ask: 'you' }

/** A wait on you, from the task's state events: `now` while it lasts. */
export type Wait = { from: number; to: number; now: boolean }

type Loaded = { trace: Trace | null; steps: TraceStep[]; error: string }

/** Polls the trace while the agent may still write to it, fetching only the steps that changed. */
function useTrace(task: Task): Loaded {
  const [state, setState] = useState<Loaded>({ trace: null, steps: [], error: '' })
  const have = useRef<{ path: string; steps: TraceStep[] }>({ path: '', steps: [] })
  const live = task.live
  const load = useCallback(async () => {
    const mine = have.current
    const from = mine.steps.length ? mine.steps[mine.steps.length - 1].i + 1 : 0
    try {
      const t = await api<Trace>(`tasks/${task.id}/trace?from=${from}`)
      if (t.found) {
        if (t.path !== mine.path && from > 0) {
          // Another record than before (the task went to another agent): start over on the next poll.
          have.current = { path: '', steps: [] }
          return
        }
        // The server sends again the steps that may have changed (a tool still running): those replace ours.
        have.current = { path: t.path, steps: [...mine.steps.filter((x) => x.i < t.from), ...t.steps] }
      }
      setState({ trace: t, steps: have.current.steps, error: '' })
    } catch (err) {
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : "Couldn't read the agent's record." }))
    }
  }, [task.id])

  const found = state.trace?.found ?? false
  useEffect(() => {
    load()
    // Once the agent is gone and its record read, nothing more will come.
    if (!live && found) return
    const id = window.setInterval(() => document.visibilityState === 'visible' && load(), 3000)
    return () => window.clearInterval(id)
  }, [load, live, found])
  return state
}

/** A short span: 4s, 12m, 1h 5m. */
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60 && m < 10 ? ` ${s % 60}s` : ''}`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Minutes and seconds into the task: 03:12, 1:04:09. */
function offset(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Total time covered by intervals that may overlap (parallel tool calls count once). */
function covered(spans: [number, number][]): number {
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  let total = 0
  let [from, to] = [-Infinity, -Infinity]
  for (const [a, b] of sorted) {
    if (a > to) {
      if (to > from) total += to - from
      ;[from, to] = [a, b]
    } else to = Math.max(to, b)
  }
  if (to > from && Number.isFinite(from)) total += to - from
  return total
}

type FileUse = { path: string; reads: number; edits: number; add: number; del: number }

function filesOf(steps: TraceStep[]): FileUse[] {
  const by = new Map<string, FileUse>()
  for (const s of steps) {
    for (const f of s.files ?? []) {
      if (!f.path) continue
      const u = by.get(f.path) ?? { path: f.path, reads: 0, edits: 0, add: 0, del: 0 }
      if (f.add === undefined) u.reads += 1
      else {
        u.edits += 1
        u.add += f.add ?? 0
        u.del += f.del ?? 0
      }
      by.set(f.path, u)
    }
  }
  return [...by.values()].sort((a, b) => b.edits - a.edits || b.add + b.del - (a.add + a.del) || b.reads - a.reads)
}

export function TraceView({ task, waits }: { task: Task; waits: Wait[] }) {
  const { trace, steps: all, error } = useTrace(task)
  const [file, setFile] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!task.live) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [task.live])

  const first = trace?.found ? trace.first : 0
  const steps = useMemo(() => all.filter((s) => s.i >= first), [all, first])
  const files = useMemo(() => filesOf(steps), [steps])

  if (!trace) return <p className="sheet__empty">{error || 'Reading the agent’s record…'}</p>
  if (!trace.found)
    return (
      <p className="sheet__empty">
        {error || trace.reason} {task.live && !error ? 'This page fills in as soon as it does.' : ''}
      </p>
    )
  if (!steps.length) return <p className="sheet__empty">The agent hasn’t done anything on this task yet.</p>

  // From the recording to the step: open it (and the run of steps it is folded into), then bring it into view.
  const show = (i: number) => {
    setFile(null)
    window.requestAnimationFrame(() => {
      const row = document.getElementById(`step-${i}`)
      if (!row) return
      for (let d = row.closest('details') ?? row.querySelector('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true
      row.querySelector('details')?.setAttribute('open', '')
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      row.querySelector('summary')?.focus({ preventScroll: true })
    })
  }

  return (
    <>
      {error && <p className="notice signal-text">{error}</p>}
      <Recording steps={steps} waits={waits} live={task.live} now={now} onPick={show} />
      {files.length > 0 && <Files files={files} chosen={file} choose={(p) => setFile(p === file ? null : p)} />}
      <Steps steps={steps} start={steps[0].t} file={file} clear={() => setFile(null)} live={task.live} />
    </>
  )
}

function Recording({ steps, waits, live, now, onPick }: { steps: TraceStep[]; waits: Wait[]; live: boolean; now: number; onPick: (i: number) => void }) {
  const from = steps[0].t
  const last = Math.max(...steps.map((s) => s.end ?? s.t))
  const to = Math.max(live ? now : last, from + 1000)
  const total = to - from
  const x = (t: number) => `${(((Math.min(Math.max(t, from), to) - from) / total) * 100).toFixed(3)}%`
  const w = (a: number, b: number) => `${(((Math.min(b, to) - Math.max(a, from)) / total) * 100).toFixed(3)}%`
  const endOf = (s: TraceStep) => s.end ?? (live ? now : s.t)

  const marks = new Map<Lane, TraceStep[]>(LANES.map((l) => [l.id, []]))
  for (const s of steps) marks.get(LANE_OF[s.kind])!.push(s)
  const within = waits.filter((v) => v.to > from && v.from < to)
  const time = new Map<Lane, number>()
  for (const l of LANES) {
    const spans: [number, number][] = marks.get(l.id)!.map((s) => [s.t, endOf(s)])
    if (l.id === 'you') spans.push(...within.map((v): [number, number] => [v.from, v.to]))
    time.set(l.id, covered(spans))
  }
  const ticks = Math.max(2, Math.min(6, Math.floor(total / 60000) + 1))

  // A click on a channel opens the step under the pointer, or the nearest one on that channel.
  const pick = (lane: Lane) => (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const at = from + ((e.clientX - box.left) / box.width) * total
    const near = marks.get(lane)!.reduce<{ s: TraceStep; d: number } | null>((best, s) => {
      const d = at < s.t ? s.t - at : at > endOf(s) ? at - endOf(s) : 0
      return !best || d < best.d ? { s, d } : best
    }, null)
    if (near) onPick(near.s.i)
  }

  return (
    <section className="sheet__section">
      <h3>
        Recording · {span(total)} · {steps.length} steps
      </h3>
      <div
        className="rec"
        role="img"
        aria-label={LANES.map((l) => `${l.label} ${span(time.get(l.id) ?? 0)}`).join(', ')}
        style={{ ['--ticks' as string]: ticks }}
      >
        {LANES.map((l) => (
          <div className={`rec__lane rec__lane--${l.id}`} key={l.id}>
            <span className="rec__name">{l.label}</span>
            <div className="rec__track" onClick={pick(l.id)}>
              {l.id === 'you' &&
                within.map((v, i) => (
                  <span
                    key={`w${i}`}
                    className={`rec__mark rec__mark--wait${v.now ? ' rec__mark--now' : ''}`}
                    style={{ left: x(v.from), width: w(v.from, v.to) }}
                    title={`Waiting on you · ${span(v.to - v.from)}`}
                  />
                ))}
              {marks.get(l.id)!.map((s) => (
                <span
                  key={s.i}
                  className={`rec__mark${s.ok === false ? ' rec__mark--failed' : ''}${s.end === null ? ' rec__mark--open' : ''}`}
                  style={{ left: x(s.t), width: w(s.t, endOf(s)) }}
                  title={`${offset(s.t - from)} · ${s.title}${s.end !== null && s.end > s.t ? ` · ${span(s.end - s.t)}` : ''}`}
                />
              ))}
            </div>
            <span className="rec__time">{span(time.get(l.id) ?? 0)}</span>
          </div>
        ))}
        <div className="rec__axis" aria-hidden="true">
          <span>{clock(from)}</span>
          <span>{live ? 'now' : clock(to)}</span>
        </div>
      </div>
    </section>
  )
}

function Files({ files, chosen, choose }: { files: FileUse[]; chosen: string | null; choose: (p: string) => void }) {
  const [all, setAll] = useState(false)
  const most = Math.max(...files.map((f) => f.reads + f.edits))
  const shown = all ? files : files.slice(0, 8)
  return (
    <section className="sheet__section">
      <h3>Files touched · {files.length}</h3>
      <Secret label="Files">
        <ul className="rfiles">
          {shown.map((f) => (
            <li key={f.path}>
              <button type="button" className="rfiles__row" aria-pressed={chosen === f.path} onClick={() => choose(f.path)} title="Show only the steps on this file">
                <span className="rfiles__path">{f.path}</span>
                <span className="rfiles__heat" aria-hidden="true">
                  <span className="rfiles__edits" style={{ width: `${(f.edits / most) * 100}%` }} />
                  <span className="rfiles__reads" style={{ width: `${(f.reads / most) * 100}%` }} />
                </span>
                <span className="rfiles__counts">
                  {[f.reads && `${f.reads} read${f.reads > 1 ? 's' : ''}`, f.edits && `${f.edits} edit${f.edits > 1 ? 's' : ''}`].filter(Boolean).join(' · ')}
                  {f.edits > 0 && (
                    <>
                      {' '}
                      <span className="diff-add">+{f.add}</span> <span className="diff-del">−{f.del}</span>
                    </>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {files.length > 8 && (
          <button type="button" className="btn btn--quiet" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${files.length}`}
          </button>
        )}
      </Secret>
    </section>
  )
}

/** Looking around (reading and searching) comes in runs; three or more in a row fold into one line. */
type Row = { kind: 'step'; step: TraceStep } | { kind: 'run'; steps: TraceStep[] }

function rows(steps: TraceStep[]): Row[] {
  const out: Row[] = []
  let run: TraceStep[] = []
  const flush = () => {
    if (run.length >= 3) out.push({ kind: 'run', steps: run })
    else out.push(...run.map((step): Row => ({ kind: 'step', step })))
    run = []
  }
  for (const s of steps) {
    if (LANE_OF[s.kind] === 'read' && s.ok !== false) run.push(s)
    else {
      flush()
      out.push({ kind: 'step', step: s })
    }
  }
  flush()
  return out
}

function runTitle(steps: TraceStep[]): string {
  const reads = steps.filter((s) => s.kind === 'read').length
  const searches = steps.length - reads
  return [reads && `Read ${reads} time${reads > 1 ? 's' : ''}`, searches && `searched ${searches} time${searches > 1 ? 's' : ''}`]
    .filter(Boolean)
    .join(', ')
    .replace(/^s/, 'S')
}

function Steps({ steps, start, file, clear, live }: {
  steps: TraceStep[]
  start: number
  file: string | null
  clear: () => void
  live: boolean
}) {
  const shown = file ? steps.filter((s) => s.files?.some((f) => f.path === file)) : steps
  const list = file ? shown.map((step): Row => ({ kind: 'step', step })) : rows(shown)
  const failed = steps.filter((s) => s.ok === false).length
  return (
    <section className="sheet__section">
      <h3>
        Every step · {steps.length}
        {failed > 0 && ` · ${failed} failed`}
      </h3>
      {file && (
        <p className="rsteps__filter">
          Only the steps on <span className="mono">{file}</span>.{' '}
          <button type="button" className="btn btn--quiet" onClick={clear}>
            Show every step
          </button>
        </p>
      )}
      <ol className="rsteps">
        {list.map((r) =>
          r.kind === 'step' ? (
            <StepRow key={r.step.i} s={r.step} start={start} />
          ) : (
            <li key={`run${r.steps[0].i}`} className="rsteps__run">
              <details>
                <summary className="rstep__line">
                  <time className="rstep__at">{offset(r.steps[0].t - start)}</time>
                  <span className="rstep__key rstep__key--read" aria-hidden="true" />
                  <span className="rstep__title">{runTitle(r.steps)}</span>
                  <span className="rstep__took">{span((r.steps[r.steps.length - 1].end ?? r.steps[r.steps.length - 1].t) - r.steps[0].t)}</span>
                </summary>
                <ol className="rsteps rsteps--inner">
                  {r.steps.map((s) => (
                    <StepRow key={s.i} s={s} start={start} />
                  ))}
                </ol>
              </details>
            </li>
          ),
        )}
      </ol>
      {live && <p className="rsteps__live">Still recording: new steps appear here as the agent takes them.</p>}
    </section>
  )
}

const KIND_LABEL: Record<TraceKind, string> = {
  think: 'thought', say: 'said', read: 'read', search: 'searched', edit: 'edited', run: 'ran', agent: 'sub-agent', tool: 'tool', you: 'you', ask: 'asked you',
}

function StepRow({ s, start }: { s: TraceStep; start: number }) {
  const took = s.end === null ? 'running' : s.end - s.t >= 1000 ? span(s.end - s.t) : ''
  const lane = LANE_OF[s.kind]
  const changed = s.files?.filter((f) => f.add !== undefined) ?? []
  const line = (
    <>
      <time className="rstep__at">{offset(s.t - start)}</time>
      <span className={`rstep__key rstep__key--${lane}`} role="img" aria-label={KIND_LABEL[s.kind]} />
      <span className="rstep__title">
        {s.title}
        {s.sub && <span className="rstep__sub">{s.sub}</span>}
      </span>
      <span className="rstep__took">
        {s.ok === false && <span className="rstep__failed">failed</span>}
        {changed.length > 0 && (
          <span className="rstep__diff">
            <span className="diff-add">+{changed.reduce((n, f) => n + (f.add ?? 0), 0)}</span>{' '}
            <span className="diff-del">−{changed.reduce((n, f) => n + (f.del ?? 0), 0)}</span>
          </span>
        )}
        {took}
      </span>
    </>
  )
  const cls = `rstep rstep--${s.kind}`
  if (!s.detail || (s.detail === s.title && s.kind !== 'you'))
    return (
      <li className={cls} id={`step-${s.i}`}>
        <div className="rstep__line">{line}</div>
      </li>
    )
  const prose = s.kind === 'you' || s.kind === 'say'
  return (
    <li className={cls} id={`step-${s.i}`}>
      <details>
        <summary className="rstep__line">{line}</summary>
        <Secret label="Step">{prose ? <p className="rstep__prose">{s.detail}</p> : <Detail s={s} />}</Secret>
      </details>
    </li>
  )
}

function Detail({ s }: { s: TraceStep }) {
  if (s.kind === 'edit' || (s.files?.some((f) => f.add !== undefined) && s.detail.includes('\n@@'))) {
    return (
      <pre className="logs rstep__diff-body">
        {s.detail.split('\n').map((l, i) => (
          <span key={i} className={l.startsWith('@@') ? 'diff-hunk' : l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-del' : undefined}>
            {l}
            {'\n'}
          </span>
        ))}
      </pre>
    )
  }
  return <pre className="logs">{s.detail}</pre>
}
