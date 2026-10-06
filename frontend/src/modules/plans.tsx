import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ConfirmButton } from '../components/ConfirmButton'
import { Icon } from '../components/Icon'
import { UsageLine } from '../components/UsageLine'
import { agentKey, parseAgentRef, sourceLabel } from '../lib/agents'
import { api } from '../lib/api'
import { ago } from '../lib/format'
import { useHub } from '../lib/hub'
import { go } from '../lib/route'
import type { Agents, Plan, Runner, Task, TaskState } from '../lib/types'
import { usePoll } from '../lib/usePoll'
import { folderIn, startPlaces } from '../lib/work'
import './plans.css'

/* A plan's steps are tasks in rows: a row starts once every step of the row above is finished, and the steps of a row
   run at once, each on its own agent (in its own git worktree). A step under another continues with its agent.
   core/plans.py runs it; this page lays it out and shows the record. */

// ---------------------------------------------------------------- where the plans' pages are

/** A plan's pages live under Tasks, and in the plans modal on the Agents page (planModal.tsx), which moves between
    them without leaving the page: it provides this. */
export type PlanPlace = { plan: number } | 'new' | 'list'
export const PlanNav = createContext<((to: PlanPlace) => void) | null>(null)

const hrefOf = (to: PlanPlace) => (to === 'new' ? '#/m/tasks/plan/new' : to === 'list' ? '#/m/tasks/plans' : `#/m/tasks/plan/${to.plan}`)

function useNav(): (to: PlanPlace) => void {
  const nav = useContext(PlanNav)
  return nav ?? ((to) => go(hrefOf(to)))
}

function PlanLink({ to, className, children }: { to: PlanPlace; className?: string; children: ReactNode }) {
  const nav = useContext(PlanNav)
  return (
    <a
      className={className}
      href={hrefOf(to)}
      onClick={
        nav
          ? (e) => {
              e.preventDefault()
              nav(to)
            }
          : undefined
      }
    >
      {children}
    </a>
  )
}

/** Under Tasks; the plans modal has its own, in its header. */
function Back() {
  if (useContext(PlanNav)) return null
  return (
    <PlanLink to="list" className="side__back">
      <Icon name="back" size={18} /> All plans
    </PlanLink>
  )
}

