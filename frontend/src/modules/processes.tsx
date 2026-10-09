import { Fragment, useMemo, useState } from 'react'
import { ConfirmButton } from '../components/ConfirmButton'
import { DotChart } from '../components/DotChart'
import { Icon } from '../components/Icon'
import { Meter } from '../components/Meter'
import { api } from '../lib/api'
import { niceMax } from '../lib/chart'
import { ago, bytes, duration } from '../lib/format'
import { useHub } from '../lib/hub'
import { Secret } from '../lib/streaming'
import type { Proc, ProcApp, ProcDetail, ProcList, System } from '../lib/types'
import { usePoll } from '../lib/usePoll'
import { useView } from './growth'
import { SheetHead, ViewTabs } from './sheetHead'
import './processes.css'

type View = 'list' | 'tree' | 'apps'
type SortKey = 'pid' | 'count' | 'user' | 'cpu' | 'rss' | 'threads' | 'cpu_time' | 'name'
type Sort = { key: SortKey; desc: boolean }

/** Text columns read A to Z first; numbers heaviest first. */
const ASCENDING: SortKey[] = ['pid', 'user', 'name']
const SORT_KEY = 'marumado.process-sort'
const LIST_ROWS = 100

function useSort(): [Sort, (s: Sort) => void] {
  const [sort, setSort] = useState<Sort>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SORT_KEY) ?? 'null')
      if (saved && typeof saved.key === 'string' && typeof saved.desc === 'boolean') return saved
    } catch {
      /* fall through */
    }
    return { key: 'cpu', desc: true }
  })
  const set = (s: Sort) => {
    setSort(s)
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(s))
    } catch {
      /* not remembered in private mode */
    }
  }
  return [sort, set]
}

/** CPU time as htop prints it: 0:04.21, 12:30.05, 3:12:40, 140h. */
function cpuTime(s: number | undefined): string {
  if (s == null) return '—'
  if (s >= 360000) return `${Math.floor(s / 3600)}h`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(sec)).padStart(2, '0')}`
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`
}

const STATE_ORDER = ['running', 'sleeping', 'disk-sleep', 'idle', 'stopped', 'zombie']

/** The processes on this machine, as htop shows them: the machine's meters on top, then every process in a table
    that sorts by any column, as a tree under their parents, or one row per program. */
