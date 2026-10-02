import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ConfirmButton } from '../components/ConfirmButton'
import { Icon } from '../components/Icon'
import { agentHref, agentKey, parseAgentRef, sourceLabel, sourcesOf } from '../lib/agents'
import { api } from '../lib/api'
import { ago } from '../lib/format'
import { useHub } from '../lib/hub'
import { go } from '../lib/route'
import { Secret } from '../lib/streaming'
import type { Project, Task, TaskDetail, TaskEvent, TaskState } from '../lib/types'
import { usePoll } from '../lib/usePoll'
import { SheetHead } from './sheetHead'

const STATE_LABEL: Record<TaskState, string> = {
  todo: 'TO DO',
  starting: 'STARTING',
  working: 'WORKING',
  blocked: 'NEEDS YOU',
  review: 'TO REVIEW',
  done: 'DONE',
  failed: 'FAILED',
}

const fault = (s: TaskState) => s === 'blocked' || s === 'failed'

function lamp(s: TaskState): string {
  if (fault(s)) return 'row__lamp row__lamp--fault'
  return s === 'working' || s === 'starting' ? 'row__lamp row__lamp--on' : 'row__lamp'
}

const agentLabel = (t: Task) => t.agent_name || t.agent_kind || 'the agent'

/** A short span: 45s, 12m, 2h 5m. */
function span(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const since = (iso: string | null) => (iso ? (Date.now() - Date.parse(iso)) / 1000 : 0)

function taskLine(t: Task): string {
  const where = t.project_name || 'No project'
  switch (t.state) {
    case 'todo':
      return `${where} · added ${ago(t.created_at)}`
    case 'starting':
      return `${where} · handing it to ${agentLabel(t)}`
    case 'working':
      return `${where} · ${agentLabel(t)}${t.agent_title ? `: ${t.agent_title}` : ''} · ${span(since(t.started_at))} in`
    case 'blocked':
      return `${where} · ${agentLabel(t)} is waiting on an approval or a question`
    case 'review':
      return `${where} · ${agentLabel(t)} finished ${ago(t.finished_at ?? t.updated_at)}, check its work`
    case 'done':
      return `${where} · done ${ago(t.finished_at ?? t.updated_at)}`
    case 'failed':
      return `${where} · failed, open it to see why`
  }
}

type Drag = { id: number; x0: number; y0: number; dx: number; dy: number; touch: boolean; active: boolean; over: string | null }

function TaskCard({ t, drag, onGrab, dragged }: { t: Task; drag: Drag | null; onGrab: (e: ReactPointerEvent, t: Task) => void; dragged: () => boolean }) {
  const moving = drag?.active && drag.id === t.id
  return (
    <li
      className={`kcard${fault(t.state) ? ' kcard--fault' : ''}${moving ? ' kcard--dragging' : ''}`}
      style={moving ? { transform: `translate(${drag.dx}px, ${drag.dy}px)` } : undefined}
      onPointerDown={(e) => onGrab(e, t)}
      onContextMenu={(e) => drag?.id === t.id && e.preventDefault()}
    >
      <a
        className="kcard__link"
        href={`#/m/tasks/${t.id}`}
        draggable={false}
        onClick={(e) => dragged() && e.preventDefault()}
      >
        <span className="kcard__head">
          <span className={lamp(t.state)} role="img" aria-label={STATE_LABEL[t.state].toLowerCase()} />
          <span className="kcard__title">{t.title}</span>
        </span>
        <span className={`kcard__sub${fault(t.state) ? ' signal-text' : ''}`}>{taskLine(t)}</span>
      </a>
    </li>
  )
}

type Column = { id: string; title: string; lede: string; states: TaskState[]; takes: boolean }

const COLUMNS: Column[] = [
  { id: 'todo', title: 'To do', lede: 'Waiting for an agent. Drop a task on Working to hand it over.', states: ['todo'], takes: true },
  { id: 'working', title: 'Working', lede: 'An agent is on it.', states: ['starting', 'working'], takes: true },
  { id: 'needs', title: 'Needs you', lede: 'Stopped on a question, or failed.', states: ['blocked', 'failed'], takes: false },
  { id: 'review', title: 'To review', lede: 'The agent finished its turn: check its work.', states: ['review'], takes: true },
  { id: 'done', title: 'Done', lede: '', states: ['done'], takes: true },
]

/** Hold still this long on a touch screen to pick a card up; moving sooner scrolls instead. */
const LONG_PRESS = 350

/** Cards move between columns by dragging: with a mouse once it moves a few pixels, on a touch screen after a long press. */
function useBoardDrag(onDrop: (id: number, column: string) => void) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const ref = useRef<Drag | null>(null)
  const justDropped = useRef(0)
  const timer = useRef(0)
  const dropped = useRef(onDrop)
  dropped.current = onDrop
  const set = (d: Drag | null) => {
    ref.current = d
    setDrag(d)
  }

  useEffect(() => {
    if (!drag) return
    const columnAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest('[data-column]') as HTMLElement | null)?.dataset.column ?? null
    const move = (e: PointerEvent) => {
      const d = ref.current
      if (!d) return
      const dx = e.clientX - d.x0
      const dy = e.clientY - d.y0
      if (!d.active) {
        if (Math.hypot(dx, dy) < 6) return
        if (d.touch) return set(null) // moved before the long press: a scroll, not a drag
        return set({ ...d, dx, dy, active: true, over: columnAt(e.clientX, e.clientY) })
      }
      set({ ...d, dx, dy, over: columnAt(e.clientX, e.clientY) })
    }
    const up = () => {
      const d = ref.current
      window.clearTimeout(timer.current)
      set(null)
      if (!d?.active) return
      justDropped.current = Date.now()
      if (d.over) dropped.current(d.id, d.over)
    }
    const cancel = () => {
      window.clearTimeout(timer.current)
      set(null)
    }
    // While a card is held on a touch screen, the finger moves it rather than scrolling the page.
    const holdStill = (e: TouchEvent) => ref.current?.active && e.preventDefault()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('touchmove', holdStill, { passive: false })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('touchmove', holdStill)
    }
  }, [drag !== null]) // eslint-disable-line react-hooks/exhaustive-deps

  const grab = (e: ReactPointerEvent, t: Task) => {
    if (e.button !== 0) return
    const touch = e.pointerType === 'touch'
    const d: Drag = { id: t.id, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, touch, active: false, over: null }
    set(d)
    if (touch)
      timer.current = window.setTimeout(() => {
        if (ref.current === d) {
          navigator.vibrate?.(10)
          set({ ...d, active: true })
        }
      }, LONG_PRESS)
  }
  // The click that ends a drag doesn't open the card.
  const dragged = () => Date.now() - justDropped.current < 300
  return { drag, grab, dragged }
}

