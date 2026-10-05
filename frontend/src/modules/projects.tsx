import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ConfirmButton } from '../components/ConfirmButton'
import { DotChart } from '../components/DotChart'
import { Icon } from '../components/Icon'
import { OpenFolder } from '../components/OpenFolder'
import { agentHref, agentKey, sourceLabel } from '../lib/agents'
import { api, type MachineId } from '../lib/api'
import { ago, hostOf } from '../lib/format'
import { commits, pace, PACE_LABEL } from '../lib/growth'
import { useHub, type ModuleId } from '../lib/hub'
import { useMachines } from '../lib/machines'
import { go, moduleHref } from '../lib/route'
import type { Agent, Project, ScanRoot, Task, TaskState } from '../lib/types'
import { activity, openTasks, projectAgents, runsAnywhere, whereRunning, workLine, type Activity } from '../lib/work'
import { StartAgent } from './agentStart'
import { PinButton } from './projectPin'
import { useView, ViewSwitch } from './growth'
import { Secret } from '../lib/streaming'
import { usePoll } from '../lib/usePoll'
import { FilesView } from './files'
import { SheetHead, ViewTabs } from './sheetHead'

function lamp(p: Project) {
  const live = p.status.online.latest
  if (p.online_url && live && !live.ok) return 'row__lamp row__lamp--fault'
  return runsAnywhere(p) ? 'row__lamp row__lamp--on' : 'row__lamp'
}

function stateLabel(p: Project): string {
  const live = p.status.online.latest
  if (p.online_url && live && !live.ok) return 'Live site down'
  return whereRunning(p) || 'Idle'
}

const TASK_STATE: Record<TaskState, string> = { todo: 'To do', queued: 'Queued', starting: 'Starting', working: 'Working', blocked: 'Needs you', review: 'To review', done: 'Done', failed: 'Failed' }

function taskLamp(s: TaskState): string {
  if (s === 'blocked' || s === 'failed') return 'row__lamp row__lamp--fault'
  return s === 'working' || s === 'starting' ? 'row__lamp row__lamp--on' : 'row__lamp'
}

function Links({ p }: { p: Project }) {
  const local = p.local_url || p.suggested_local_url
  return (
    <span className="chips">
      {local && (
        <a className="chip" href={local} target="_blank" rel="noreferrer" >
          Local
        </a>
      )}
      {p.online_url && (
        <a className="chip" href={p.online_url} target="_blank" rel="noreferrer" >
          Live
        </a>
      )}
      {p.repo_url && (
        <a className="chip" href={p.repo_url} target="_blank" rel="noreferrer" >
          Repo
        </a>
      )}
      {p.path && !p.detected.missing && <OpenFolder path={p.path} variant="chip" />}
    </span>
  )
}

type Group = { key: string; title: string; path: string; missing: boolean; projects: Project[] }

const within = (path: string, root: string) => path === root || path.startsWith(`${root.replace(/\/+$/, '')}/`)

/** Pinned projects first, wherever they are; then projects by the scan folder they were found in (the deepest one,
    when folders nest), in Folders' order; then those outside every scan folder, and those added by hand. Empty
    groups are left out. */
function byFolder(list: Project[], roots: ScanRoot[]): Group[] {
  const groups: Group[] = roots.map((r) => ({ key: r.path, title: r.path, path: r.path, missing: !r.found, projects: [] }))
  const elsewhere: Group = { key: ':elsewhere', title: 'Elsewhere', path: '', missing: false, projects: [] }
  const manual: Group = { key: ':manual', title: 'Added by hand', path: '', missing: false, projects: [] }
  const pinned: Group = { key: ':pinned', title: 'Pinned', path: '', missing: false, projects: [] }
  for (const p of list) {
    if (p.pinned) {
      pinned.projects.push(p)
      continue
    }
    const home = p.path ? groups.filter((g) => within(p.path, g.path)).sort((a, b) => b.path.length - a.path.length)[0] : undefined
    ;(home ?? (p.source === 'manual' ? manual : elsewhere)).projects.push(p)
  }
  return [pinned, ...groups, elsewhere, manual].filter((g) => g.projects.length)
}