/** The owner's go for a step that waits for it: it starts as soon as its agent is free. */
export function GoButton({ step, title, onDone, className = 'btn' }: { step: number; title: string; onDone?: () => void; className?: string }) {
  const { refreshTasks, refreshAgents, refreshPlans } = useHub()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const give = async () => {
    setBusy(true)
    setError('')
    try {
      await api(`tasks/${step}/go`, { method: 'POST' })
      refreshTasks()
      refreshAgents()
      refreshPlans()
      onDone?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start it.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button className={className} type="button" onClick={give} disabled={busy} title={`Let “${title}” start`}>
        <Icon name="play" size={14} /> Go
      </button>
      {error && <span className="signal-text">{error}</span>}
    </>
  )
}

// ---------------------------------------------------------------- steps

const NOT_STARTED: TaskState[] = ['todo', 'queued']
const FINISHED: TaskState[] = ['review', 'done']
const movable = (t: Task) => NOT_STARTED.includes(t.state)

/** The steps, row by row (the API sends them in order). */
function layoutOf(plan: Plan): Task[][] {
  const rows: Task[][] = []
  let last = -1
  for (const t of plan.steps) {
    if (t.plan_row !== last) rows.push([])
    last = t.plan_row
    rows[rows.length - 1].push(t)
  }
  return rows
}

const ids = (rows: Task[][]) => rows.map((r) => r.map((t) => t.id)).filter((r) => r.length)

type PlanState = 'draft' | 'scheduled' | 'running' | 'paused' | 'finished'

function planState(plan: Plan): PlanState {
  if (plan.steps.length && plan.steps.every((t) => FINISHED.includes(t.state))) return 'finished'
  if (plan.running) return 'running'
  if (plan.start_at) return 'scheduled'
  return plan.steps.some((t) => !NOT_STARTED.includes(t.state)) ? 'paused' : 'draft'
}

const STATE_WORDS: Record<PlanState, string> = { draft: 'Draft', scheduled: 'Scheduled', running: 'Running', paused: 'Paused', finished: 'Finished' }

/** A start time, as the owner reads it: "Mon 6 Oct, 09:00". */
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** An ISO time as the value of a datetime-local input, in local time. */
function localInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

/** When the plan starts by itself: a date and time, kept on leaving the field (not on every keystroke); emptied, it
    starts only by hand. */
function StartAt({ plan, disabled, patch }: { plan: Plan; disabled: boolean; patch: (json: object) => void }) {
  const saved = localInput(plan.start_at)
  const [draft, setDraft] = useState(saved)
  useEffect(() => setDraft(saved), [saved])
  const commit = () => {
    if (draft === saved) return
    patch({ start_at: draft ? new Date(draft).toISOString() : null })
  }
  return (
    <label title="It starts by itself then, as if you pressed Start">
      starts{' '}
      <input
        className="plan__inline"
        type="datetime-local"
        value={draft}
        min={localInput(new Date().toISOString())}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        aria-label="Start time"
      />
      {!plan.start_at && !draft && <span className="plan__hint"> by hand</span>}
      {plan.start_at && (
        <button className="btn btn--quiet plan__clear" type="button" disabled={disabled} onClick={() => patch({ start_at: null })} title="Start it only by hand">
          Clear
        </button>
      )}
    </label>
  )
}

/** The plan's check: a command run in a step's folder once its agent finishes (the tests, say); the rows under it
    wait for it to pass. Kept on leaving the field. */
function CheckCommand({ plan, disabled, patch }: { plan: Plan; disabled: boolean; patch: (json: object) => void }) {
  const [draft, setDraft] = useState(plan.check_command)
  useEffect(() => setDraft(plan.check_command), [plan.check_command])
  const commit = () => draft.trim() !== plan.check_command && patch({ check_command: draft.trim() })
  return (
    <label title="Run in a step's folder once its agent finishes. The steps under it start only once it passes; a failure goes back to the agent to fix.">
      check{' '}
      <input
        className="plan__inline plan__check"
        value={draft}
        placeholder="none (make test, say)"
        maxLength={500}
        spellCheck={false}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        aria-label="Check command"
      />
      {plan.check_command && (
        <>
          {' '}fixes{' '}
          <select className="plan__inline" value={plan.check_fixes} disabled={disabled} onChange={(e) => patch({ check_fixes: Number(e.target.value) })}
            aria-label="How many times a failed check goes back to the agent">
            {[0, 1, 2, 3, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </>
      )}
    </label>
  )
}

/** A step's check, in a few words, once its agent finished. */
const CHECK_WORDS: Record<string, string> = { running: 'checking', passed: 'check passed', failed: 'check failed', fixing: 'fixing the check' }

/** The state of a step, as a mark: the class of its cell in the strips and lanes. */
function mark(t: Task, asking: number[] = []): string {
  if (t.state === 'blocked' || t.state === 'failed' || asking.includes(t.id)) return 'fault'
  if (t.state === 'working' || t.state === 'starting') return 'on'
  if (FINISHED.includes(t.state)) return 'done'
  return t.state === 'queued' ? 'queued' : 'todo'
}

const STEP_WORDS: Record<TaskState, string> = {
  todo: 'not started',
  queued: 'queued',
  starting: 'handing it over',
  working: 'working',
  blocked: 'needs you',
  review: 'to review',
  done: 'done',
  failed: 'failed',
}

// ---------------------------------------------------------------- on the Tasks page

/** Every plan, each with its steps drawn as a small strip of rows, so its shape and progress read at a glance. */
export function PlansList() {
  const res = usePoll<Plan[]>('plans', 4000)
  const plans = res.data ?? []
  return (
    <section className="plans" aria-labelledby="plans-title">
      <header className="plans__head">
        <h3 id="plans-title" className="plans__title">
          Plans
        </h3>
        <PlanLink className="btn btn--quiet" to="new">
          <Icon name="plus" size={16} /> New plan
        </PlanLink>
      </header>
      {res.error && !res.data ? (
        <p className="notice signal-text">Couldn't read the plans: {res.error.message}</p>
      ) : !res.data ? null : plans.length ? (
        <ul className="plans__list">
          {plans.map((p) => {
            const state = planState(p)
            const done = p.steps.filter((t) => FINISHED.includes(t.state)).length
            const waiting = p.asking.length > 0 || p.steps.some((t) => t.state === 'blocked' || t.state === 'failed')
            return (
              <li key={p.id}>
                <PlanLink className={`plans__item${state === 'scheduled' ? ' is-scheduled' : ''}${waiting ? ' is-fault' : ''}`} to={{ plan: p.id }}>
                  <span className="plans__name">{p.title}</span>
                  {state === 'scheduled' && <Icon name="clock" size={18} className="plans__scheduled-icon" />}
                  <span className="plans__meta">
                    {p.project_name || 'No project'} · {state === 'scheduled' && p.start_at ? `starts ${when(p.start_at)}` : STATE_WORDS[state].toLowerCase()} · {done} of {p.steps.length} done
                    {p.asking.length ? <span className="signal-text"> · {p.asking.length} waiting for your go</span> : null}
                  </span>
                  <Strip plan={p} />
                </PlanLink>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="plans__empty">
          Lay out steps for agents to take over on their own: one after the other, or side by side at the same time. Each starts as soon as the steps above it are finished.
        </p>
      )}
    </section>
  )
}

/** A plan's shape in miniature: one column per row, one cell per step, in its state. */
function Strip({ plan }: { plan: Plan }) {
  return (
    <span className="pstrip" aria-hidden="true">
      {layoutOf(plan).map((row, i) => (
        <span className="pstrip__row" key={i}>
          {row.map((t) => (
            <span key={t.id} className={`pstrip__cell pstrip__cell--${mark(t, plan.asking)}`} />
          ))}
        </span>
      ))}
    </span>
  )
}

// ---------------------------------------------------------------- a new plan

export function NewPlan() {
  const { projects, agents } = useHub()
  const nav = useNav()
  const [title, setTitle] = useState('')
  const [project, setProject] = useState<number | null>(null)
  const [error, setError] = useState('')
  const code = (projects ?? []).filter((p) => p.kind === 'project').sort((a, b) => a.name.localeCompare(b.name))
  const chosen = code.find((p) => p.id === project)
  const places = startPlaces(chosen, agents)
  const [kind, setKind] = useState('')
  const [place, setPlace] = useState<number | null>(null)

  const create = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      const made = await api<Plan>('plans', {
        method: 'POST',
        json: { title, project, kind: kind || agents?.kinds?.[0] || 'claude', source: place ?? places[0]?.id ?? 0 },
      })
      nav({ plan: made.id })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't make it.")
    }
  }

  return (
    <div className="sheet">
      <Back />
      <header className="sheet__head mod-tasks">
        <h2 className="sheet__title">New plan</h2>
      </header>
      <p className="sheet__lede">
        A plan is steps for agents to take over on their own. Steps one under another run in order, and a step continues with the agent of the step above it, so it keeps what that
        agent learned. Steps side by side run at the same time, each on its own agent, in its own git worktree.
      </p>
      <form className="pform" onSubmit={create}>
        <label className="field">
          Name
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Dark mode everywhere, the v2 API…" required maxLength={200} autoFocus />
        </label>
        <label className="field">
          Project
          <select value={project ?? ''} onChange={(e) => setProject(e.target.value ? Number(e.target.value) : null)}>
            <option value="">No project</option>
            {code.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          New agents
          <select value={kind || agents?.kinds?.[0] || 'claude'} onChange={(e) => setKind(e.target.value)}>
            {(agents?.kinds ?? ['claude']).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        {places.length > 1 && (
          <label className="field">
            Where
            <select value={place ?? places[0]?.id ?? 0} onChange={(e) => setPlace(Number(e.target.value))}>
              {places.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="notice signal-text">{error}</p>}
        <div className="sheet__actions" style={{ justifyContent: 'start' }}>
          <button className="btn" type="submit" disabled={!title.trim()}>
            Make the plan
          </button>
        </div>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------- a plan

export function PlanPage({ id }: { id: string }) {
  const res = usePoll<Plan>(`plans/${encodeURIComponent(id)}`, 3000)
  const back = <Back />
  if (res.error && !res.data)
    return (
      <div className="sheet">
        {back}
        <div className="sheet__empty">{res.error.message.includes('Not found') ? 'No such plan. It may have been deleted.' : res.error.message}</div>
      </div>
    )
  if (!res.data) return <div className="sheet__empty">Loading…</div>
  return <PlanView plan={res.data} refresh={res.refresh} back={back} />
}

function PlanView({ plan, refresh, back }: { plan: Plan; refresh: () => void; back: ReactNode }) {
  const { agents, tasks, projects, refreshTasks, refreshAgents } = useHub()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const rows = layoutOf(plan)
  const state = planState(plan)
  const project = (projects ?? []).find((p) => p.id === plan.project)
  const places = startPlaces(project, agents)
  const place = (agents?.sources ?? []).find((s) => s.id === plan.source)
  const control = (agents?.terminal ?? 'control') === 'control'
  const needsYou = plan.steps.filter((t) => t.state === 'blocked' || t.state === 'failed')
  const asking = plan.steps.filter((t) => plan.asking.includes(t.id))
  const nav = useNav()

  const run = async (work: () => Promise<unknown>, failed: string) => {
    setBusy(true)
    setError('')
    try {
      await work()
      refresh()
      refreshTasks()
      refreshAgents()
    } catch (err) {
      setError(err instanceof Error ? err.message : failed)
    } finally {
      setBusy(false)
    }
  }
  const arrange = (next: Task[][]) => run(() => api(`plans/${plan.id}/arrange`, { method: 'POST', json: { rows: ids(next) } }), "Couldn't move it.")
  const patch = (json: object) => run(() => api(`plans/${plan.id}`, { method: 'PATCH', json }), "Couldn't change it.")
  const archive = () =>
    run(async () => {
      await api(`plans/${plan.id}/archive`, { method: 'POST' })
      nav('list')
    }, "Couldn't archive it.")
  const remove = async () => {
    try {
      await api(`plans/${plan.id}`, { method: 'DELETE' })
      refreshTasks()
      nav('list')
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete it.")
    }
  }

  // To do that isn't in a plan: what can be pulled in, this project's first.
  const ideas = (tasks ?? [])
    .filter((t) => t.state === 'todo' && t.plan == null)
    .sort((a, b) => Number(b.project === plan.project) - Number(a.project === plan.project))

  return (
    <div className="sheet plan">
      {back}
      <header className="sheet__head mod-tasks task__head">
        <div className="task__heading">
          <span className={`sheet__index${needsYou.length || asking.length ? ' sheet__index--fault' : ''}`}>{STATE_WORDS[state].toUpperCase()}</span>
          <div className="task__titleline">
            <h2 className="sheet__title task__title" title={plan.title}>
              {plan.title}
            </h2>
            <div className="sheet__actions task__bar">
              {state !== 'finished' &&
                (plan.running ? (
                  <button className="btn" type="button" disabled={busy} onClick={() => run(() => api(`plans/${plan.id}/pause`, { method: 'POST' }), "Couldn't pause it.")}>
                    Pause
                  </button>
                ) : (
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || !plan.steps.length || !control}
                    title={control ? undefined : 'Giving tasks to agents is turned off here (MARUMADO_HERDR_TERMINAL)'}
                    onClick={() => run(() => api(`plans/${plan.id}/start`, { method: 'POST' }), "Couldn't start it.")}
                  >
                    <Icon name="agent" size={16} /> {state === 'paused' ? 'Resume' : 'Start'}
                  </button>
                ))}
              {state === 'finished' && !plan.archived_at && (
                <button className="btn" type="button" disabled={busy} onClick={archive} title="Out of the plans list and off the board, its steps with it; kept under Archived">
                  <Icon name="archive" size={16} /> Archive
                </button>
              )}
              <ConfirmButton onConfirm={remove} confirmLabel="Delete: steps go back to To do" disabled={busy}>
                <Icon name="trash" size={16} /> Delete
              </ConfirmButton>
            </div>
          </div>
        </div>
      </header>

      <p className="plan__setup">
        <span>{plan.project_name || 'No project'}</span>
        <span className="plan__sep" aria-hidden="true">·</span>
        <label>
          new agents are{' '}
          <select className="plan__inline" value={plan.kind} onChange={(e) => patch({ kind: e.target.value })} disabled={busy}>
            {(agents?.kinds ?? [plan.kind]).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        {places.length > 1 ? (
          <label>
            on{' '}
            <select className="plan__inline" value={plan.source} onChange={(e) => patch({ source: Number(e.target.value) })} disabled={busy}>
              {places.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {project && !folderIn(project, s) ? ' (no folder there)' : ''}
                </option>
              ))}
            </select>
          </label>
        ) : (
          place && <span>on {place.name}</span>
        )}
        {!plan.running && state !== 'finished' && !plan.archived_at && (
          <>
            <span className="plan__sep" aria-hidden="true">·</span>
            <StartAt plan={plan} disabled={busy || !control} patch={patch} />
          </>
        )}
        {!plan.archived_at && (
          <>
            <span className="plan__sep" aria-hidden="true">·</span>
            <CheckCommand plan={plan} disabled={busy} patch={patch} />
          </>
        )}
      </p>
      {plan.usage && plan.usage.calls > 0 && <UsageLine usage={plan.usage} context={false} className="plan__usage" />}

      {plan.archived_at && (
        <p className="notice">
          Archived {ago(plan.archived_at)}, its steps with it: out of the plans list and off the board.{' '}
          <button className="btn btn--quiet" type="button" disabled={busy} onClick={() => run(() => api(`plans/${plan.id}/restore`, { method: 'POST' }), "Couldn't restore it.")}>
            Restore
          </button>
        </p>
      )}
      {needsYou.map((t) => (
        <p className="notice notice--fault" key={t.id}>
          <strong>{t.state === 'failed' ? `“${t.title}” failed.` : `“${t.title}” is waiting on you.`}</strong>{' '}
          {t.state === 'failed'
            ? t.check_state === 'failed'
              ? 'Its check still fails: the steps under it wait until you run the check again (from the step), move it back to To do or mark it done.'
              : 'The steps under it wait until you move it back to To do (it runs again) or mark it done.'
            : 'Its row carries on once you answer.'}{' '}
          <a href={`#/m/tasks/${t.id}`}>Open the step</a>.
        </p>
      ))}
      {asking.map((t) => (
        <p className="notice notice--fault plan__asking" key={t.id}>
          <span>
            <strong>“{t.title}” waits for your go.</strong> Its turn has come: check the steps above it, then let it start.
          </span>
          <GoButton step={t.id} title={t.title} onDone={refresh} />
        </p>
      ))}
      {state === 'scheduled' && plan.start_at && (
        <p className="notice">
          Starts by itself {when(plan.start_at)}
          {plan.steps.length ? '' : ', once it has a step'}. Press Start to run it now.
        </p>
      )}
      {error && <p className="notice signal-text">{error}</p>}

      {plan.steps.length > 0 && <Lanes rows={rows} agents={agents} asking={plan.asking} />}

      <Builder plan={plan} rows={rows} busy={busy} arrange={arrange} run={run} ideas={ideas} agents={agents} />
    </div>
  )
}

// ---------------------------------------------------------------- the record: one lane per agent

type LaneStep = { t: Task; lane: number }

/** Which lane each step runs in: the lane of the step it continues, or a lane of its own, the way core/plans.py
    picks its agent. */
function lanesOf(rows: Task[][]): { steps: LaneStep[]; count: number } {
  const steps: LaneStep[] = []
  const laneOf = new Map<number, number>()
  let count = 0
  rows.forEach((row, r) => {
    row.forEach((t, c) => {
      const above = r > 0 && c < rows[r - 1].length && t.runner === '' ? rows[r - 1][c] : null
      const lane = above ? laneOf.get(above.id)! : count++
      laneOf.set(t.id, lane)
      steps.push({ t, lane })
    })
  })
  return { steps, count }
}

const at = (iso: string | null) => (iso ? Date.parse(iso) : NaN)

function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} h ${m % 60 ? `${m % 60} min` : ''}`.trim() : `${Math.floor(h / 24)} d ${h % 24} h`
}

/** The plan as a chart record: time runs left to right up to "now"; each lane is an agent; what it did is inked in
    the Tasks pen, what is still to come waits past "now", dashed, in the order it will run. */
function Lanes({ rows, agents, asking }: { rows: Task[][]; agents?: Agents; asking: number[] }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15000)
    return () => window.clearInterval(t)
  }, [])
  const { steps, count } = lanesOf(rows)
  const started = steps.filter(({ t }) => t.started_at)
  const t0 = started.length ? Math.min(...started.map(({ t }) => at(t.started_at))) : now
  const elapsed = Math.max(60_000, now - t0)
  // The past takes three quarters of the width once something has run; the queue the rest.
  const past = started.length ? 74 : 0
  const x = (ms: number) => (past * (ms - t0)) / elapsed
  const ahead = Array.from({ length: count }, () => [] as Task[])
  steps.forEach(({ t, lane }) => !t.started_at && ahead[lane].push(t))
  const slots = Math.max(1, ...ahead.map((a) => a.length))
  const slot = (100 - past - 2) / slots

  const who = (lane: number) => {
    const last = [...steps].reverse().find((s) => s.lane === lane && s.t.pane_id)
    if (!last) return 'new agent'
    const live = agents?.agents.find((a) => agentKey(a) === `${last.t.agent_source}/${last.t.pane_id}`)
    return last.t.agent_name || live?.name || last.t.agent_kind || 'agent'
  }

  return (
    <section className="lanes mod-tasks" aria-label="What each agent did, and what is queued">
      <div className="lanes__chart" role="list">
        {Array.from({ length: count }, (_, lane) => (
          <div className="lanes__lane" role="listitem" key={lane}>
            <span className="lanes__who">{who(lane)}</span>
            <div className="lanes__track">
              {steps
                .filter((s) => s.lane === lane && s.t.started_at)
                .map(({ t }) => {
                  const from = x(at(t.started_at))
                  const to = x(Number.isNaN(at(t.finished_at)) ? now : at(t.finished_at))
                  return (
                    <a
                      key={t.id}
                      className={`lanes__step lanes__step--${mark(t)}`}
                      href={`#/m/tasks/${t.id}`}
                      style={{ left: `${from}%`, width: `max(${Math.max(0.6, to - from)}%, 6px)` }}
                      title={`${t.title}: ${STEP_WORDS[t.state]}`}
                    >
                      <span>{t.title}</span>
                    </a>
                  )
                })}
              {ahead[lane].map((t, i) => (
                <a
                  key={t.id}
                  className={`lanes__step lanes__step--${mark(t, asking)}`}
                  href={`#/m/tasks/${t.id}`}
                  style={{ left: `${past + 2 + i * slot}%`, width: `calc(${slot}% - 4px)` }}
                  title={`${t.title}: ${asking.includes(t.id) ? 'waits for your go' : STEP_WORDS[t.state]}`}
                >
                  <span>{t.title}</span>
                </a>
              ))}
            </div>
          </div>
        ))}
        {past > 0 && <span className="lanes__now" style={{ left: `calc(var(--who) + (100% - var(--who)) * ${past / 100})` }} aria-hidden="true" />}
      </div>
      <p className="lanes__axis">
        {past > 0 ? (
          <>
            <span>−{span(elapsed)}</span>
            <span style={{ left: `calc(var(--who) + (100% - var(--who)) * ${past / 100})` }}>now</span>
            <span>queued</span>
          </>
        ) : (
          <span>nothing has run yet: steps in the order they will start</span>
        )}
      </p>
    </section>
  )
}