function BoardColumn({ col, tasks, drag, grab, dragged, more }: {
  col: Column
  tasks: Task[]
  drag: Drag | null
  grab: (e: ReactPointerEvent, t: Task) => void
  dragged: () => boolean
  more?: ReactNode
}) {
  const over = drag?.active && drag.over === col.id
  return (
    <section className={`kcol${over ? (col.takes ? ' kcol--over' : ' kcol--refuse') : ''}`} aria-label={col.title} data-column={col.id}>
      <h3 className="kcol__head">
        {col.title} <span className="kcol__count">{tasks.length}</span>
      </h3>
      {tasks.length ? (
        <ul className="kcol__cards">
          {tasks.map((t) => (
            <TaskCard t={t} key={t.id} drag={drag} onGrab={grab} dragged={dragged} />
          ))}
        </ul>
      ) : (
        col.lede && <p className="kcol__empty">{col.lede}</p>
      )}
      {more}
    </section>
  )
}

/** Code projects, by name, for the project pickers. */
const codeProjects = (projects?: Project[]) => (projects ?? []).filter((p) => p.kind === 'project').sort((a, b) => a.name.localeCompare(b.name))

function ProjectSelect({ value, onChange, id }: { value: number | null; onChange: (v: number | null) => void; id?: string }) {
  const { projects } = useHub()
  return (
    <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">No project</option>
      {codeProjects(projects).map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  )
}

const DONE_SHOWN = 20

export function TasksSheet({ sub }: { sub?: string }) {
  const { tasks, refreshTasks } = useHub()
  const [title, setTitle] = useState('')
  const [project, setProject] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [allDone, setAllDone] = useState(false)

  const move = useRef<(id: number, column: string) => void>(() => undefined)
  const board = useBoardDrag((id, column) => move.current(id, column))

  if (sub) {
    const [id, view] = sub.split('/')
    return <TaskPage id={id} assign={view === 'assign'} />
  }
  if (!tasks) return <div className="sheet__empty">Loading tasks…</div>

  // Added to To do, to hand over whenever you like: the form stays here for the next one.
  const add = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await api<Task>('tasks', { method: 'POST', json: { title, project } })
      refreshTasks()
      setTitle('')
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add it.")
    }
  }
  /** What dropping a card on a column does. Only an agent puts a task under Needs you. */
  move.current = async (id, column) => {
    const t = tasks.find((x) => x.id === id)
    const from = COLUMNS.find((c) => c.states.includes(t?.state ?? 'todo'))
    if (!t || from?.id === column) return
    setError('')
    if (column === 'needs') return setError('Only an agent puts a task under Needs you, by stopping on a question.')
    if (column === 'working') {
      if (t.live) return setError(`${agentLabel(t)} still has “${t.title}”: carry on with it in Agents.`)
      return go(`#/m/tasks/${id}/assign`) // it needs an agent: choose one
    }
    try {
      await api(`tasks/${id}/${column === 'todo' ? 'reopen' : column}`, { method: 'POST' })
      refreshTasks()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't move it.")
    }
  }
  const of = (states: TaskState[]) => tasks.filter((t) => states.includes(t.state))
  const done = of(['done']).sort((a, b) => (b.finished_at ?? '').localeCompare(a.finished_at ?? ''))

  return (
    <div className="sheet">
      <SheetHead id="tasks" />
      <p className="sheet__lede">Write down what needs doing, hand it to a coding agent in Herdr now or later, and see what it did: when it worked, when it waited on you, and what it changed.</p>
      <form className="addline addline--task" onSubmit={add}>
        <label className="field">
          New task
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fix the login redirect, add dark mode…" required maxLength={200} />
        </label>
        <label className="field">
          Project
          <ProjectSelect value={project} onChange={setProject} />
        </label>
        <button className="btn" type="submit" disabled={!title.trim()}>
          <Icon name="plus" size={16} /> Add
        </button>
      </form>
      {error && <p className="notice signal-text">{error}</p>}
      <div className={`board mod-tasks${board.drag?.active ? ' board--dragging' : ''}`}>
        {COLUMNS.map((col) =>
          col.id === 'done' ? (
            <BoardColumn
              key={col.id}
              col={col}
              tasks={allDone ? done : done.slice(0, DONE_SHOWN)}
              {...board}
              more={
                !allDone && done.length > DONE_SHOWN ? (
                  <button className="btn btn--quiet" type="button" onClick={() => setAllDone(true)}>
                    Show all {done.length}
                  </button>
                ) : undefined
              }
            />
          ) : (
            <BoardColumn key={col.id} col={col} tasks={of(col.states)} {...board} />
          ),
        )}
      </div>
    </div>
  )
}

