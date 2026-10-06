import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ConfirmButton } from '../components/ConfirmButton'
import { Icon } from '../components/Icon'
import { agentHref, agentKey, parseAgentRef, sourceLabel } from '../lib/agents'
import { api } from '../lib/api'
import { ago } from '../lib/format'
import { useHub } from '../lib/hub'
import { go } from '../lib/route'
import { Secret } from '../lib/streaming'
import type { Plan, Project, Task, TaskDetail, TaskEvent, TaskState } from '../lib/types'
import { folderIn, machineOfSource, startPlaces } from '../lib/work'
import { usePoll } from '../lib/usePoll'
import { SheetHead } from './sheetHead'
import { NewPlan, PlanPage, PlansList } from './plans'
import { TraceView, type Wait } from './trace'

const STATE_LABEL: Record<TaskState, string> = {
  todo: 'TO DO',
  queued: 'QUEUED',
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
  if (s === 'queued') return 'row__lamp row__lamp--queued'
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
    case 'queued':
      return `${where} · queued in a plan, starts when its turn comes`
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

/** `adds`: what the add form at the bottom of the column says; none, the column can't be added to. */
type Column = { id: string; title: string; lede: string; states: TaskState[]; takes: boolean; adds?: string }

const COLUMNS: Column[] = [
  { id: 'todo', title: 'To do', lede: 'Waiting for an agent. Drop a task on Working to hand it over, or put it in a plan.', states: ['todo', 'queued'], takes: true, adds: 'Add a task' },
  { id: 'working', title: 'Working', lede: 'An agent is on it.', states: ['starting', 'working'], takes: true, adds: 'Add and hand over' },
  { id: 'needs', title: 'Needs you', lede: 'Stopped on a question, or failed. Only an agent puts a task here.', states: ['blocked', 'failed'], takes: false },
  { id: 'review', title: 'To review', lede: 'The agent finished its turn: check its work.', states: ['review'], takes: true, adds: 'Add to review' },
  { id: 'done', title: 'Done', lede: 'Nothing done yet.', states: ['done'], takes: true, adds: 'Add as done' },
]

const PROJECT_KEY = 'marumado.tasks.project'

function rememberedProject(): number | null {
  try {
    const v = Number(localStorage.getItem(PROJECT_KEY))
    return v > 0 ? v : null
  } catch {
    return null
  }
}

/** The add button at the foot of a column, as on a GitHub project board: a task made there lands in that column
    (Working: made, then handed to the agent you choose in the same dialog). */
function AddToColumn({ col, onError }: { col: Column; onError: (text: string) => void }) {
  const [open, setOpen] = useState(false)
  if (!col.adds) return null
  return (
    <>
      <button className="kcol__add" type="button" onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} /> {col.adds}
      </button>
      {open && <AddTaskModal col={col} onClose={() => setOpen(false)} onError={onError} />}
    </>
  )
}