export function ProcessesSheet() {
  const { system } = useHub()
  const [view, setViewRaw] = useView<View>('marumado.process-view', ['list', 'tree', 'apps'] as const)
  const [sort, setSortRaw] = useSort()
  const [q, setQRaw] = useState('')
  const [kernel, setKernelRaw] = useState(false)
  const [all, setAll] = useState(false)
  const [paused, setPaused] = useState(false)
  const [open, setOpen] = useState<number | string | null>(null)
  const [folded, setFolded] = useState<Set<number>>(() => new Set())
  const [msg, setMsg] = useState('')

  // Asking for a different view of the table always shows it live.
  const live = <T,>(set: (v: T) => void) => (v: T) => {
    set(v)
    setPaused(false)
  }
  const setView = live(setViewRaw)
  const setSort = live(setSortRaw)
  const setQ = live(setQRaw)
  const setKernel = live(setKernelRaw)

  // pid and user mean nothing for a program; it sorts by its count instead.
  const key: SortKey = view === 'apps' ? (sort.key === 'pid' ? 'count' : sort.key === 'user' ? 'cpu' : sort.key) : sort.key === 'count' ? 'pid' : sort.key
  const params = new URLSearchParams({ view, sort: key, order: sort.desc ? 'desc' : 'asc', q })
  if (kernel) params.set('kernel', '1')
  if (view !== 'tree') params.set('limit', String(all ? 1000 : LIST_ROWS))
  const path = `processes?${params}`
  const { data, error, refresh } = usePoll<ProcList>(paused ? null : path, 2000)

  // An older Marumado on another machine only knows the list.
  const served: View = data?.view ?? 'list'
  const older = data && !data.view && view !== 'list'

  const kill = async (pid: number, force: boolean) => {
    setMsg('')
    try {
      await api(`processes/${pid}/kill`, { method: 'POST', json: { force } })
      setMsg(`Sent ${force ? 'SIGKILL' : 'SIGTERM'} to ${pid}.`)
      setOpen(null)
      refresh()
    } catch (e) {
      setMsg(e instanceof Error ? `Couldn't stop ${pid}: ${e.message}` : `Couldn't stop ${pid}.`)
    }
  }

  const clickSort = (k: SortKey) => setSort(k === key ? { key: k, desc: !sort.desc } : { key: k, desc: !ASCENDING.includes(k) })
  const fold = (pid: number) =>
    setFolded((f) => {
      const next = new Set(f)
      if (next.has(pid)) next.delete(pid)
      else next.add(pid)
      return next
    })

  const shown = data?.processes?.length ?? data?.apps?.length ?? 0

  return (
    <div className="sheet procs mod-processes">
      <SheetHead id="machine">
        <button
          className={`btn${paused ? '' : ' btn--quiet'}`}
          type="button"
          onClick={() => setPaused(!paused)}
          aria-pressed={paused}
          title={paused ? 'Update the table again' : 'Hold the table still, so rows stop moving while you read them'}
        >
          <Icon name={paused ? 'play' : 'pause'} size={16} /> {paused ? 'Resume' : 'Pause'}
        </button>
      </SheetHead>
      <ViewTabs at="processes" />

      {system && <Meters s={system} />}

      <div className="procs__bar">
        <label className="filter procs__filter">
          <Icon name="search" size={18} />
          <span className="sr-only">Filter processes</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, command, user or pid" />
          {data && (
            <span className="mono" title={`${data.total} matching`}>
              {data.total}
            </span>
          )}
        </label>
        <div className="seg seg--mod" role="group" aria-label="Show processes">
          {(
            [
              ['list', 'List', 'Every process, heaviest first'],
              ['tree', 'Tree', 'Processes under the ones that started them'],
              ['apps', 'By program', 'One row per program, its processes added up'],
            ] as const
          ).map(([v, label, title]) => (
            <button key={v} type="button" className="seg__btn" aria-pressed={view === v} onClick={() => setView(v)} title={title}>
              {label}
            </button>
          ))}
        </div>
        {(system?.tasks?.kernel ?? 0) > 0 && (
          <button
            className={`btn btn--quiet procs__toggle${kernel ? ' is-on' : ''}`}
            type="button"
            aria-pressed={kernel}
            onClick={() => setKernel(!kernel)}
            title="Linux kernel threads: housekeeping of the kernel itself, rarely what you are looking for"
          >
            Kernel threads
          </button>
        )}
      </div>

      {msg && <p className="notice">{msg}</p>}
      {older && <p className="notice">This machine runs an older Marumado, which only lists processes. Update it for the tree and the programs.</p>}
      {paused && <p className="procs__paused mono">Paused · the table holds still until you resume</p>}

      {!data ? (
        error ? (
          <p className="notice">Couldn’t read the processes: {error.message}</p>
        ) : (
          <div className="sheet__empty">Loading…</div>
        )
      ) : shown === 0 ? (
        <div className="sheet__empty">{q ? `No process matches “${q}”.` : 'No processes to show.'}</div>
      ) : (
        <div className="ptable-wrap">
          <table className={`ptable ptable--${served}`}>
            <thead>
              <tr>
                <Th k={served === 'apps' ? 'count' : 'pid'} label={served === 'apps' ? 'Count' : 'PID'} sort={sort} active={key} onSort={clickSort} />
                <Th k="user" label="User" sort={sort} active={key} onSort={clickSort} opt disabled={served === 'apps'} />
                <Th k="cpu" label="CPU" sort={sort} active={key} onSort={clickSort} />
                <Th k="rss" label="Memory" sort={sort} active={key} onSort={clickSort} />
                <Th k="threads" label="Threads" sort={sort} active={key} onSort={clickSort} opt />
                <Th k="cpu_time" label="CPU time" sort={sort} active={key} onSort={clickSort} opt />
                <Th k="name" label={served === 'apps' ? 'Program' : 'Command'} sort={sort} active={key} onSort={clickSort} wide />
              </tr>
            </thead>
            <tbody>
              {served === 'apps'
                ? data.apps!.map((a) => (
                    <AppRows
                      key={a.name}
                      app={a}
                      open={open === `app:${a.name}`}
                      onToggle={() => setOpen(open === `app:${a.name}` ? null : `app:${a.name}`)}
                      query={{ sort: key === 'count' ? 'cpu' : key, desc: sort.desc, kernel, paused }}
                      openPid={typeof open === 'number' ? open : null}
                      onKill={kill}
                    />
                  ))
                : (served === 'tree' ? visibleTree(data.processes!, folded) : data.processes!.map((p) => ({ p, guide: '' }))).map(({ p, guide }) => (
                    <ProcRows
                      key={p.pid}
                      p={p}
                      guide={guide}
                      tree={served === 'tree'}
                      folded={folded.has(p.pid)}
                      onFold={() => fold(p.pid)}
                      open={open === p.pid}
                      onToggle={() => setOpen(open === p.pid ? null : p.pid)}
                      onKill={kill}
                    />
                  ))}
            </tbody>
          </table>
        </div>
      )}
      {data && served === 'list' && data.total > shown && !all && (
        <p className="procs__more">
          <span className="mono">
            {shown} of {data.total}
          </span>
          <button className="btn btn--quiet" type="button" onClick={() => setAll(true)}>
            Show all
          </button>
        </p>
      )}
      {served === 'apps' && (
        <p className="procs__note">A program’s memory adds up each of its processes, so memory they share is counted more than once.</p>
      )}
    </div>
  )
}