function TaskPage({ id, assign }: { id: string; assign?: boolean }) {
  const res = usePoll<TaskDetail>(`tasks/${encodeURIComponent(id)}`, 3000)
  const back = (
    <a className="side__back" href="#/m/tasks">
      <Icon name="back" size={18} /> All tasks
    </a>
  )
  if (res.error && !res.data)
    return (
      <div className="sheet">
        {back}
        <div className="sheet__empty">{res.error.message.includes('Not found') ? 'No such task. It may have been deleted.' : res.error.message}</div>
      </div>
    )
  if (!res.data) return <div className="sheet__empty">Loading…</div>
  return <TaskDetailView task={res.data} refresh={res.refresh} back={back} assign={assign} key={res.data.id} />
}

function TaskDetailView({ task, refresh, back, assign }: { task: TaskDetail; refresh: () => void; back: ReactNode; assign?: boolean }) {
  const { refreshTasks } = useHub()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'task' | 'activity'>(task.started_at && !assign ? 'activity' : 'task')
  const [draft, setDraft] = useState<Draft>({ title: task.title, notes: task.notes, project: task.project })
  const dirty = draft.title !== task.title || draft.notes !== task.notes || draft.project !== task.project

  const run = async (work: () => Promise<unknown>, failed: string) => {
    setBusy(true)
    setError('')
    try {
      await work()
      refresh()
      refreshTasks()
    } catch (err) {
      setError(err instanceof Error ? err.message : failed)
    } finally {
      setBusy(false)
    }
  }
  const act = (path: string) => run(() => api(`tasks/${task.id}/${path}`, { method: 'POST' }), "Couldn't do that.")
  const save = () => run(() => api(`tasks/${task.id}`, { method: 'PATCH', json: draft }), "Couldn't save.")
  const remove = async () => {
    try {
      await api(`tasks/${task.id}`, { method: 'DELETE' })
      refreshTasks()
      go('#/m/tasks')
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete it.")
    }
  }
  const unassigned = task.state === 'todo' || task.state === 'failed'
  const activity = task.events.filter((e) => e.kind !== 'created').length
  // Top right of the task on a wide screen; a bar along the bottom on a phone.
  const bar = (where: string) => (
    <div className={`sheet__actions ${where}`}>
      <button className="btn" type="button" disabled={busy || !dirty || !draft.title.trim()} onClick={save}>
        {busy && dirty ? 'Saving' : dirty ? 'Save changes' : 'Saved'}
      </button>
      <ConfirmButton onConfirm={remove} confirmLabel={task.live ? 'Delete (the agent keeps running)' : 'Confirm delete'} disabled={busy}>
        <Icon name="trash" size={16} /> Delete
      </ConfirmButton>
    </div>
  )

  return (
    <div className="sheet">
      {back}
      <header className="sheet__head mod-tasks task__head">
        <div className="task__heading">
          <span className={`sheet__index${fault(task.state) ? ' sheet__index--fault' : ''}`}>{STATE_LABEL[task.state]}</span>
          <h2 className="sheet__title task__title">{task.title}</h2>
        </div>
        {bar("task__bar")}
      </header>

      {task.state === 'blocked' && (
        <p className="notice notice--fault">
          <strong>{agentLabel(task)} is waiting on you.</strong>{' '}
          {task.prompt_pending ? 'It asks something before it starts (trusting the folder, say). Once you answer, it gets the task.' : 'It stopped on an approval or a question.'}{' '}
          <a href={agentHref({ pane_id: task.pane_id, source: task.agent_source })}>Answer it in Agents</a>.
        </p>
      )}
      {error && <p className="notice signal-text">{error}</p>}

      <div className="seg seg--mod mod-tasks task__tabs" role="group" aria-label="Show">
        <button type="button" className="seg__btn" aria-pressed={tab === 'task'} onClick={() => setTab('task')}>
          Task
        </button>
        <button type="button" className="seg__btn" aria-pressed={tab === 'activity'} onClick={() => setTab('activity')}>
          Activity · {activity}
        </button>
      </div>

      {tab === 'task' ? (
        <>
          {unassigned ? (
            <AssignForm task={task} onAssigned={() => (refresh(), setTab('activity'))} />
          ) : (
            <AgentFacts task={task} busy={busy} act={act} />
          )}
          <TaskFields task={task} draft={draft} onChange={setDraft} />
        </>
      ) : (
        <>
          {!task.started_at && <p className="sheet__empty">Nothing yet: no agent has had it. Hand it over from the Task tab.</p>}
          {task.started_at && <Timeline task={task} />}
          <History events={task.events} state={task.state} />
        </>
      )}
      {bar('task__bar task__bar--bottom')}
    </div>
  )
}