// ---------------------------------------------------------------- laying the steps out

type Drop = { kind: 'row' | 'gap'; index: number }
type Held = { id: number; x0: number; y0: number; active: boolean; over: Drop | null; dx: number; dy: number }

/** Moves a step: into a row (beside its steps), or into a gap between rows (a row of its own there). */
function moved(rows: Task[][], id: number, to: Drop): Task[][] {
  const step = rows.flat().find((t) => t.id === id)
  if (!step) return rows
  // The indexes are the rows as they were: an emptied row closes up only once the step is in its new place.
  const next = rows.map((r) => r.filter((t) => t.id !== id))
  if (to.kind === 'row') next[to.index] = [...next[to.index], step]
  else next.splice(to.index, 0, [step])
  return next.filter((r) => r.length)
}

function Builder({ plan, rows, busy, arrange, run, ideas, agents }: {
  plan: Plan
  rows: Task[][]
  busy: boolean
  arrange: (rows: Task[][]) => void
  run: (work: () => Promise<unknown>, failed: string) => Promise<void>
  ideas: Task[]
  agents?: Agents
}) {
  const [held, setHeld] = useState<Held | null>(null)
  const heldRef = useRef<Held | null>(null)
  const set = (h: Held | null) => {
    heldRef.current = h
    setHeld(h)
  }
  const [title, setTitle] = useState('')
  const [beside, setBeside] = useState<number | null>(null)
  const [besideTitle, setBesideTitle] = useState('')
  const [idea, setIdea] = useState('')
  const [ask, setAsk] = useState(false)
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  // Dragging a step that hasn't started: onto a row to run beside it, or between rows to run on its own there.
  useEffect(() => {
    if (!held) return
    const dropAt = (x: number, y: number): Drop | null => {
      const el = document.elementFromPoint(x, y)?.closest('[data-drop]') as HTMLElement | null
      if (!el) return null
      const [kind, index] = el.dataset.drop!.split(':')
      return { kind: kind as Drop['kind'], index: Number(index) }
    }
    const move = (e: PointerEvent) => {
      const h = heldRef.current
      if (!h) return
      const dx = e.clientX - h.x0
      const dy = e.clientY - h.y0
      if (!h.active && Math.hypot(dx, dy) < 6) return
      set({ ...h, active: true, dx, dy, over: dropAt(e.clientX, e.clientY) })
    }
    const up = () => {
      const h = heldRef.current
      set(null)
      if (h?.active && h.over) arrange(moved(rowsRef.current, h.id, h.over))
    }
    const cancel = () => set(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [held !== null]) // eslint-disable-line react-hooks/exhaustive-deps

  const grab = (e: ReactPointerEvent, t: Task) => {
    if (e.button !== 0 || !movable(t) || busy) return
    if ((e.target as Element).closest('button, select, a, input')) return
    set({ id: t.id, x0: e.clientX, y0: e.clientY, active: false, over: null, dx: 0, dy: 0 })
  }

  const add = (e: { preventDefault: () => void }, row?: number) => {
    e.preventDefault()
    const text = row == null ? title : besideTitle
    run(() => api(`plans/${plan.id}/add`, { method: 'POST', json: { prompt: text, row, ask: row == null && ask } }), "Couldn't add it.").then(() => {
      if (row == null) setTitle('')
      else {
        setBesideTitle('')
        setBeside(null)
      }
    })
  }
  const pull = (e: FormEvent) => {
    e.preventDefault()
    const t = ideas.find((x) => String(x.id) === idea)
    if (!t) return
    arrange([...rows, [t]])
    setIdea('')
  }

  const over = (d: Drop) => held?.active && held.over?.kind === d.kind && held.over.index === d.index
  const heldRow = held ? rows.findIndex((row) => row.some((t) => t.id === held.id)) : -1
  const gap = (index: number) => (
    <div className={`pgap${over({ kind: 'gap', index }) ? ' is-over' : ''}${held?.active ? ' is-open' : ''}${index === 0 ? ' pgap--top' : ''}`} data-drop={`gap:${index}`}>
      <span className="pgap__rail" aria-hidden="true">
        {index > 0 && <Icon name="chevron" size={14} />}
      </span>
      {held?.active && <span className="pgap__slot">Run on its own here</span>}
    </div>
  )

  return (
    <section className={`builder mod-tasks${held?.active ? ' is-dragging' : ''}`} aria-label="Steps">
      {rows.length === 0 && <p className="sheet__empty">No steps yet. Write the first one below, or pull one in from To do.</p>}
      {rows.map((row, r) => (
        <div className="builder__stage" key={row.map((t) => t.id).join('-')}>
          {gap(r)}
          <div className={`prow${over({ kind: 'row', index: r }) ? ' is-over' : ''}`} data-drop={`row:${r}`}>
            <span className="prow__rail" aria-hidden="true">
              <span className={`prow__node prow__node--${rowMark(row, plan.asking)}`}>{r + 1}</span>
              {row.length > 1 && <span className="prow__note">at once</span>}
            </span>
            <ul className="prow__steps" aria-label={row.length > 1 ? `Row ${r + 1}: ${row.length} steps at the same time` : `Row ${r + 1}`}>
              {row.map((t, c) => (
                <StepCard
                  key={t.id}
                  t={t}
                  above={r > 0 && c < rows[r - 1].length ? rows[r - 1][c] : null}
                  alone={row.length === 1}
                  first={r === 0}
                  last={r === rows.length - 1}
                  inRow={row.length}
                  agents={agents}
                  busy={busy}
                  asking={plan.asking.includes(t.id)}
                  held={held?.active && held.id === t.id ? held : null}
                  onGrab={grab}
                  move={(to) => arrange(moved(rows, t.id, to))}
                  rowIndex={r}
                  setRunner={(runner, want) =>
                    run(() => api(`tasks/${t.id}`, { method: 'PATCH', json: { runner, want_pane: want?.pane ?? '', want_source: want?.source ?? 0 } }), "Couldn't change it.")
                  }
                  remove={() => arrange(rows.map((x) => x.filter((y) => y.id !== t.id)))}
                  setAsk={(on) => run(() => api(`tasks/${t.id}`, { method: 'PATCH', json: { ask: on } }), "Couldn't change it.")}
                  gone={() => run(async () => undefined, '')}
                />
              ))}
              {over({ kind: 'row', index: r }) && heldRow !== r && (
                <li className="pstep pstep--ghost" aria-hidden="true">
                  Runs at the same time
                </li>
              )}
              <li className={`prow__add${beside === r ? ' is-open' : ''}`}>
                {beside === r ? (
                  <form onSubmit={(e) => add(e, r)} className="prow__form">
                    <textarea
                      value={besideTitle}
                      onChange={(e) => setBesideTitle(e.target.value)}
                      onKeyDown={(e) => {
                        // Enter adds it; Shift+Enter starts a new line of the prompt.
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          if (besideTitle.trim() && !busy) add(e, r)
                        } else if (e.key === 'Escape') {
                          e.preventDefault() // closes the form, not the plans modal around it
                          setBeside(null)
                        }
                      }}
                      placeholder="A step that runs at the same time, as you'd tell the agent…"
                      rows={3}
                      autoFocus
                      aria-label="New step beside these"
                    />
                    <span className="prow__formbar">
                      <button className="btn" type="submit" disabled={!besideTitle.trim() || busy}>
                        <Icon name="plus" size={16} /> Add
                      </button>
                      <button className="btn btn--quiet" type="button" onClick={() => setBeside(null)}>
                        Cancel
                      </button>
                    </span>
                  </form>
                ) : (
                  <button className="prow__beside" type="button" onClick={() => setBeside(r)} title="A step that runs at the same time, on its own agent, in its own worktree">
                    <Icon name="plus" size={18} />
                    <span>At the same time</span>
                  </button>
                )}
              </li>
            </ul>
          </div>
        </div>
      ))}
      {gap(rows.length)}
      <form className="builder__add" onSubmit={(e) => add(e)}>
        <span className="prow__rail" aria-hidden="true">
          <span className="prow__node prow__node--next">
            <Icon name="plus" size={14} />
          </span>
        </span>
        <label className="field">
          {rows.length ? 'Next step' : 'First step'}
          <textarea
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (title.trim() && !busy) add(e)
              }
            }}
            placeholder="Write the step as you'd tell the agent. Its first line names it; Shift+Enter for a new line."
            rows={3}
          />
        </label>
        <button className="btn" type="submit" disabled={!title.trim() || busy}>
          <Icon name="plus" size={16} /> Add
        </button>
        <label className="field field--check builder__ask">
          <input type="checkbox" checked={ask} onChange={(e) => setAsk(e.target.checked)} />
          Ask me before it starts
        </label>
      </form>
      {ideas.length > 0 && (
        <form className="builder__pull" onSubmit={pull}>
          <label className="field">
            Or take one from To do
            <select value={idea} onChange={(e) => setIdea(e.target.value)}>
              <option value="">Choose a task…</option>
              {ideas.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                  {t.project_name && t.project !== plan.project ? ` (${t.project_name})` : ''}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn--quiet" type="submit" disabled={!idea || busy}>
            Add as the next step
          </button>
        </form>
      )}
      <p className="builder__help">
        Drag a step by its handle onto a row to run it at the same time as that row, or between rows to run it on its own there; the arrows do the same a row at a time. A dotted line
        means a step continues with the agent of the step above it.
      </p>
    </section>
  )
}