function Th({ k, label, sort, active, onSort, opt, wide, disabled }: { k: SortKey; label: string; sort: Sort; active: SortKey; onSort: (k: SortKey) => void; opt?: boolean; wide?: boolean; disabled?: boolean }) {
  const on = active === k
  return (
    <th
      scope="col"
      className={`ptable__h ptable__h--${k}${opt ? ' ptable__opt' : ''}${wide ? ' ptable__wide' : ''}`}
      aria-sort={on ? (sort.desc ? 'descending' : 'ascending') : undefined}
    >
      {disabled ? (
        <span className="ptable__sort is-off">{label}</span>
      ) : (
        <button type="button" className={`ptable__sort${on ? ' is-on' : ''}`} onClick={() => onSort(k)} title={`Sort by ${label.toLowerCase()}`}>
          {label}
          {on && <Icon name={sort.desc ? 'down' : 'up'} size={12} />}
        </button>
      )}
    </th>
  )
}

/** The tree's rows that aren't under a folded branch, each with its guide lines (│ ├─ └─). */
function visibleTree(rows: Proc[], folded: Set<number>): { p: Proc; guide: string }[] {
  // Last among its siblings: no later row at its depth before the tree climbs above it.
  const last: boolean[] = Array(rows.length)
  const later: boolean[] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    const d = rows[i].depth ?? 0
    last[i] = !later[d]
    later[d] = true
    later.length = d + 1
  }
  const out: { p: Proc; guide: string }[] = []
  const more: boolean[] = [] // whether the ancestor at each depth has siblings still to come
  let hideBelow = Infinity
  rows.forEach((p, i) => {
    const d = p.depth ?? 0
    more[d] = !last[i]
    if (d > hideBelow) return
    hideBelow = folded.has(p.pid) ? d : Infinity
    let guide = ''
    for (let k = 1; k < d; k++) guide += more[k] ? '│ ' : '  '
    if (d > 0) guide += last[i] ? '└─' : '├─'
    out.push({ p, guide })
  })
  return out
}

const COLS = 7

function CpuCell({ cpu, branch, under }: { cpu: number; branch?: number; under?: number }) {
  const v = branch ?? cpu
  // In the tree, a parent's groove also shows, paler, what everything under it uses.
  const below = under != null && under - cpu >= 0.5 ? under : null
  return (
    <td
      className="ptable__num ptable__cpu"
      title={branch != null || below != null ? `${cpu.toFixed(1)}% itself, ${(branch ?? below!).toFixed(1)}% with everything under it` : `${cpu.toFixed(1)}% of one core`}
    >
      <span className="ptable__val">{v.toFixed(1)}%</span>
      <span className="pbar" aria-hidden="true">
        {below != null && <span className="pbar__fill pbar__fill--branch" style={{ width: `${Math.min(100, below)}%` }} />}
        <span className="pbar__fill" style={{ width: `${Math.min(100, v)}%` }} />
      </span>
    </td>
  )
}

function MemCell({ rss, percent, branch }: { rss: number; percent: number; branch?: number }) {
  return (
    <td className="ptable__num" title={branch != null ? `${bytes(rss)} itself, ${bytes(branch)} with everything under it` : `${percent.toFixed(1)}% of memory`}>
      <span className="ptable__val">{bytes(branch ?? rss)}</span> <span className="ptable__dim">{percent.toFixed(1)}%</span>
    </td>
  )
}