function AgentFacts({ task, busy, act }: { task: TaskDetail; busy: boolean; act: (path: string) => void }) {
  const { agents } = useHub()
  const href = agentHref({ pane_id: task.pane_id, source: task.agent_source })
  const on = sourceLabel(agents, { source: task.agent_source })
  return (
    <section className="sheet__section">
      <h3>Agent</h3>
      <dl className="facts">
        <dt>Given to</dt>
        <dd>
          {task.agent_name ? `${task.agent_name} · ` : ''}
          {task.agent_kind}
          {on && ` on ${on}`}
          {task.live && task.pane_id ? (
            <>
              {' · '}
              <a href={href}>{task.pane_id}</a>
            </>
          ) : (
            ' · no longer followed'
          )}
        </dd>
        {task.agent_title && task.live && (
          <>
            <dt>Doing</dt>
            <dd>{task.agent_title}</dd>
          </>
        )}
        {task.started_at && (
          <>
            <dt>Started</dt>
            <dd>{ago(task.started_at)}</dd>
          </>
        )}
      </dl>
      <div className="sheet__actions" style={{ justifyContent: 'start' }}>
        {task.live && task.pane_id && (
          <a className="btn" href={href}>
            <Icon name="terminal" size={16} /> Watch live
          </a>
        )}
        {task.state !== 'done' && (
          <button className="btn" type="button" disabled={busy} onClick={() => act('done')}>
            Mark done
          </button>
        )}
        {task.state === 'done' ? (
          <button className="btn btn--quiet" type="button" disabled={busy} onClick={() => act('reopen')}>
            Reopen
          </button>
        ) : (
          <ConfirmButton confirmLabel="Stop following it" onConfirm={() => act('reopen')} disabled={busy}>
            Back to to do
          </ConfirmButton>
        )}
      </div>
    </section>
  )
}