function AddTaskModal({ col, onClose, onError }: { col: Column; onClose: () => void; onError: (text: string) => void }) {
  const { projects, refreshTasks, refreshAgents } = useHub()
  const dialog = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState('')
  const [project, setProject] = useState<number | null>(rememberedProject)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const handOver = col.id === 'working'
  const pick = useAgentPick((projects ?? []).find((p) => p.id === project))
  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const chooseProject = (v: number | null) => {
    setProject(v)
    try {
      localStorage.setItem(PROJECT_KEY, v ? String(v) : '')
    } catch {
      // private mode: for this visit only
    }
  }
  /** `another`: clear the prompt and stay open for the next one. */
  const add = async (another = false) => {
    if (!text.trim() || busy || (handOver && !pick.ready)) return
    setBusy(true)
    setError('')
    onError('')
    let made: Task | null = null
    try {
      made = await api<Task>('tasks', { method: 'POST', json: { prompt: text.trim(), project } })
      if (handOver) {
        await api(`tasks/${made.id}/assign`, { method: 'POST', json: pick.body() })
        refreshAgents()
      } else if (col.id === 'review' || col.id === 'done') await api(`tasks/${made.id}/${col.id}`, { method: 'POST' })
      refreshTasks()
      if (another) setText('')
      else onClose()
    } catch (err) {
      const why = err instanceof Error ? err.message : "Couldn't add it."
      if (!made) return setError(why)
      // Made, but not moved or handed over: it waits under To do.
      refreshTasks()
      onError(`Added “${made.title}” to To do, but ${handOver ? "couldn't hand it over" : "couldn't move it"}: ${why}`)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="pmodal kadd"
      aria-labelledby="kadd-title"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => e.target === dialog.current && onClose()}
    >
      <header className="pmodal__head">
        <h2 className="kadd__heading" id="kadd-title">
          <span className={`kcol__lamp kcol__lamp--${col.id}`} aria-hidden="true" />
          {col.adds}
        </h2>
        <button className="tool" type="button" onClick={onClose} aria-label="Close">
          <Icon name="close" size={18} />
        </button>
      </header>
      <form
        className="kadd__form"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <div className="pmodal__body kadd__body">
          <label className="field">
            {handOver ? 'What the agent should do' : 'Task'}
            <textarea
              className="kadd__prompt"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Ctrl/⌘+Enter adds it; Enter starts a new line of the prompt.
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  add()
                }
              }}
              placeholder={handOver ? 'Write it as you’d tell the agent…' : 'Fix the login redirect…'}
              rows={8}
              maxLength={8000}
              autoFocus
            />
            <span className="field__hint">The first line names it; all of it is what the agent is told. Ctrl+Enter adds it.</span>
          </label>
          <label className="field">
            Project
            <ProjectSelect value={project} onChange={chooseProject} />
          </label>
          {handOver && <section className="kadd__agent">{pick.fields}</section>}
          {error && <p className="notice signal-text">{error}</p>}
        </div>
        <footer className="kadd__bar">
          <button className="btn btn--quiet" type="button" onClick={onClose}>
            Cancel
          </button>
          {!handOver && (
            <button className="btn btn--quiet" type="button" disabled={!text.trim() || busy} onClick={() => add(true)}>
              Add another
            </button>
          )}
          <button className="btn" type="submit" disabled={!text.trim() || busy || (handOver && !pick.ready)}>
            {handOver ? (
              <>
                <Icon name="agent" size={16} /> {busy ? 'Handing over…' : 'Add and hand over'}
              </>
            ) : busy ? (
              'Adding…'
            ) : (
              'Add'
            )}
          </button>
        </footer>
      </form>
    </dialog>
  )
}

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