/** A row's state, for its node on the rail. */
function rowMark(row: Task[], asking: number[]): string {
  const marks = row.map((t) => mark(t, asking))
  if (marks.includes('fault')) return 'fault'
  if (marks.includes('on')) return 'on'
  return marks.every((m) => m === 'done') ? 'done' : 'todo'
}

function StepCard({ t, above, alone, first, last, inRow, agents, busy, asking, held, onGrab, move, rowIndex, setRunner, remove, setAsk, gone }: {
  t: Task
  asking: boolean
  setAsk: (on: boolean) => void
  gone: () => void
  above: Task | null
  alone: boolean
  first: boolean
  last: boolean
  inRow: number
  agents?: Agents
  busy: boolean
  held: Held | null
  onGrab: (e: ReactPointerEvent, t: Task) => void
  move: (to: Drop) => void
  rowIndex: number
  setRunner: (runner: Runner, want?: { pane: string; source: number }) => void
  remove: () => void
}) {
  const open = (agents?.agents ?? []).filter((a) => a.kind !== 'terminal')
  const can = movable(t) && !busy
  const value = t.runner === 'agent' ? `agent:${t.want_source}/${t.want_pane}` : t.runner
  const runnerWords =
    t.runner === 'agent'
      ? (() => {
          const a = open.find((x) => agentKey(x) === `${t.want_source}/${t.want_pane}`)
          return a ? `on ${a.name || a.kind}` : 'on an agent that was closed'
        })()
      : t.runner === 'new' || !above
        ? `a new agent${inRow > 1 ? ', in its own worktree' : ''}`
        : `continues with ${above.agent_name || 'the agent of “' + above.title + '”'}`
  const sub = asking
    ? `waits for your go · ${runnerWords}`
    : movable(t)
      ? `${runnerWords}${t.ask && !t.go ? ' · asks you first' : ''}`
      : `${STEP_WORDS[t.state]}${CHECK_WORDS[t.check_state] ? ` · ${CHECK_WORDS[t.check_state]}` : ''}${t.landed ? ` · ${t.landed}` : ''}${t.agent_name ? ` · ${t.agent_name}` : ''}${t.worktree ? ` · ${t.worktree}` : ''}`
  const m = mark(t, asking ? [t.id] : [])

  // Continues the agent of the step above it: drawn as a dotted line up to that step.
  const continues = !!above && t.runner === ''

  return (
    <li
      className={`pstep pstep--${m}${held ? ' is-held' : ''}${can ? ' is-movable' : ''}${continues ? ' pstep--continues' : ''}`}
      style={held ? { transform: `translate(${held.dx}px, ${held.dy}px)` } : undefined}
      onPointerDown={(e) => onGrab(e, t)}
    >
      <span className="pstep__head">
        {can && (
          <span className="pstep__grip" title="Drag to move it" aria-hidden="true">
            <Icon name="grip" size={16} />
          </span>
        )}
        <a className="pstep__title" href={`#/m/tasks/${t.id}`} draggable={false}>
          <span className={`pstep__lamp pstep__lamp--${m}`} aria-hidden="true" />
          {t.title}
        </a>
        {can && (
          <span className="pstep__moves">
            <button className="pstep__tool" type="button" disabled={first && alone} onClick={() => move({ kind: 'gap', index: rowIndex - (alone ? 1 : 0) })} aria-label="Earlier: on its own, before this row" title="Earlier: on its own, before this row">
              <Icon name="up" size={16} />
            </button>
            <button className="pstep__tool" type="button" disabled={last && alone} onClick={() => move({ kind: 'gap', index: rowIndex + 1 + (alone ? 1 : 0) })} aria-label="Later: on its own, after this row" title="Later: on its own, after this row">
              <Icon name="down" size={16} />
            </button>
            {rowIndex > 0 && (
              <button className="pstep__tool" type="button" onClick={() => move({ kind: 'row', index: rowIndex - 1 })} aria-label="At the same time as the row above" title="At the same time as the row above">
                <Icon name="join" size={16} />
              </button>
            )}
            <button className="pstep__tool" type="button" onClick={remove} aria-label="Remove: back to To do" title="Remove: back to To do">
              <Icon name="close" size={16} />
            </button>
          </span>
        )}
      </span>
      <span className={`pstep__sub${m === 'fault' ? ' signal-text' : ''}`}>{sub}</span>
      {t.prompt.trim() && t.prompt.trim() !== t.title && (
        <details className="pstep__prompt">
          <summary>Prompt</summary>
          <p>{t.prompt.trim()}</p>
        </details>
      )}
      {asking && (
        <span className="pstep__go">
          <GoButton step={t.id} title={t.title} onDone={gone} className="btn pstep__gobtn" />
        </span>
      )}
      {can && (
        <select
          className="plan__inline pstep__who"
          value={value}
          aria-label={`Who takes “${t.title}”`}
          onChange={(e) => {
            const v = e.target.value
            if (v.startsWith('agent:')) {
              const ref = parseAgentRef(v.slice(6))
              if (ref) setRunner('agent', { pane: ref.pane, source: ref.source })
            } else setRunner(v as Runner)
          }}
        >
          <option value="">{above ? 'Continue with the agent above' : 'A new agent'}</option>
          <option value="new">A new agent</option>
          {open.map((a) => {
            const on = agents ? sourceLabel(agents, a) : ''
            return (
              <option key={agentKey(a)} value={`agent:${agentKey(a)}`}>
                {a.name || a.kind} · {a.kind}
                {on ? ` on ${on}` : ''}
              </option>
            )
          })}
        </select>
      )}
      {can && !t.go && (
        <label className="field field--check pstep__ask">
          <input type="checkbox" checked={t.ask} onChange={(e) => setAsk(e.target.checked)} disabled={busy} />
          Ask me before it starts
        </label>
      )}
    </li>
  )
}