type Draft = { title: string; notes: string; project: number | null }

/** The task's own fields. Saved with the button at the top of the page. */
function TaskFields({ task, draft, onChange }: { task: TaskDetail; draft: Draft; onChange: (d: Draft) => void }) {
  return (
    <section className="sheet__section">
      <h3>Task</h3>
      {task.live && <p className="sheet__lede">The agent already has it: changes here are for your list, not sent to the agent.</p>}
      <label className="field">
        What needs doing
        <input value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })} required maxLength={200} />
      </label>
      <label className="field">
        Details for the agent
        <textarea rows={5} value={draft.notes} onChange={(e) => onChange({ ...draft, notes: e.target.value })} placeholder="Where to look, what done looks like, what not to touch…" />
      </label>
      <label className="field">
        Project
        <ProjectSelect value={draft.project} onChange={(project) => onChange({ ...draft, project })} />
      </label>
    </section>
  )
}

/** Give the task to an agent already open in Herdr, or start a new one in the project's folder. */
function AssignForm({ task, onAssigned }: { task: TaskDetail; onAssigned: () => void }) {
  const { agents, projects, refreshTasks, refreshAgents } = useHub()
  const open = (agents?.agents ?? []).filter((a) => a.kind !== 'terminal')
  const ready = open.filter((a) => a.status === 'idle' || a.status === 'done')
  // Where a new agent can start: the sources that answer.
  const places = sourcesOf(agents).filter((s) => s.available)
  const [how, setHow] = useState<'new' | 'open'>('new')
  const [kind, setKind] = useState(agents?.kinds?.[0] ?? 'claude')
  const [place, setPlace] = useState<number | null>(null)
  const [pane, setPane] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const project = (projects ?? []).find((p) => p.id === task.project)
  // `pane` is `<source>/<pane id>`: the same pane id can be open in two sources.
  const chosenPane = pane || (ready[0] ? agentKey(ready[0]) : '')
  const chosenPlace = place ?? places[0]?.id ?? 0
  const placeName = places.length > 1 ? places.find((s) => s.id === chosenPlace)?.name : ''

  if (!agents) return null
  if (!agents.available || agents.terminal !== 'control')
    return (
      <section className="sheet__section">
        <h3>Give it to an agent</h3>
        <p className="notice">
          {!agents.available
            ? 'Herdr isn’t reachable, so no agent can take it. See Agents for why.'
            : 'Giving tasks to agents is turned off here (MARUMADO_HERDR_TERMINAL is not control).'}
        </p>
      </section>
    )

  const assign = async () => {
    setBusy(true)
    setError('')
    try {
      const picked = parseAgentRef(chosenPane)
      await api(`tasks/${task.id}/assign`, {
        method: 'POST',
        json: how === 'new' ? { kind, source: chosenPlace } : { pane_id: picked?.pane ?? '', source: picked?.source ?? 0 },
      })
      onAssigned()
      refreshTasks()
      refreshAgents()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't hand it over.")
    } finally {
      setBusy(false)
    }
  }
  const prompt = `${task.title}\n\n${task.notes.trim()}`.trim()

  return (
    <section className="sheet__section">
      <h3>Give it to an agent</h3>
      <div className="seg seg--mod mod-tasks" role="group" aria-label="Which agent">
        <button type="button" className="seg__btn" aria-pressed={how === 'new'} onClick={() => setHow('new')}>
          Start a new agent
        </button>
        <button type="button" className="seg__btn" aria-pressed={how === 'open'} onClick={() => setHow('open')}>
          An open agent · {ready.length}
        </button>
      </div>
      {how === 'new' ? (
        <>
          <label className="field">
            Agent
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {(agents.kinds ?? ['claude']).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          {places.length > 1 && (
            <label className="field">
              Where
              <select value={chosenPlace} onChange={(e) => setPlace(Number(e.target.value))}>
                {places.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="sheet__lede">
            Opens a new Herdr workspace{placeName ? <> on <strong>{placeName}</strong></> : ''} {project?.path ? <>in <strong className="mono">{project.name}</strong>&rsquo;s folder</> : 'in Herdr’s default folder (pick a project to start there)'}, starts {kind} and gives it the task. If {kind} asks something first, the task waits under Needs you until you answer.
          </p>
        </>
      ) : ready.length ? (
        <label className="field">
          Agent
          <select value={chosenPane} onChange={(e) => setPane(e.target.value)}>
            {open.map((a) => {
              const on = sourceLabel(agents, a)
              return (
                <option key={agentKey(a)} value={agentKey(a)} disabled={a.status === 'working' || a.status === 'blocked'}>
                  {a.name || a.kind} · {a.kind}
                  {on ? ` on ${on}` : ''} · {a.cwd.split('/').filter(Boolean).pop() || a.cwd} · {a.status === 'working' ? 'busy' : a.status === 'blocked' ? 'waiting on you' : 'ready'}
                </option>
              )
            })}
          </select>
        </label>
      ) : (
        <p className="sheet__lede">{open.length ? 'Every open agent is busy or waiting on you.' : 'No agent is open in Herdr.'} Start a new one instead.</p>
      )}
      <details className="task__prompt">
        <summary>What the agent will be told</summary>
        <pre className="logs">{prompt}</pre>
      </details>
      {error && <p className="notice signal-text">{error}</p>}
      <div className="sheet__actions" style={{ justifyContent: 'start' }}>
        <button className="btn" type="button" disabled={busy || (how === 'open' && !chosenPane)} onClick={assign}>
          <Icon name="agent" size={16} /> {busy ? 'Handing over…' : task.state === 'failed' ? 'Try again' : 'Give it to the agent'}
        </button>
      </div>
    </section>
  )
}

type Phase = 'starting' | 'working' | 'blocked' | 'idle'
const PHASE_LABEL: Record<Phase, string> = { starting: 'Handing over', working: 'Working', blocked: 'Waiting on you', idle: 'Idle' }
type Segment = { phase: Phase; from: number; to: number }

/** The agent's states since it got the task (the last assignment), from the state events. */
function segments(task: TaskDetail): Segment[] {
  const lastAssigned = [...task.events].reverse().find((e) => e.kind === 'assigned')
  if (!lastAssigned) return []
  const start = Date.parse(lastAssigned.at)
  const ongoing = task.state === 'starting' || task.state === 'working' || task.state === 'blocked'
  const lastAt = Date.parse(task.events[task.events.length - 1].at)
  const end = ongoing ? Date.now() : Math.max(task.finished_at ? Date.parse(task.finished_at) : lastAt, start + 1000)
  const out: Segment[] = [{ phase: 'starting', from: start, to: end }]
  for (const e of task.events) {
    const t = Date.parse(e.at)
    if (e.kind !== 'state' || t < start || t >= end) continue
    const phase: Phase = e.state === 'working' ? 'working' : e.state === 'blocked' ? 'blocked' : e.state === 'starting' ? 'starting' : 'idle'
    const prev = out[out.length - 1]
    if (prev.phase === phase) continue
    prev.to = t
    out.push({ phase, from: t, to: end })
  }
  return out.filter((s) => s.to > s.from)
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function Timeline({ task }: { task: TaskDetail }) {
  const segs = segments(task)
  if (!segs.length) return null
  const from = segs[0].from
  const to = segs[segs.length - 1].to
  const total = to - from
  const totals = new Map<Phase, number>()
  for (const s of segs) totals.set(s.phase, (totals.get(s.phase) ?? 0) + (s.to - s.from))
  const order: Phase[] = ['working', 'blocked', 'idle', 'starting']
  return (
    <section className="sheet__section">
      <h3>Timeline · {span(total / 1000)}</h3>
      <div className="tl mod-tasks" role="img" aria-label={segs.map((s) => `${PHASE_LABEL[s.phase]} ${span((s.to - s.from) / 1000)}`).join(', ')}>
        {segs.map((s, i) => (
          <span
            key={i}
            className={`tl__seg tl__seg--${s.phase}${s.phase === 'blocked' && i === segs.length - 1 && task.state === 'blocked' ? ' tl__seg--now' : ''}`}
            style={{ flexGrow: s.to - s.from }}
            title={`${PHASE_LABEL[s.phase]} · ${clock(s.from)}–${clock(s.to)} · ${span((s.to - s.from) / 1000)}`}
          />
        ))}
      </div>
      <div className="tl__axis">
        <span>{clock(from)}</span>
        <span>{task.state === 'working' || task.state === 'blocked' || task.state === 'starting' ? 'now' : clock(to)}</span>
      </div>
      <ul className="tl__legend mod-tasks">
        {order
          .filter((p) => totals.get(p))
          .map((p) => (
            <li key={p}>
              <span className={`tl__key tl__seg--${p}`} aria-hidden="true" />
              {PHASE_LABEL[p]} <span className="mono">{span(totals.get(p)! / 1000)}</span>
            </li>
          ))}
      </ul>
    </section>
  )
}

const EVENT_DOT: Partial<Record<TaskEvent['kind'], string>> = { closed: 'quiet', activity: 'quiet', created: 'quiet' }

/** Signal only for what needs you now: the wait the agent is in, or the error that failed the task. */
function eventDot(e: TaskEvent, now: boolean): string {
  if (e.kind === 'state') return e.state === 'blocked' ? (now ? 'fault' : 'ink') : e.state === 'working' ? 'on' : 'quiet'
  if (e.kind === 'error') return now ? 'fault' : 'ink'
  if (e.kind === 'changes' || e.kind === 'done') return 'on'
  return EVENT_DOT[e.kind] ?? ''
}

function stamp(iso: string): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

function Changes({ data }: { data: TaskEvent['data'] }) {
  const commits = data.commits ?? []
  const files = data.files ?? []
  if (!commits.length && !files.length) return null
  return (
    <details className="tlog__more">
      <summary>{data.stat || 'Show the changes'}</summary>
      <Secret label="Changes">
        {commits.length > 0 && (
          <ul className="tlog__files">
            {commits.map((c) => (
              <li key={c.sha}>
                <span className="tlog__sha">{c.sha}</span> {c.subject}
              </li>
            ))}
          </ul>
        )}
        {files.length > 0 && (
          <ul className="tlog__files">
            {files.map((f) => (
              <li key={f.path}>
                <span className="tlog__sha" title={FILE_STATUS[f.status] ?? f.status}>
                  {f.status}
                </span>{' '}
                {f.path}
              </li>
            ))}
            {(data.file_count ?? 0) > files.length && <li>and {(data.file_count ?? 0) - files.length} more</li>}
          </ul>
        )}
      </Secret>
    </details>
  )
}

const FILE_STATUS: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', '?': 'new, not in git yet' }

/** Everything that happened to the task, oldest first, with the agent's terminal at each change. */
function History({ events, state }: { events: TaskEvent[]; state: TaskState }) {
  const last = events[events.length - 1]
  const now = (e: TaskEvent) => e === last && (state === 'blocked' || state === 'failed')
  return (
    <section className="sheet__section">
      <h3>What happened · {events.length}</h3>
      <ol className="tlog mod-tasks">
        {events.map((e) => (
          <li key={e.id} className={`tlog__item${e.kind === 'activity' ? ' tlog__item--quiet' : ''}`}>
            <span className={`tlog__dot tlog__dot--${eventDot(e, now(e))}`} aria-hidden="true" />
            <time className="tlog__time" dateTime={e.at}>
              {stamp(e.at)}
            </time>
            <div className="tlog__body">
              <span className={now(e) ? 'signal-text' : undefined}>
                {e.kind === 'activity' ? `Doing: ${e.text}` : e.text}
              </span>
              {e.kind === 'changes' && <Changes data={e.data} />}
              {e.output && (
                <details className="tlog__more">
                  <summary>{e.kind === 'prompt' ? 'What it was told' : 'Terminal at that moment'}</summary>
                  <Secret label="Output">
                    <pre className="logs">{e.output}</pre>
                  </Secret>
                </details>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