function BoardColumn({ col, tasks, count, drag, grab, dragged, more, onError }: {
  col: Column
  tasks: Task[]
  count?: number
  drag: Drag | null
  grab: (e: ReactPointerEvent, t: Task) => void
  dragged: () => boolean
  more?: ReactNode
  onError: (text: string) => void
}) {
  const over = drag?.active && drag.over === col.id
  return (
    <section className={`kcol kcol--${col.id}${over ? (col.takes ? ' kcol--over' : ' kcol--refuse') : ''}`} aria-label={col.title} data-column={col.id}>
      <h3 className="kcol__head">
        <span className={`kcol__lamp kcol__lamp--${col.id}`} aria-hidden="true" />
        <span className="kcol__name">{col.title}</span>
        <span className="kcol__count">{count ?? tasks.length}</span>
      </h3>
      <div className="kcol__body">
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
      </div>
      <AddToColumn col={col} onError={onError} />
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
  const [error, setError] = useState('')
  const [allDone, setAllDone] = useState(false)

  const move = useRef<(id: number, column: string) => void>(() => undefined)
  const board = useBoardDrag((id, column) => move.current(id, column))

  if (sub === 'archived') return <ArchivedSheet />
  if (sub && sub !== 'plans') {
    const [id, view] = sub.split('/')
    if (id === 'plan') return view === 'new' ? <NewPlan /> : <PlanPage id={view} key={view} />
    return <TaskPage id={id} assign={view === 'assign'} />
  }
  if (!tasks) return <div className="sheet__empty">Loading tasks…</div>

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
  const archiveDone = async () => {
    setError('')
    try {
      await api('tasks/archive-done', { method: 'POST' })
      refreshTasks()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't archive them.")
    }
  }
  const plans = sub === 'plans'
  // Plans and the board each get the whole page: the board fits the window, its columns scrolling their own cards.
  const head = (
    <>
      <SheetHead id="tasks">
        <a className="btn btn--quiet" href="#/m/tasks/archived">
          <Icon name="archive" size={16} /> Archived
        </a>
      </SheetHead>
      <div className="seg seg--mod mod-tasks task__tabs" role="group" aria-label="Show">
        <button type="button" className="seg__btn" aria-pressed={!plans} onClick={() => go('#/m/tasks')}>
          Tasks · {tasks.filter((t) => t.state !== 'done').length}
        </button>
        <button type="button" className="seg__btn" aria-pressed={plans} onClick={() => go('#/m/tasks/plans')}>
          Plans
        </button>
      </div>
    </>
  )
  if (plans)
    return (
      <div className="sheet">
        {head}
        <PlansList />
      </div>
    )

  return (
    <div className="sheet sheet--fill sheet--board">
      {head}
      {error && <p className="notice signal-text">{error}</p>}
      <div className={`board mod-tasks${board.drag?.active ? ' board--dragging' : ''}`}>
        {COLUMNS.map((col) =>
          col.id === 'done' ? (
            <BoardColumn
              key={col.id}
              col={col}
              tasks={allDone ? done : done.slice(0, DONE_SHOWN)}
              count={done.length}
              onError={setError}
              {...board}
              more={
                done.length > 0 && (
                  <div className="kcol__more">
                    {!allDone && done.length > DONE_SHOWN && (
                      <button className="btn btn--quiet" type="button" onClick={() => setAllDone(true)}>
                        Show all {done.length}
                      </button>
                    )}
                    <ConfirmButton onConfirm={archiveDone} confirmLabel={`Archive ${done.length}`} title="Off the board, kept with their history under Archived">
                      <Icon name="archive" size={16} /> Archive all
                    </ConfirmButton>
                  </div>
                )
              }
            />
          ) : (
            <BoardColumn key={col.id} col={col} tasks={of(col.states)} onError={setError} {...board} />
          ),
        )}
      </div>
    </div>
  )
}

/** Finished plans and done tasks put away: off the board and every list. Restoring one puts it back. */
function ArchivedSheet() {
  const { refreshTasks } = useHub()
  const plans = usePoll<Plan[]>('plans?archived=1', 30000)
  const tasks = usePoll<Task[]>('tasks?archived=1', 30000)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const restore = async (path: string, name: string) => {
    setBusy(path)
    setError('')
    try {
      await api(`${path}/restore`, { method: 'POST' })
      plans.refresh()
      tasks.refresh()
      refreshTasks()
    } catch (err) {
      setError(err instanceof Error ? `Couldn't restore “${name}”: ${err.message}` : "Couldn't restore it.")
    } finally {
      setBusy('')
    }
  }
  const newest = <T extends { archived_at: string | null }>(xs: T[]) => [...xs].sort((a, b) => (b.archived_at ?? '').localeCompare(a.archived_at ?? ''))
  // A plan's steps are listed with their plan.
  const loose = newest((tasks.data ?? []).filter((t) => !(plans.data ?? []).some((p) => p.id === t.plan)))
  const failed = plans.error ?? tasks.error
  const restoreButton = (path: string, name: string) => (
    <span className="row__actions">
      <button className="btn" type="button" onClick={() => restore(path, name)} disabled={busy === path}>
        {busy === path ? 'Restoring' : 'Restore'}
      </button>
    </span>
  )
  return (
    <div className="sheet">
      <a className="side__back" href="#/m/tasks">
        <Icon name="back" size={18} /> All tasks
      </a>
      <header className="sheet__head mod-tasks">
        <h2 className="sheet__title">Archived</h2>
      </header>
      <p className="sheet__lede">Finished plans and done tasks you put away, with their history. Restore one and it goes back where it was.</p>
      {(error || failed) && <p className="notice signal-text">{error || `Couldn't load them: ${failed?.message}`}</p>}
      {!plans.data || !tasks.data ? (
        !failed && <div className="sheet__empty">Loading…</div>
      ) : (
        <>
          <section className="sheet__section">
            <h3>Plans · {plans.data.length}</h3>
            {plans.data.length ? (
              <ul className="list mod-tasks">
                {newest(plans.data).map((p) => (
                  <li className="row" key={p.id}>
                    <span className="row__lamp" aria-hidden />
                    <a className="row__main row__link" href={`#/m/tasks/plan/${p.id}`}>
                      {p.title}
                      <span className="row__sub">
                        {p.project_name || 'No project'} · {p.steps.length} {p.steps.length === 1 ? 'step' : 'steps'} · archived {ago(p.archived_at ?? p.updated_at)}
                      </span>
                    </a>
                    {restoreButton(`plans/${p.id}`, p.title)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sheet__empty">No plan archived.</p>
            )}
          </section>
          <section className="sheet__section">
            <h3>Tasks · {loose.length}</h3>
            {loose.length ? (
              <ul className="list mod-tasks">
                {loose.map((t) => (
                  <li className="row" key={t.id}>
                    <span className="row__lamp" aria-hidden />
                    <a className="row__main row__link" href={`#/m/tasks/${t.id}`}>
                      {t.title}
                      <span className="row__sub">
                        {t.project_name || 'No project'} · done {ago(t.finished_at ?? t.updated_at)} · archived {ago(t.archived_at ?? t.updated_at)}
                      </span>
                    </a>
                    {restoreButton(`tasks/${t.id}`, t.title)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sheet__empty">No task archived.</p>
            )}
          </section>
        </>
      )}
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
  const [tab, setTab] = useState<'task' | 'trace' | 'activity'>(task.started_at && !assign ? 'trace' : 'task')
  const [draft, setDraft] = useState<Draft>({ title: task.title, prompt: task.prompt, project: task.project })
  const dirty = draft.title !== task.title || draft.prompt !== task.prompt || draft.project !== task.project

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
  const save = () =>
    run(async () => {
      // A title left empty comes back made from the prompt.
      const saved = await api<Task>(`tasks/${task.id}`, { method: 'PATCH', json: draft })
      setDraft({ title: saved.title, prompt: saved.prompt, project: saved.project })
    }, "Couldn't save.")
  const archive = () =>
    run(async () => {
      await api(`tasks/${task.id}/archive`, { method: 'POST' })
      go('#/m/tasks')
    }, "Couldn't archive it.")
  const remove = async () => {
    try {
      await api(`tasks/${task.id}`, { method: 'DELETE' })
      refreshTasks()
      go('#/m/tasks')
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete it.")
    }
  }
  const unassigned = task.state === 'todo' || task.state === 'queued' || task.state === 'failed'
  const activity = task.events.filter((e) => e.kind !== 'created').length
  // Top right of the task on a wide screen; a bar along the bottom on a phone.
  const bar = (where: string) => (
    <div className={`sheet__actions ${where}`}>
      <button className="btn" type="button" disabled={busy || !dirty || !(draft.title.trim() || draft.prompt.trim())} onClick={save}>
        {busy && dirty ? 'Saving' : dirty ? 'Save changes' : 'Saved'}
      </button>
      {task.state === 'done' && !task.archived_at && (
        <button className="btn btn--quiet" type="button" disabled={busy} onClick={archive} title="Off the board, kept with its history under Archived">
          <Icon name="archive" size={16} /> Archive
        </button>
      )}
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
          <div className="task__titleline">
            <h2 className="sheet__title task__title" title={task.title}>
              {task.title}
            </h2>
            {/* With Save and Delete at the end of the title's line, so the agent's terminal is one click away from every tab. */}
            {task.live && task.pane_id && (
              <a className="btn btn--quiet task__watch" href={agentHref({ pane_id: task.pane_id, source: task.agent_source })}>
                <Icon name="terminal" size={16} /> Watch live
              </a>
            )}
            {bar('task__bar')}
          </div>
        </div>
      </header>

      {task.plan != null && (
        <p className="sheet__lede">
          A step of a plan{task.state === 'queued' ? ': it starts by itself when its turn comes' : ''}. <a href={`#/m/tasks/plan/${task.plan}`}>Open the plan</a>
        </p>
      )}
      {task.archived_at && (
        <p className="notice">
          Archived {ago(task.archived_at)}: off the board and every list.{' '}
          <button className="btn btn--quiet" type="button" disabled={busy} onClick={() => act('restore')}>
            Restore
          </button>
        </p>
      )}
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
        <button type="button" className="seg__btn" aria-pressed={tab === 'trace'} onClick={() => setTab('trace')}>
          What it did
        </button>
        <button type="button" className="seg__btn" aria-pressed={tab === 'activity'} onClick={() => setTab('activity')}>
          History · {activity}
        </button>
      </div>

      {tab === 'task' ? (
        <>
          {unassigned ? (
            <AssignForm task={task} onAssigned={() => (refresh(), setTab('trace'))} />
          ) : (
            <AgentFacts task={task} busy={busy} act={act} />
          )}
          <TaskFields task={task} draft={draft} onChange={setDraft} />
        </>
      ) : tab === 'trace' ? (
        task.started_at ? (
          <TraceView task={task} waits={waits(task)} key={task.started_at} />
        ) : (
          <p className="sheet__empty">Nothing yet: no agent has had it. Hand it over from the Task tab.</p>
        )
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

type Draft = { title: string; prompt: string; project: number | null }

/** The task's own fields. Saved with the button at the top of the page. */
function TaskFields({ task, draft, onChange }: { task: TaskDetail; draft: Draft; onChange: (d: Draft) => void }) {
  return (
    <section className="sheet__section">
      <h3>Task</h3>
      {task.live && <p className="sheet__lede">The agent already has it: changes here are for your list, not sent to the agent.</p>}
      <label className="field">
        Prompt
        <textarea
          rows={Math.min(20, Math.max(6, draft.prompt.split('\n').length + 1))}
          value={draft.prompt}
          onChange={(e) => onChange({ ...draft, prompt: e.target.value })}
          placeholder={`What the agent is told. Empty, it gets the title: “${task.title}”.`}
        />
      </label>
      <label className="field">
        Title
        <input value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })} maxLength={200} placeholder="Made from the prompt" />
        <span className="field__hint">For the board and lists. Left empty, it is made from the prompt again.</span>
      </label>
      <label className="field">
        Project
        <ProjectSelect value={draft.project} onChange={(project) => onChange({ ...draft, project })} />
      </label>
      {task.project != null && (
        <a className="row__link" href={`#/m/projects/${task.project}`} style={{ justifySelf: 'start' }}>
          Open {task.project_name || 'the project'}
        </a>
      )}
    </section>
  )
}

/** Which agent gets a task: a new one started in the project's folder, or one already open in Herdr.
    `ready`: something can be handed over; `body()`: what tasks/<id>/assign takes. */
function useAgentPick(project: Project | undefined) {
  const { agents } = useHub()
  const open = (agents?.agents ?? []).filter((a) => a.kind !== 'terminal')
  const ready = open.filter((a) => a.status === 'idle' || a.status === 'done')
  const places = startPlaces(project, agents)
  const [how, setHow] = useState<'new' | 'open'>('new')
  const [kind, setKind] = useState(agents?.kinds?.[0] ?? 'claude')
  const [place, setPlace] = useState<number | null>(null)
  const [pane, setPane] = useState('')
  // `pane` is `<source>/<pane id>`: the same pane id can be open in two sources.
  const chosenPane = pane || (ready[0] ? agentKey(ready[0]) : '')
  const chosenPlace = place != null && places.some((s) => s.id === place) ? place : places[0]?.id ?? 0
  const chosen = places.find((s) => s.id === chosenPlace)
  const placeName = places.length > 1 ? chosen?.name : ''
  const startsIn = chosen ? folderIn(project, chosen) : project?.path ?? ''
  const usable = !!agents?.available && agents.terminal === 'control'

  const body = () => {
    const picked = parseAgentRef(chosenPane)
    return how === 'new' ? { kind, source: chosenPlace } : { pane_id: picked?.pane ?? '', source: picked?.source ?? 0 }
  }

  const fields: ReactNode = !agents ? null : !usable ? (
    <p className="notice">
      {!agents.available
        ? 'Herdr isn’t reachable, so no agent can take it. See Agents for why.'
        : 'Giving tasks to agents is turned off here (MARUMADO_HERDR_TERMINAL is not control).'}
    </p>
  ) : (
    <>
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
                    {project && machineOfSource(s) != null && !folderIn(project, s) ? ' · no folder for this project there' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="sheet__lede">
            Opens a new Herdr workspace{placeName ? <> on <strong>{placeName}</strong></> : ''}{' '}
            {startsIn ? (
              <>
                in <strong className="mono">{project?.name}</strong>&rsquo;s folder (<Secret label="Folder">{startsIn}</Secret>)
              </>
            ) : project ? (
              `in Herdr’s default folder: ${project.name} has no folder there that Marumado knows of`
            ) : (
              'in Herdr’s default folder (pick a project to start there)'
            )}
            , starts {kind} and gives it the task. If {kind} asks something first, the task waits under Needs you until you answer.
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
    </>
  )
  return { fields, body, ready: usable && (how === 'new' || !!chosenPane) }
}

/** Give the task to an agent already open in Herdr, or start a new one in the project's folder. */
function AssignForm({ task, onAssigned }: { task: TaskDetail; onAssigned: () => void }) {
  const { agents, projects, refreshTasks, refreshAgents } = useHub()
  const pick = useAgentPick((projects ?? []).find((p) => p.id === task.project))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!agents) return null
  if (!agents.available || agents.terminal !== 'control')
    return (
      <section className="sheet__section">
        <h3>Give it to an agent</h3>
        {pick.fields}
      </section>
    )

  const assign = async () => {
    setBusy(true)
    setError('')
    try {
      await api(`tasks/${task.id}/assign`, { method: 'POST', json: pick.body() })
      onAssigned()
      refreshTasks()
      refreshAgents()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't hand it over.")
    } finally {
      setBusy(false)
    }
  }
  const prompt = task.prompt.trim() || task.title

  return (
    <section className="sheet__section">
      <h3>Give it to an agent</h3>
      {pick.fields}
      <details className="task__prompt">
        <summary>What the agent will be told</summary>
        <pre className="logs">{prompt}</pre>
      </details>
      {error && <p className="notice signal-text">{error}</p>}
      <div className="sheet__actions" style={{ justifyContent: 'start' }}>
        <button className="btn" type="button" disabled={busy || !pick.ready} onClick={assign}>
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

/** The agent's waits on you since it got the task, for the recording. */
const waits = (task: TaskDetail): Wait[] =>
  segments(task)
    .filter((s) => s.phase === 'blocked')
    .map((s, i, all) => ({ from: s.from, to: s.to, now: i === all.length - 1 && task.state === 'blocked' }))

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

const EVENT_DOT: Partial<Record<TaskEvent['kind'], string>> = { closed: 'quiet', activity: 'quiet', created: 'quiet', archived: 'quiet', restored: 'quiet' }

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