/** A group's overview in a few words: how many, what runs, what needs you, what moves, and what it is mostly made of. */
function groupLine(g: Group, act: (p: Project) => Activity): { text: string; fault: boolean } {
  const n = g.projects.length
  const running = g.projects.filter(runsAnywhere).length
  const work = g.projects.map(act)
  const blocked = work.reduce((sum, w) => sum + w.blocked, 0)
  const working = work.reduce((sum, w) => sum + w.working, 0)
  const moving = g.projects.filter((p) => pace(p) === 'moving').length
  const down = g.projects.filter((p) => p.online_url && p.status.online.latest && !p.status.online.latest.ok).length
  const stacks = new Map<string, number>()
  for (const p of g.projects) for (const st of p.detected.stacks ?? []) stacks.set(st, (stacks.get(st) ?? 0) + 1)
  const top = [...stacks].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([st]) => st)
  const parts = [
    `${n} project${n === 1 ? '' : 's'}`,
    down ? `${down} live site${down === 1 ? '' : 's'} down` : '',
    blocked ? `${blocked} need${blocked === 1 ? 's' : ''} you` : '',
    working ? `${working} agent${working === 1 ? '' : 's'} working` : '',
    running ? `${running} running` : '',
    moving ? `${moving} moving` : '',
    top.length ? top.join(', ') : '',
  ]
  return { text: parts.filter(Boolean).join(' · '), fault: blocked > 0 || down > 0 }
}