type RowProps = {
  p: Proc
  guide?: string
  tree?: boolean
  folded?: boolean
  onFold?: () => void
  nested?: boolean
  open: boolean
  onToggle: () => void
  onKill: (pid: number, force: boolean) => void
}

function ProcRows({ p, guide = '', tree, folded, onFold, nested, open, onToggle, onKill }: RowProps) {
  // A folded branch carries the weight of everything under it.
  const branch = tree && folded && p.children
  const state = p.status === 'running' ? 'on' : p.status === 'zombie' ? 'fault' : 'off'
  return (
    <>
      <tr className={`ptable__row${open ? ' is-open' : ''}${p.match === false ? ' is-context' : ''}${nested ? ' is-nested' : ''}`} onClick={onToggle}>
        <td className="ptable__num ptable__pid">
          <span className={`plamp plamp--${state}`} title={p.status} />
          {p.pid}
        </td>
        <td className="ptable__opt ptable__user">
          <Secret label="User">{p.user || '—'}</Secret>
        </td>
        <CpuCell cpu={p.cpu} branch={branch ? p.tree_cpu : undefined} under={tree && p.children ? p.tree_cpu : undefined} />
        <MemCell rss={p.rss} percent={p.mem_percent} branch={branch ? p.tree_rss : undefined} />
        <td className="ptable__num ptable__opt">{p.threads}</td>
        <td className="ptable__num ptable__opt">{cpuTime(p.cpu_time)}</td>
        <td className="ptable__wide ptable__cmd">
          {guide && <span className="ptable__guide" aria-hidden="true">{guide}</span>}
          {tree && (p.children ?? 0) > 0 ? (
            <button
              type="button"
              className={`ptable__fold${folded ? ' is-folded' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                onFold?.()
              }}
              aria-expanded={!folded}
              title={folded ? `Show its ${p.children} children` : 'Fold its children away'}
            >
              <Icon name="chevron" size={14} />
              <span className="sr-only">{folded ? 'Unfold' : 'Fold'}</span>
            </button>
          ) : (
            tree && <span className="ptable__fold-gap" />
          )}
          <button
            type="button"
            className="ptable__name"
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
          >
            {p.name}
          </button>
          {folded && p.children ? <span className="ptable__dim"> +{p.children}</span> : null}
          {p.project && <span className="ptable__project">{p.project.name}</span>}
          <span className="ptable__args">
            <Secret label="Command">{argsOf(p)}</Secret>
          </span>
        </td>
      </tr>
      {open && (
        <tr className="ptable__detail">
          <td colSpan={COLS}>
            <ProcPanel row={p} onKill={onKill} />
          </td>
        </tr>
      )}
    </>
  )
}

/** The command line without the program's own path, when it starts with it: what tells two pythons apart. */
function argsOf(p: { name: string; cmdline: string }): string {
  const cmd = p.cmdline
  if (!cmd) return ''
  const first = cmd.split(' ', 1)[0]
  if (first === p.name || first.endsWith(`/${p.name}`)) return cmd.slice(first.length).trim() || first
  return cmd
}

type AppQuery = { sort: SortKey; desc: boolean; kernel: boolean; paused: boolean }

function AppRows({ app: a, open, onToggle, query, openPid, onKill }: { app: ProcApp; open: boolean; onToggle: () => void; query: AppQuery; openPid: number | null; onKill: (pid: number, force: boolean) => void }) {
  return (
    <>
      <tr className={`ptable__row ptable__app${open ? ' is-open' : ''}`} onClick={onToggle}>
        <td className="ptable__num">{a.count}</td>
        <td className="ptable__opt ptable__user">
          <Secret label="User">{a.users.join(', ') || '—'}</Secret>
        </td>
        <CpuCell cpu={a.cpu} />
        <MemCell rss={a.rss} percent={a.mem_percent} />
        <td className="ptable__num ptable__opt">{a.threads}</td>
        <td className="ptable__num ptable__opt">{cpuTime(a.cpu_time)}</td>
        <td className="ptable__wide ptable__cmd">
          <span className={`ptable__fold${open ? '' : ' is-folded'}`} aria-hidden="true">
            <Icon name="chevron" size={14} />
          </span>
          <button
            type="button"
            className="ptable__name"
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
          >
            {a.name}
          </button>
          {a.project && <span className="ptable__project">{a.project.name}</span>}
          <span className="ptable__args">{a.count === 1 ? <Secret label="Command">{argsOf(a)}</Secret> : `${a.count} processes`}</span>
        </td>
      </tr>
      {open && <AppProcs name={a.name} query={query} openPid={openPid} onKill={onKill} />}
    </>
  )
}

/** A program's own processes, under its row. */
function AppProcs({ name, query, openPid, onKill }: { name: string; query: AppQuery; openPid: number | null; onKill: (pid: number, force: boolean) => void }) {
  const [open, setOpen] = useState<number | null>(openPid)
  const params = new URLSearchParams({ name, sort: query.sort, order: query.desc ? 'desc' : 'asc', limit: '200' })
  if (query.kernel) params.set('kernel', '1')
  const { data } = usePoll<ProcList>(query.paused ? null : `processes?${params}`, 2000)
  if (!data?.processes)
    return (
      <tr className="ptable__row is-nested">
        <td colSpan={COLS} className="ptable__dim">
          Loading…
        </td>
      </tr>
    )
  return (
    <>
      {data.processes.map((p) => (
        <ProcRows key={p.pid} p={p} nested open={open === p.pid} onToggle={() => setOpen(open === p.pid ? null : p.pid)} onKill={onKill} />
      ))}
    </>
  )
}

/** One process up close: its CPU and memory over the last few minutes, everything known about it, and Stop. */
function ProcPanel({ row, onKill }: { row: Proc; onKill: (pid: number, force: boolean) => void }) {
  const { data: d, error } = usePoll<ProcDetail>(`processes/${row.pid}`, 2000)
  const history = d?.history ?? []
  const span = history.length > 1 ? duration(Math.max(60, history[history.length - 1].t - history[0].t)) : undefined
  const cmd = d ? (Array.isArray(d.cmdline) ? d.cmdline.join(' ') : d.cmdline) : row.cmdline
  const p = { ...row, ...(d ?? {}) }
  const gone = error && 'status' in error && error.status === 404
  return (
    <div className="ppanel">
      {gone ? (
        <p className="ptable__dim">This process has ended.</p>
      ) : (
        history.length > 1 && (
          <div className="ppanel__charts">
            <section>
              <h4 className="ppanel__h">
                CPU <span className="mono">{p.cpu.toFixed(1)}%</span>
              </h4>
              <DotChart values={history.map((h) => h.cpu)} max={niceMax(Math.max(10, ...history.map((h) => h.cpu)))} height={44} label={`CPU of ${row.name}`} unit="%" span={span} />
            </section>
            <section>
              <h4 className="ppanel__h">
                Memory <span className="mono">{bytes(p.rss)}</span>
              </h4>
              <DotChart values={history.map((h) => h.rss / 1048576)} height={44} label={`Memory of ${row.name}, in MB`} unit=" MB" span={span} />
            </section>
          </div>
        )
      )}
      <dl className="facts ppanel__facts">
        <dt>Command</dt>
        <dd>
          <Secret label="Command">{cmd || '—'}</Secret>
        </dd>
        {d?.exe && (
          <>
            <dt>Program</dt>
            <dd>
              <Secret label="Program">{d.exe}</Secret>
            </dd>
          </>
        )}
        <dt>Folder</dt>
        <dd>
          <Secret label="Folder">{row.cwd || '—'}</Secret>
          {row.project && (
            <>
              {' '}
              · <a href={`#/m/projects/${row.project.id}`}>{row.project.name}</a>
            </>
          )}
        </dd>
        <dt>Started</dt>
        <dd>
          {ago(row.started)} · {cpuTime(p.cpu_time)} of CPU time
        </dd>
        <dt>Runs as</dt>
        <dd>
          <Secret label="User">{row.user || '—'}</Secret> · {row.status}
          {p.nice !== '' && p.nice != null ? ` · nice ${p.nice}` : ''} · {row.threads} threads
        </dd>
        <dt>Family</dt>
        <dd>
          parent {row.ppid}
          {d?.children ? ` · ${d.children.length} ${d.children.length === 1 ? 'child' : 'children'}` : ''}
        </dd>
        {(d?.fds != null || d?.io || d?.vms != null) && (
          <>
            <dt>Resources</dt>
            <dd>
              {[
                d?.vms != null && `${bytes(d.vms)} virtual`,
                d?.fds != null && `${d.fds} open files`,
                d?.io && `${bytes(d.io.read)} read · ${bytes(d.io.write)} written`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </dd>
          </>
        )}
      </dl>
      {!gone && (
        <div className="chips">
          <ConfirmButton className="chip" confirmLabel={`Confirm stop ${row.pid}`} onConfirm={() => onKill(row.pid, false)}>
            Stop (SIGTERM)
          </ConfirmButton>
          <ConfirmButton className="chip" confirmLabel={`Confirm kill ${row.pid}`} onConfirm={() => onKill(row.pid, true)}>
            Force kill
          </ConfirmButton>
        </div>
      )}
    </div>
  )
}

/** htop's header: every core's load, memory split into what programs hold and what the kernel caches, swap, and
    the tasks, load and uptime line. */
function Meters({ s }: { s: System }) {
  const m = s.memory
  const cached = Math.min(m.cached ?? 0, Math.max(0, m.total - m.used))
  const share = (n: number) => `${(n / m.total) * 100}%`
  const states = useMemo(() => {
    const st = s.tasks?.states ?? {}
    return Object.entries(st)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => (STATE_ORDER.indexOf(a) + 1 || 99) - (STATE_ORDER.indexOf(b) + 1 || 99))
  }, [s.tasks])
  return (
    <section className="pmeters" aria-label="Machine load">
      <div className="pmeters__cpu">
        <header className="chan__head">
          <h3>CPU</h3>
          <span className="chan__value">{Math.round(s.cpu.percent)}%</span>
          <span className="chan__aside">
            {s.cpu.per_core.length} cores{s.cpu.freq_mhz ? ` · ${(s.cpu.freq_mhz / 1000).toFixed(1)} GHz` : ''}
          </span>
        </header>
        <ol className="pcores">
          {s.cpu.per_core.map((c, i) => (
            <li key={i} className="pcore" title={`Core ${i}: ${Math.round(c)}%`}>
              <span className="pcore__n">{i}</span>
              <Meter percent={c} label={`Core ${i}`} />
              <span className="pcore__v">{Math.round(c)}%</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="pmeters__mem">
        <header className="chan__head">
          <h3>Memory</h3>
          <span className={`chan__value${m.percent >= 92 ? ' signal-text' : ''}`}>{Math.round(m.percent)}%</span>
          <span className="chan__aside">
            {bytes(m.used)} of {bytes(m.total)}
          </span>
        </header>
        <span className="pmem" role="meter" aria-label="Memory in use" aria-valuenow={Math.round(m.percent)} aria-valuemin={0} aria-valuemax={100}>
          <span className={`pmem__used${m.percent >= 92 ? ' is-fault' : ''}`} style={{ width: share(m.used) }} />
          {cached > 0 && <span className="pmem__cache" style={{ width: share(cached) }} />}
        </span>
        <ul className="pmem__key">
          <li>
            <span className="pkey pkey--used" /> {bytes(m.used)} in use
          </li>
          {cached > 0 && (
            <li title="Files the kernel keeps in memory to read them faster; it gives this back as soon as a program needs it">
              <span className="pkey pkey--cache" /> {bytes(cached)} cache
            </li>
          )}
          <li>
            <span className="pkey" /> {bytes(m.available)} available
          </li>
        </ul>
        {m.swap_total > 0 && (
          <div className="gauge">
            <span className="gauge__name">Swap</span>
            <Meter percent={m.swap_percent} label="Swap in use" />
            <span className="gauge__value">
              {bytes(m.swap_used)} of {bytes(m.swap_total)}
            </span>
          </div>
        )}
      </div>

      <dl className="specs pmeters__specs">
        <div>
          <dt>Tasks</dt>
          <dd>
            {s.tasks?.total ?? s.process_count ?? '—'}
            {s.tasks ? ` · ${s.tasks.threads} threads` : ''}
          </dd>
        </div>
        {states.length > 0 && (
          <div>
            <dt>States</dt>
            <dd>
              {states.map(([name, n], i) => (
                <Fragment key={name}>
                  {i > 0 && ' · '}
                  {n} {name}
                </Fragment>
              ))}
            </dd>
          </div>
        )}
        <div>
          <dt>Load</dt>
          <dd title="Processes running or waiting for a core, averaged over 1, 5 and 15 minutes">{s.cpu.load.map((l) => l.toFixed(2)).join(' ')}</dd>
        </div>
        <div>
          <dt>Up</dt>
          <dd>{duration(s.time - s.host.boot_time)}</dd>
        </div>
      </dl>
    </section>
  )
}