export function ProjectsSheet({ sub }: { sub?: string }) {
  const { projects, tasks, agents, refreshProjects } = useHub()
  const [q, setQ] = useState('')
  const [scanning, setScanning] = useState(false)
  const [view, setView] = useView('marumado.projects-view', ['grid', 'list'] as const)

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (projects ?? [])
      .filter((p) => p.kind === 'project')
      .filter((p) => !needle || [p.name, p.description, ...p.tags, ...(p.detected.stacks ?? [])].join(' ').toLowerCase().includes(needle))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(runsAnywhere(b)) - Number(runsAnywhere(a)) || a.name.localeCompare(b.name))
  }, [projects, q])
  const work = (p: Project) => workLine(activity(p, tasks, agents))
  const roots = usePoll<{ roots: ScanRoot[] }>(sub ? null : 'roots', 60000)
  const groups = useMemo(() => byFolder(list, roots.data?.roots ?? []), [list, roots.data])

  if (sub === 'folders') return <FoldersSheet />
  if (sub === 'archived') return <ArchivedSheet />
  if (sub === 'new') return <ProjectForm onDone={(id) => go(id ? `#/m/projects/${id}` : '#/m/projects')} />
  if (sub) {
    const [id, mode, ...rest] = sub.split('/')
    const project = projects?.find((p) => String(p.id) === id)
    if (!projects) return <div className="sheet__empty">Loading…</div>
    if (!project) return <div className="sheet__empty">That project no longer exists.</div>
    if ((mode === 'files' || mode === 'file') && project.path) return <FilesView project={project} kind={mode} rel={rest.join('/')} key={sub} />
    if (mode === 'edit') return <ProjectForm project={project} onDone={() => go(`#/m/projects/${project.id}`)} />
    return <ProjectDetail p={project} next={mode === 'next'} />
  }

  const scan = async () => {
    setScanning(true)
    try {
      await api('projects/scan', { method: 'POST' })
      refreshProjects()
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="sheet">
      <SheetHead id="projects">
        <ViewSwitch value={view} views={[['grid', 'Grid'], ['list', 'List']]} onChange={setView} />
        <a className="btn btn--quiet" href="#/m/projects/folders">
          <Icon name="folder" size={16} /> Folders
        </a>
        <a className="btn btn--quiet" href="#/m/projects/archived">
          Archived
        </a>
        <button className="btn btn--quiet" type="button" onClick={scan} disabled={scanning}>
          <Icon name="refresh" size={16} /> {scanning ? 'Scanning' : 'Rescan'}
        </button>
        <a className="btn" href="#/m/projects/new">
          <Icon name="plus" size={16} /> Add
        </a>
      </SheetHead>
      <ViewTabs at="projects" />
      <label className="filter">
        <Icon name="search" size={18} />
        <span className="sr-only">Filter projects</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, stack or tag" />
      </label>
      {!projects || (!roots.data && !roots.error) ? (
        <div className="sheet__empty">Loading projects…</div>
      ) : list.length === 0 ? (
        <div className="sheet__empty">
          {q ? (
            `Nothing matches “${q}”.`
          ) : (
            <>
              No projects yet. <a href="#/m/projects/folders">Add a folder</a> whose subfolders are projects, or <a href="#/m/projects/new">add one by hand</a>. Projects live on this Marumado: other machines are where they run.
            </>
          )}
        </div>
      ) : (
        groups.map((g, i) => {
          const line = groupLine(g, (p) => activity(p, tasks, agents))
          return (
            <section className="pgroup" key={g.key} aria-labelledby={`pg-${g.key}`}>
              <header className="pgroup__head">
                <h3 className="pgroup__title" id={`pg-${g.key}`}>
                  {g.path ? <Secret label={`Folder ${i + 1}`}>{g.title}</Secret> : g.title}
                </h3>
                <span className={`pgroup__line${line.fault ? ' signal-text' : ''}`}>
                  {g.missing ? 'Folder not found · ' : ''}
                  {line.text}
                </span>
              </header>
              {view === 'grid' ? (
                <ul className="cardgrid cardgrid--wide">
                  {g.projects.map((p) => (
                    <li className="itemcard itemcard--compact" key={p.id}>
                      <span className="itemcard__state">
                        <span className={lamp(p)} aria-hidden />
                        {stateLabel(p)}
                        <PinButton project={p} />
                      </span>
                      <a className="itemcard__name" href={`#/m/projects/${p.id}`}>
                        {p.name}
                      </a>
                      {work(p) ? (
                        <span className="itemcard__sub mod-tasks">{work(p)}</span>
                      ) : (
                        p.detected.last_commit_at && <span className="itemcard__sub">Last commit {ago(p.detected.last_commit_at)}</span>
                      )}
                      <Links p={p} />
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="list">
                  {g.projects.map((p) => (
                    <li className="row" key={p.id}>
                      <span className={lamp(p)} role="img" aria-label={stateLabel(p)} />
                      <a className="row__main row__link" href={`#/m/projects/${p.id}`}>
                        {p.name}
                        <span className="row__sub">{[(p.detected.stacks ?? []).join(' · ') || (p.source === 'manual' ? 'Added by hand' : 'Folder'), whereRunning(p), work(p)].filter(Boolean).join(' · ')}</span>
                      </a>
                      <Links p={p} />
                      <PinButton project={p} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })
      )}
    </div>
  )
}

/** The project's state in one line: where it runs, how it moves, the owner's call, and what needs you. */
function statusLine(p: Project, work: Activity): { text: string; fault: boolean } {
  if (p.kind === 'link') return { text: 'Link', fault: false }
  // What needs you first, then what is happening, then the record; "not running" only when nothing else is said.
  const state = pace(p)
  const live = p.status.online.latest
  const down = !!p.online_url && !!live && !live.ok
  const parts = [
    down ? 'Live site down' : '',
    work.blocked ? `${work.blocked} need${work.blocked === 1 ? 's' : ''} you` : '',
    work.working ? (work.working === 1 ? 'Agent working' : `${work.working} agents working`) : '',
    whereRunning(p) || (p.detected.missing ? 'Folder missing' : ''),
    state === 'none' ? '' : PACE_LABEL[state],
    p.focus === 'push' ? 'Pushed' : p.focus === 'park' ? 'Parked' : '',
  ].filter(Boolean)
  return { text: parts.join(' · ') || 'Not running', fault: work.blocked > 0 || down }
}

function ProjectDetail({ p, next }: { p: Project; next?: boolean }) {
  const { refreshProjects, tasks, agents } = useHub()
  const isLink = p.kind === 'link'
  const home = isLink ? '#/m/urls' : '#/m/projects'
  const work = activity(p, tasks, agents)
  const status = statusLine(p, work)
  const remove = async () => {
    await api(`projects/${p.id}`, { method: 'DELETE' })
    refreshProjects()
    go(home)
  }
  // A scanned project is archived (restorable, and a rescan won't bring it back); one added by hand is deleted.
  const archives = p.source === 'scan'

  return (
    <div className="sheet">
      <a className="side__back" href={home}>
        <Icon name="back" size={18} /> {isLink ? 'All URLs' : 'All projects'}
      </a>
      <header className="sheet__head">
        <div>
          <span className={`sheet__index${status.fault ? ' sheet__index--fault' : ''}`}>{status.text}</span>
          <h2 className="sheet__title">{p.name}</h2>
        </div>
        <div className="sheet__actions">
          {!isLink && <PinButton project={p} labelled />}
          {p.path && !p.detected.missing && (
            <a className="btn btn--quiet" href={`#/m/projects/${p.id}/files`}>
              <Icon name="file" size={16} /> Files
            </a>
          )}
          <a className="btn btn--quiet" href={`#/m/projects/${p.id}/edit`}>
            <Icon name="edit" size={16} /> Edit
          </a>
          <ConfirmButton onConfirm={remove} confirmLabel={archives ? 'Confirm archive' : 'Confirm delete'} title={archives ? 'Archive: out of every list until you restore it from Projects → Archived' : undefined}>
            {archives ? 'Archive' : 'Delete'}
          </ConfirmButton>
        </div>
      </header>

      {(p.description || p.local_url || p.suggested_local_url || p.online_url || p.repo_url || p.path) && (
        <div className="project__intro">
          {p.description && <p className="sheet__lede">{p.description}</p>}
          <Links p={p} />
        </div>
      )}

      <div className="project">
        <div className="project__grid">
          <div className="project__main">
            {!isLink && <Work p={p} focusNew={next} />}
            {!isLink && <Direction p={p} open={work.open} />}
            {isLink && <Response p={p} />}
          </div>
          {!isLink && (
            <aside className="project__aside" aria-label={`About ${p.name}`}>
              <Places p={p} />
              <Response p={p} />
              <ProjectSkills p={p} />
            </aside>
          )}
        </div>
      </div>

    </div>
  )
}

type WorkItem =
  | { kind: 'task'; key: string; rank: number; task: Task }
  | { kind: 'agent'; key: string; rank: number; agent: Agent }

const TASK_RANK: Record<TaskState, number> = { blocked: 0, failed: 0, working: 1, starting: 1, review: 2, todo: 3, queued: 3, done: 4 }
const AGENT_RANK: Record<Agent['status'], number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 3 }

/** Everything being done on the project, most urgent first: tasks and the agents in its folder in one list, the
    next task typed into its last line. */
function Work({ p, focusNew }: { p: Project; focusNew?: boolean }) {
  const { tasks, agents, refreshTasks } = useHub()
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const open = openTasks(p, tasks)
  const followed = new Set(open.filter((t) => t.live && t.pane_id).map((t) => `${t.agent_source}/${t.pane_id}`))
  // An agent already shown through its task isn't listed twice.
  const loose = projectAgents(p, agents).filter((a) => !followed.has(agentKey(a)))
  const agentState = (a: Agent) => (a.status === 'blocked' ? 'Needs you' : a.status === 'working' ? 'Working' : 'Resting')
  const items: WorkItem[] = [
    ...open.map((t): WorkItem => ({ kind: 'task', key: `t${t.id}`, rank: TASK_RANK[t.state], task: t })),
    ...loose.map((a): WorkItem => ({ kind: 'agent', key: `a${agentKey(a)}`, rank: AGENT_RANK[a.status] + 0.5, agent: a })),
  ].sort((a, b) => a.rank - b.rank)
  const done = (tasks ?? []).filter((t) => t.project === p.id && t.state === 'done').length
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    setAdding(true)
    setError('')
    try {
      await api<Task>('tasks', { method: 'POST', json: { title, project: p.id } })
      refreshTasks()
      setTitle('')
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add it.")
    } finally {
      setAdding(false)
    }
  }
  const count = [open.length ? `${open.length} open` : '', loose.length ? `${loose.length} agent${loose.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
  return (
    <section className="sheet__section mod-tasks" aria-labelledby="work-title">
      <h3 id="work-title">Work{count && ` · ${count}`}</h3>
      {p.focus === 'push' && tasks && !open.length && !loose.some((a) => a.status === 'working' || a.status === 'blocked') && <p className="notice">Marked push, with nothing to do next. Write the next step below.</p>}
      <ul className="list">
        {items.map((it) =>
          it.kind === 'task' ? (
            <li className="row" key={it.key}>
              <span className={taskLamp(it.task.state)} role="img" aria-label={TASK_STATE[it.task.state]} />
              <a className="row__main row__link" href={`#/m/tasks/${it.task.id}`}>
                {it.task.title}
                <span className={`row__sub${it.task.state === 'blocked' || it.task.state === 'failed' ? ' signal-text' : ''}`}>
                  {TASK_STATE[it.task.state]}
                  {it.task.live && it.task.agent_kind ? ` · ${it.task.agent_name || it.task.agent_kind}` : ''}
                  {it.task.live && it.task.agent_title && it.task.state === 'working' ? `: ${it.task.agent_title}` : ''}
                </span>
              </a>
            </li>
          ) : (
            <li className="row" key={it.key}>
              <span className={`row__lamp${it.agent.status === 'blocked' ? ' row__lamp--fault' : it.agent.status === 'working' ? ' row__lamp--on' : ''}`} role="img" aria-label={agentState(it.agent)} />
              <a className="row__main row__link" href={agentHref(it.agent)}>
                {it.agent.title && it.agent.title !== it.agent.kind ? it.agent.title : it.agent.name || it.agent.kind}
                <span className={`row__sub${it.agent.status === 'blocked' ? ' signal-text' : ''}`}>
                  {agentState(it.agent)} · {it.agent.kind}
                  {sourceLabel(agents, it.agent) ? ` on ${sourceLabel(agents, it.agent)}` : ''} · no task yet
                </span>
              </a>
            </li>
          ),
        )}
        <li className="row work__add">
          <form className="work__form" onSubmit={add}>
            <Icon name="plus" size={18} />
            <label className="sr-only" htmlFor={`next-${p.id}`}>
              Next task
            </label>
            <input
              id={`next-${p.id}`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={items.length ? 'Add the next task' : 'Nothing open. What is the next step?'}
              maxLength={200}
              autoFocus={focusNew}
            />
            {title.trim() && (
              <button className="btn" type="submit" disabled={adding}>
                {adding ? 'Adding' : 'Add'}
              </button>
            )}
          </form>
        </li>
      </ul>
      <StartAgent project={p} />
      {error && <p className="notice signal-text">{error}</p>}
      {done > 0 && (
        <a className="work__done" href="#/m/tasks">
          {done} done
        </a>
      )}
    </section>
  )
}

const FOCUS: { value: Project['focus']; label: string; says: string }[] = [
  { value: 'push', label: 'Push', says: 'It matters now: flagged if it goes 14 days without a commit or an agent on it.' },
  { value: '', label: 'Undecided', says: 'No call made yet.' },
  { value: 'park', label: 'Park', says: 'It can wait: no alerts, and open tasks stay put until you push it again.' },
]

/** Where the project is going: the owner's call, and its last 12 weeks of commits as the record under it. */
function Direction({ p, open }: { p: Project; open: number }) {
  const { refreshProjects } = useHub()
  const [busy, setBusy] = useState(false)
  const set = async (focus: Project['focus']) => {
    setBusy(true)
    try {
      await api(`projects/${p.id}`, { method: 'PATCH', json: { focus } })
      refreshProjects()
    } finally {
      setBusy(false)
    }
  }
  const state = pace(p)
  const total = commits(p.detected.weekly_commits)
  const current = FOCUS.find((f) => f.value === p.focus) ?? FOCUS[1]
  return (
    <section className="sheet__section mod-momentum" aria-labelledby="direction-title">
      <h3 id="direction-title">Direction</h3>
      <div className="direction__call">
        <div className="seg seg--mod" role="group" aria-label="Where this project is going">
          {FOCUS.map((f) => (
            <button key={f.label} type="button" className="seg__btn" aria-pressed={p.focus === f.value} disabled={busy} onClick={() => set(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
        <p className="direction__says">
          {current.says}
          {p.focus === 'park' && open > 0 ? ` ${open} open ${open === 1 ? 'task waits' : 'tasks wait'}.` : ''}
        </p>
      </div>
      {state !== 'none' && !p.detected.missing ? (
        <div className="direction__record">
          <RecordStrip weeks={p.detected.weekly_commits ?? []} label={p.name} />
          <dl className="facts">
            <dt>Pace</dt>
            <dd>
              {PACE_LABEL[state]} · {total} {total === 1 ? 'commit' : 'commits'} in 12 weeks
            </dd>
            {p.detected.last_commit && (
              <>
                <dt>Last commit</dt>
                <dd className="mono">
                  {p.detected.last_commit} · {ago(p.detected.last_commit_at)}
                </dd>
              </>
            )}
            {p.detected.branch && (
              <>
                <dt>Branch</dt>
                <dd className="mono">
                  {p.detected.branch}
                  {p.detected.dirty_files ? ` · ${p.detected.dirty_files} uncommitted` : ' · clean'}
                </dd>
              </>
            )}
          </dl>
        </div>
      ) : (
        <p className="sheet__lede">{p.detected.missing ? 'Its folder is missing, so there is no record to read.' : 'No git history, so its pace can’t be read.'}</p>
      )}
    </section>
  )
}

/** Twelve weeks of commits as a strip chart: one bar per week (square root, so one big week doesn't flatten the
    rest), a hairline where a week had none. */
function RecordStrip({ weeks, label }: { weeks: number[]; label: string }) {
  const n = 12
  const values = Array.from({ length: n }, (_, i) => weeks[weeks.length - n + i] ?? 0)
  const top = Math.max(1, ...values)
  const total = commits(values)
  const W = 120
  const H = 48
  const slot = W / n
  return (
    <div className="record">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}: ${total} ${total === 1 ? 'commit' : 'commits'} in the last 12 weeks`}>
        <line className="record__rule" x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} />
        {values.map((v, i) => {
          const h = v ? 4 + Math.sqrt(v / top) * (H - 6) : 1.5
          const ago = n - 1 - i
          return (
            <rect key={i} className={v ? 'record__bar' : 'record__none'} x={i * slot + slot * 0.2} y={H - h} width={slot * 0.6} height={h}>
              <title>{`${v} ${v === 1 ? 'commit' : 'commits'}, ${ago ? `${ago} week${ago === 1 ? '' : 's'} ago` : 'this week'}`}</title>
            </rect>
          )
        })}
      </svg>
      <span className="record__axis" aria-hidden="true">
        <span>−12 wk</span>
        <span>now</span>
      </span>
    </div>
  )
}

/** Where the project is: its folder here, and every machine whose Marumado reports it running. */
function Places({ p }: { p: Project }) {
  const { select } = useMachines()
  const local = p.runtime.ports.length > 0 || p.runtime.containers.length > 0
  const elsewhere = p.places ?? []
  // A machine's containers live in its Docker module: show that machine, then open it.
  const openOn = (machine: MachineId, module: ModuleId) => {
    select(machine)
    go(moduleHref(module))
  }
  const what = (ports: number[], containers: { status: string }[]) => {
    const up = containers.filter((c) => c.status === 'running').length
    return [ports.length ? ports.map((x) => `:${x}`).join(' ') : '', containers.length ? `${up}/${containers.length} containers` : ''].filter(Boolean).join(' · ')
  }
  const [copied, setCopied] = useState(false)
  const canCopy = !!p.path && !!navigator.clipboard
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])
  const copy = () => navigator.clipboard.writeText(p.path).then(() => setCopied(true), () => {})
  return (
    <section className="sheet__section mod-machines" aria-labelledby="places-title">
      <h3 id="places-title">Where it runs</h3>
      <ul className="list list--compact">
        {(p.path || local) && (
          <li className="row">
            <span className={`row__lamp${p.running ? ' row__lamp--on' : ''}`} role="img" aria-label={p.running ? 'running' : 'not running'} />
            <span className="row__main">
              This machine
              <span className="row__sub">{local ? what(p.runtime.ports.map((x) => x.port), p.runtime.containers) : p.detected.missing ? 'Folder missing' : 'Not running'}</span>
              {p.path && (
                <span className="row__sub mono" aria-live="polite">
                  {copied ? 'Path copied' : <Secret label="Path">{p.path}</Secret>}
                </span>
              )}
            </span>
            {canCopy && (
              <button className="go" type="button" onClick={copy} aria-label="Copy folder path" title="Copy folder path">
                <Icon name="copy" size={18} />
              </button>
            )}
            {local && (
              <button className="go" type="button" onClick={() => openOn('local', p.runtime.containers.length ? 'docker' : 'ports')} aria-label="Show what runs here">
                <Icon name="arrow" size={20} />
              </button>
            )}
          </li>
        )}
        {elsewhere.map((x) => (
          <li className="row" key={`${x.machine}:${x.dir}:${x.compose}`}>
            <span className={`row__lamp${x.running ? ' row__lamp--on' : ''}`} role="img" aria-label={x.running ? 'running' : 'not running'} />
            <span className="row__main">
              {x.machine_name}
              <span className="row__sub">{what(x.ports, x.containers) || 'Not running'}</span>
              <span className="row__sub mono">{x.dir ? <Secret label="Path">{x.dir}</Secret> : `compose ${x.compose}`}</span>
            </span>
            <button className="go" type="button" onClick={() => openOn(x.machine, x.containers.length ? 'docker' : 'ports')} aria-label={`Show what runs on ${x.machine_name}`}>
              <Icon name="arrow" size={20} />
            </button>
          </li>
        ))}
      </ul>
      {!elsewhere.length && (
        <p className="project__hint">
          Runs on a server too? Add it under <a href="#/m/machines">Machines</a> and its containers named like this project show up here.
        </p>
      )}
    </section>
  )
}

/** Is it up: the live (then local) URL's response time over its last checks. */
function Response({ p }: { p: Project }) {
  const { refreshProjects } = useHub()
  const [checking, setChecking] = useState(false)
  const shown = (['online', 'local'] as const).filter((t) => p.status[t].latency.length && p.status[t].uptime_percent != null)
  if (!p.online_url && !p.local_url) return null
  const check = async () => {
    setChecking(true)
    try {
      await api(`projects/${p.id}/check`, { method: 'POST' })
      refreshProjects()
    } finally {
      setChecking(false)
    }
  }
  return (
    <section className="sheet__section mod-urls" aria-labelledby="response-title">
      <h3 id="response-title">Response</h3>
      {shown.map((t) => (
        <div className="response" key={t}>
          <p className="response__head">
            {t === 'online' ? 'Live' : 'Local'} <span className="mono">{hostOf(t === 'online' ? p.online_url : p.local_url)}</span>
            <span className="mono">{p.status[t].uptime_percent}% up</span>
          </p>
          <DotChart values={p.status[t].latency} tone={p.status[t].latest?.ok === false ? 'signal' : 'ink'} height={56} label={`${t} latency`} unit=" ms" span={`${p.status[t].latency.length} min`} />
        </div>
      ))}
      {!shown.length && <p className="project__hint">Checked every minute; the first results show up here shortly.</p>}
      <button className="btn btn--quiet" type="button" onClick={check} disabled={checking}>
        <Icon name="refresh" size={16} /> {checking ? 'Checking' : 'Check now'}
      </button>
    </section>
  )
}

/** The skills the project uses, each opening its page (where its plan and other projects are). */
function ProjectSkills({ p }: { p: Project }) {
  const { skills } = useHub()
  const intent = (n: string) => skills?.find((s) => s.name.toLowerCase() === n.toLowerCase())?.intent
  const names = [...new Set([...(p.detected.stacks ?? []), ...(p.detected.libs ?? [])])].filter((n) => intent(n) !== 'ignore')
  if (!names.length) return null
  return (
    <section className="sheet__section mod-skills" aria-labelledby="skills-title">
      <h3 id="skills-title">Made with</h3>
      <div className="chips">
        {names.map((n) => (
          <a className="chip" key={n} href={`#/m/projects/skills/${encodeURIComponent(n)}`}>
            {n}
            {intent(n) === 'learn' ? ' · learning' : intent(n) === 'grow' ? ' · growing' : ''}
          </a>
        ))}
      </div>
    </section>
  )
}

export function ProjectForm({ project, kind = project?.kind ?? 'project', onDone }: { project?: Project; kind?: Project['kind']; onDone: (id?: number) => void }) {
  const { refreshProjects } = useHub()
  const isLink = kind === 'link'
  const [form, setForm] = useState({
    name: project?.name ?? '',
    description: project?.description ?? '',
    local_url: project?.local_url ?? project?.suggested_local_url ?? '',
    online_url: project?.online_url ?? '',
    repo_url: project?.repo_url ?? '',
    tags: (project?.tags ?? []).join(', '),
    pinned: project?.pinned ?? false,
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const set = (k: keyof typeof form) => (e: { target: { value: string; checked?: boolean; type?: string } }) =>
    setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    const body = { ...form, kind, tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean) }
    try {
      const saved = await api<Project>(project ? `projects/${project.id}` : 'projects', { method: project ? 'PATCH' : 'POST', json: body })
      refreshProjects()
      onDone(saved.id)
    } catch (err) {
      setError(err instanceof Error ? `Couldn't save: ${err.message}. Check the URLs start with http:// or https://.` : "Couldn't save.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="sheet" onSubmit={submit}>
      <header className="sheet__head">
        <h2 className="sheet__title">{isLink ? (project ? 'Edit URL' : 'Add URL') : project ? 'Edit project' : 'Add project'}</h2>
      </header>
      {project?.source === 'scan' && (
        <p className="sheet__lede">Fields you change here are kept the next time folders are rescanned.</p>
      )}
      {isLink && !project && <p className="sheet__lede">Any site or service you want one click away. It is checked every minute and flagged when it goes down.</p>}
      <label className="field">
        Name
        <input required value={form.name} onChange={set('name')} placeholder={isLink ? 'Router admin' : undefined} />
      </label>
      {isLink && (
        <label className="field">
          URL
          <input required type="url" placeholder="https://example.com" value={form.online_url} onChange={set('online_url')} />
        </label>
      )}
      <label className="field">
        Description
        <textarea rows={2} value={form.description} onChange={set('description')} />
      </label>
      {!isLink && (
        <>
          <label className="field">
            Local URL
            <input type="url" placeholder="http://localhost:5173" value={form.local_url} onChange={set('local_url')} />
          </label>
          <label className="field">
            Live URL
            <input type="url" placeholder="https://example.com" value={form.online_url} onChange={set('online_url')} />
          </label>
          <label className="field">
            Repository URL
            <input type="url" placeholder="https://github.com/you/project" value={form.repo_url} onChange={set('repo_url')} />
          </label>
        </>
      )}
      <label className="field">
        Tags, comma separated
        <input value={form.tags} onChange={set('tags')} />
      </label>
      <label className="field field--check">
        <input type="checkbox" checked={form.pinned} onChange={set('pinned')} /> Pinned: at the top of Projects and in the sidebar
      </label>
      {error && <p className="notice signal-text">{error}</p>}
      <div className="sheet__actions" style={{ justifyContent: 'start' }}>
        <button className="btn" type="submit" disabled={saving}>
          {saving ? 'Saving' : project ? 'Save changes' : isLink ? 'Add URL' : 'Add project'}
        </button>
        <button className="btn btn--quiet" type="button" onClick={() => onDone(project?.id)}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** Projects archived (or hidden) out of every list: restore one and it comes back everywhere. */
function ArchivedSheet() {
  const { refreshProjects } = useHub()
  const [all, setAll] = useState<Project[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<number | null>(null)
  const load = () =>
    api<Project[]>('projects?hidden=1')
      .then((rows) => setAll(rows.filter((p) => p.hidden)))
      .catch((err) => setError(`Couldn't load them: ${err.message}`))
  useEffect(() => {
    load()
  }, [])
  const restore = async (p: Project) => {
    setBusy(p.id)
    setError('')
    try {
      await api(`projects/${p.id}`, { method: 'PATCH', json: { hidden: false } })
      refreshProjects()
      await load()
    } catch (err) {
      setError(err instanceof Error ? `Couldn't restore ${p.name}: ${err.message}` : "Couldn't restore it.")
    } finally {
      setBusy(null)
    }
  }
  const list = (all ?? []).sort((a, b) => a.name.localeCompare(b.name))
  return (
    <div className="sheet">
      <a className="side__back" href="#/m/projects">
        <Icon name="back" size={18} /> All projects
      </a>
      <header className="sheet__head">
        <h2 className="sheet__title">Archived</h2>
      </header>
      <p className="sheet__lede">Projects you archived or hid. They stay out of every list, alert and count until you restore them; rescans don't bring them back.</p>
      {error && <p className="notice signal-text">{error}</p>}
      {!all ? (
        !error && <div className="sheet__empty">Loading…</div>
      ) : list.length === 0 ? (
        <div className="sheet__empty">Nothing archived.</div>
      ) : (
        <ul className="list">
          {list.map((p) => (
            <li className="row" key={p.id}>
              <span className="row__lamp" aria-hidden />
              <span className="row__main">
                {p.name}
                <span className="row__sub">
                  {[p.kind === 'link' ? 'URL' : (p.detected.stacks ?? []).join(' · ') || 'Folder', p.detected.last_commit_at ? `last commit ${ago(p.detected.last_commit_at)}` : '', p.detected.missing ? 'folder missing' : '']
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span className="row__actions">
                <button className="btn" type="button" onClick={() => restore(p)} disabled={busy === p.id}>
                  {busy === p.id ? 'Restoring' : 'Restore'}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function FoldersSheet() {
  const { refreshProjects } = useHub()
  const [roots, setRoots] = useState<ScanRoot[] | null>(null)
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<{ roots: ScanRoot[] }>('roots')
      .then((d) => setRoots(d.roots))
      .catch((err) => setError(`Couldn't load folders: ${err.message}`))
  }, [])

  const change = async (req: Promise<{ roots: ScanRoot[] }>) => {
    setBusy(true)
    setError('')
    try {
      setRoots((await req).roots)
      refreshProjects()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the folders.")
      return false
    } finally {
      setBusy(false)
    }
  }
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (await change(api('roots', { method: 'POST', json: { path } }))) setPath('')
  }

  return (
    <form className="sheet" onSubmit={add}>
      <a className="side__back" href="#/m/projects">
        <Icon name="back" size={18} /> All projects
      </a>
      <header className="sheet__head">
        <h2 className="sheet__title">Scan folders</h2>
      </header>
      <p className="sheet__lede">Every folder inside these is a project. Adding or removing one rescans right away.</p>
      {!roots ? (
        !error && <div className="sheet__empty">Loading…</div>
      ) : (
        <ul className="list">
          {roots.map((r) => (
            <li className="row" key={r.path}>
              <Icon name="folder" size={20} />
              <span className="row__main mono">
                <Secret label="Path">{r.path}</Secret>
                <span className={`row__sub${r.found ? '' : ' signal-text'}`}>
                  {r.found ? `${r.projects} ${r.projects === 1 ? 'project' : 'projects'}` : 'Not found on this machine'}
                  {r.source === 'env' && ' · set in .env'}
                </span>
              </span>
              {r.found && <OpenFolder path={r.path} />}
              {r.id != null && (
                <ConfirmButton onConfirm={() => change(api(`roots/${r.id}`, { method: 'DELETE' })).then(() => {})} confirmLabel="Confirm remove" disabled={busy}>
                  Remove
                </ConfirmButton>
              )}
            </li>
          ))}
        </ul>
      )}
      <label className="field">
        Add a folder
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/me/code" spellCheck={false} autoCapitalize="off" autoCorrect="off" required />
      </label>
      {error && <p className="notice signal-text">{error}</p>}
      <div className="sheet__actions" style={{ justifyContent: 'start' }}>
        <button className="btn" type="submit" disabled={busy || !path.trim()}>
          {busy ? 'Scanning' : 'Add and scan'}
        </button>
      </div>
      <p className="sheet__lede">
        Removing a folder drops its projects, except ones you edited or pinned. Running in Docker? Marumado only sees folders mounted into it: list them in <span className="mono">MARUMADO_PROJECT_DIRS</span> or <span className="mono">MARUMADO_MOUNTS</span> in .env, then <span className="mono">make up</span>.
      </p>
    </form>
  )
}
