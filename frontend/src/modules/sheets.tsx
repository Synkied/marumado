import { useLayoutEffect, useRef, useState } from 'react'
import { AgentChangesModal } from './agentChanges'
import { Terminal } from '../components/Terminal'
import { ConfirmButton } from '../components/ConfirmButton'
import { DotChart } from '../components/DotChart'
import { CountBadge } from '../components/CountBadge'
import { Icon } from '../components/Icon'
import { Meter } from '../components/Meter'
import { agentHref, agentKey, findWorkspace, parseAgentRef, sourceLabel, sourceOf, sourceQuery, sourcesOf, useWorkspace, workspaceLabel } from '../lib/agents'
import { api } from '../lib/api'
import { bytes, duration, rate } from '../lib/format'
import { useHub } from '../lib/hub'
import { useMachines } from '../lib/machines'
import { Redacted, Secret, useRedact } from '../lib/streaming'
import { go, type Route } from '../lib/route'
import type { Agent, AgentSource, AgentStatus, Container, Proc, ProjectRef } from '../lib/types'
import { useIsNarrow } from '../lib/useIsNarrow'
import { usePoll } from '../lib/usePoll'
import { MomentumSheet, SkillsSheet, useView, ViewSwitch } from './growth'
import { AgentInbox } from './agentInbox'
import { AgentSourcesSheet } from './agentSources'
import { MachinesSheet } from './machines'
import { Fleet } from './fleet'
import { ProjectForm, ProjectsSheet } from './projects'
import { SheetHead, ViewTabs } from './sheetHead'
import { TasksSheet } from './tasks'
import { PlansModal } from './planModal'
import { WorkspaceBar } from './workspaces'

export function SheetFor({ route }: { route: Route }) {
  if (route.kind === 'alerts') return <AlertsSheet />
  if (route.kind === 'home') return <Fleet />
  if (route.kind !== 'module') return null
  switch (route.id) {
    case 'projects':
      if (route.sub === 'momentum') return <MomentumSheet />
      if (route.sub === 'skills' || route.sub?.startsWith('skills/')) {
        const skill = route.sub.slice('skills/'.length) || undefined
        return <SkillsSheet sub={skill} key={skill ?? 'list'} />
      }
      return <ProjectsSheet sub={route.sub} key={route.sub ?? 'list'} />
    case 'machine':
      if (route.sub === 'processes') return <ProcessesSheet />
      if (route.sub === 'ports') return <PortsSheet />
      if (route.sub === 'docker') return <DockerSheet />
      return <MachineSheet />
    case 'urls':
      return route.sub === 'new' ? <ProjectForm kind="link" onDone={() => go('#/m/urls')} /> : <UrlsSheet />
    case 'agents':
      return <AgentsSheet sub={route.sub} />
    case 'tasks':
      return <TasksSheet sub={route.sub} key={route.sub ?? 'list'} />
    // Read as tabs of Projects and Machine (VIEW_OF): the route never lands on them.
    case 'momentum':
    case 'skills':
    case 'processes':
    case 'ports':
    case 'docker':
      return null
    case 'machines':
      return <MachinesSheet sub={route.sub} />
  }
}

function AlertsSheet() {
  const { alerts, system, error } = useHub()
  const { currentMachine, machines, current, select } = useMachines()
  const targets = (machines ?? []).map((m) => m.ssh_target)
  return (
    <div className="sheet">
      <header className="sheet__head">
        <h2 className="sheet__title">{alerts.length ? 'Needs you' : 'All clear'}</h2>
      </header>
      {error && !system && currentMachine && !currentMachine.local ? (
        <p className="notice">
          <strong>{currentMachine.name} isn’t answering.</strong> <Redacted text={error.message} secrets={targets} /> <a href="#/m/machines">Machines</a>
        </p>
      ) : error && !system ? (
        <p className="notice">
          <strong>The Marumado backend isn’t answering.</strong> Start it with <span className="mono">uv run python manage.py serve</span> in{' '}
          <span className="mono">backend/</span>, then this page reconnects by itself.
        </p>
      ) : alerts.length === 0 ? (
        <p className="sheet__lede">Nothing needs attention. Live sites are up, and disk and memory are within budget.</p>
      ) : (
        <ul className="list">
          {alerts.map((a) => (
            <li className="row" key={a.id}>
              <span className="row__lamp row__lamp--fault" role="img" aria-label="fault" />
              <span className="row__main">
                <Redacted text={a.title} secrets={targets} />
                <span className="row__sub">
                  <Redacted text={a.detail} secrets={targets} />
                </span>
              </span>
              <a
                className="go"
                href={a.href}
                aria-label={`Go to ${a.module}`}
                onClick={(e) => {
                  // Another machine's issue: show that machine first, so the link lands on its module.
                  if (a.machine === undefined || a.machine === current) return
                  e.preventDefault()
                  select(a.machine)
                  go(a.href)
                }}
              >
                <Icon name="arrow" size={20} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function MachineSheet() {
  const { system: s, history } = useHub()
  if (!s) return <div className="sheet__empty">Reading the machine…</div>
  const span = history.length > 1 ? `${Math.max(1, Math.round((history[history.length - 1].t - history[0].t) / 60))} min` : undefined
  return (
    <div className="sheet">
      <SheetHead id="machine" />
      <ViewTabs at="machine" />
      <p className="sheet__lede">
        <Secret label="Host name">{s.host.hostname}</Secret> · {s.host.os} · {s.host.cpu_model || s.host.arch} · {s.host.cores_logical} cores · up {duration(s.time - s.host.boot_time)}
      </p>

      <section className="sheet__section">
        <h3>
          CPU {Math.round(s.cpu.percent)}% · load {s.cpu.load.join(' ')}
        </h3>
        <DotChart values={history.map((h) => h.cpu)} max={100} label={`CPU over the last ${span ?? 'moment'}`} unit="%" span={span} />
        <div className="cores" aria-label="Per-core load">
          {s.cpu.per_core.map((c, i) => (
            <span key={i} className="core" title={`core ${i}: ${Math.round(c)}%`} style={{ background: `color-mix(in srgb, var(--ink) ${Math.round(c)}%, transparent)` }} />
          ))}
        </div>
      </section>

      <section className="sheet__section">
        <h3>
          Memory {bytes(s.memory.used)} of {bytes(s.memory.total)}
        </h3>
        <Meter percent={s.memory.percent} budget={92} />
        <DotChart values={history.map((h) => h.mem)} max={100} label={`Memory over the last ${span ?? 'moment'}`} unit="%" span={span} />
        {s.memory.swap_total > 0 && <span className="row__sub">Swap {bytes(s.memory.swap_used)} of {bytes(s.memory.swap_total)}</span>}
      </section>

      <section className="sheet__section">
        <h3>
          Network ↓ {rate(s.net.rx_rate)} · ↑ {rate(s.net.tx_rate)}
        </h3>
        <DotChart values={history.map((h) => h.rx + h.tx)} label="Network throughput" unit=" B/s" span={span} />
      </section>

      <section className="sheet__section">
        <h3>Disks</h3>
        <ul className="list">
          {s.disks.map((d) => (
            <li className="block" key={d.device + d.mount}>
              <div className="row">
                <span className="row__main">
                  {d.mount}
                  <span className="row__sub">
                    {bytes(d.used)} of {bytes(d.total)} · {d.fstype || d.device}
                  </span>
                </span>
                <span className={`row__meta${d.percent >= 90 ? ' signal-text' : ''}`}>{Math.round(d.percent)}%</span>
              </div>
              <Meter percent={d.percent} budget={90} />
            </li>
          ))}
        </ul>
      </section>

      {(s.temperatures.length > 0 || s.battery) && (
        <section className="sheet__section">
          <h3>Sensors</h3>
          <dl className="facts">
            {s.temperatures.map((t, i) => (
              <div key={i} style={{ display: 'contents' }}>
                <dt>{t.label}</dt>
                <dd>{Math.round(t.current)}°C</dd>
              </div>
            ))}
            {s.battery && (
              <>
                <dt>Battery</dt>
                <dd>
                  {Math.round(s.battery.percent)}% {s.battery.plugged ? '· charging' : ''}
                </dd>
              </>
            )}
          </dl>
        </section>
      )}
    </div>
  )
}

function UrlsSheet() {
  const { projects, refreshProjects } = useHub()
  const [checking, setChecking] = useState(false)
  const targets = (projects ?? []).flatMap((p) =>
    (['online', 'local'] as const).filter((t) => (t === 'online' ? p.online_url : p.local_url)).map((t) => ({ p, t, st: p.status[t] })),
  )
  const checkAll = async () => {
    setChecking(true)
    try {
      await Promise.all([...new Set(targets.map((x) => x.p.id))].map((id) => api(`projects/${id}/check`, { method: 'POST' })))
      refreshProjects()
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="sheet">
      <SheetHead id="urls">
        {targets.length > 0 && (
          <button className="btn btn--quiet" type="button" onClick={checkAll} disabled={checking}>
            <Icon name="refresh" size={16} /> {checking ? 'Checking' : 'Check now'}
          </button>
        )}
        <a className="btn" href="#/m/urls/new">
          <Icon name="plus" size={16} /> Add URL
        </a>
      </SheetHead>
      {!projects ? (
        <div className="sheet__empty">Loading…</div>
      ) : targets.length === 0 ? (
        <p className="sheet__lede">No URLs to watch yet. Add one, or give a project a live or local URL, and it is checked every minute.</p>
      ) : (
        <ul className="list">
          {targets
            .sort((a, b) => Number(a.st.latest?.ok ?? true) - Number(b.st.latest?.ok ?? true))
            .map(({ p, t, st }) => {
              const latest = st.latest
              // A local dev server being down just means it isn't running; only live sites count as faults.
              const fault = t === 'online' && latest && !latest.ok
              const url = t === 'online' ? p.online_url : p.local_url
              return (
                <li className="block" key={`${p.id}-${t}`}>
                  <div className="row">
                    <span className={`row__lamp${fault ? ' row__lamp--fault' : latest?.ok ? ' row__lamp--on' : ''}`} role="img" aria-label={latest?.ok ? 'up' : 'down'} />
                    <a className="row__main row__link" href={`#/m/projects/${p.id}`}>
                      {p.kind === 'link' ? p.name : `${p.name} (${t === 'online' ? 'live' : 'local'})`}
                    </a>
                    <span className={`row__state${fault ? ' row__state--fault' : ''}`}>
                      {!latest ? 'PENDING' : latest.ok ? 'UP' : t === 'online' ? 'DOWN' : 'NOT RUNNING'}
                    </span>
                    <span className="row__meta">
                      {latest?.ok ? `${Math.round(latest.latency_ms ?? 0)} ms` : latest?.status_code ? `HTTP ${latest.status_code}` : ''}
                    </span>
                    <a className="go" href={url} target="_blank" rel="noreferrer" aria-label={`Open ${url}`}>
                      <Icon name="arrow" size={20} />
                    </a>
                  </div>
                  {st.latency.length > 1 && !!st.uptime_percent && <DotChart values={st.latency} tone={fault ? 'signal' : 'ink'} height={56} label={`${p.name} ${t} latency`} unit=" ms" span={`${st.latency.length} min`} />}
                </li>
              )
            })}
        </ul>
      )}
    </div>
  )
}

function PortsSheet() {
  const { ports } = useHub()
  const host = window.location.hostname
  const hidden = ports?.some((p) => p.pid == null)
  return (
    <div className="sheet">
      <SheetHead id="machine" />
      <ViewTabs at="ports" />
      {!ports ? (
        <div className="sheet__empty">Loading…</div>
      ) : ports.length === 0 ? (
        <p className="sheet__lede">Nothing is listening right now.</p>
      ) : (
        <>
          <ul className="list">
            {ports.map((p) => (
              <li className="row" key={`${p.port}-${p.pid}-${p.proto}`}>
                <span className="row__main" style={{ flex: '0 0 6ch' }}>
                  :{p.port}
                </span>
                <span className="row__main">
                  {p.project ? <a href={`#/m/projects/${p.project.id}`}>{p.project.name}</a> : p.process || 'Unknown process'}
                  <span className="row__sub">
                    {p.process ? `${p.process} · pid ${p.pid}` : 'Process hidden by the OS'} · <Secret label="Address">{p.address}</Secret>
                  </span>
                </span>
                {p.proto === 'tcp' && (
                  <a className="go" href={`http://${host}:${p.port}`} target="_blank" rel="noreferrer" aria-label={`Open port ${p.port}`}>
                    <Icon name="arrow" size={20} />
                  </a>
                )}
              </li>
            ))}
          </ul>
          {hidden && (
            <p className="notice">
              Some ports have no process attached. This host hides which process owns a socket (common in containers, or on macOS without
              admin rights), so they can’t be linked to projects.
            </p>
          )}
        </>
      )}
    </div>
  )
}

type ContainerGroup = { key: string; label: string; project: ProjectRef; containers: Container[] }

/** Containers by the project they belong to: Marumado's project (by folder), else their Compose project, else on their own. */
function groupContainers(containers: Container[]): ContainerGroup[] {
  const groups = new Map<string, ContainerGroup>()
  for (const c of containers) {
    const key = c.project ? `p:${c.project.id}` : c.compose_project ? `c:${c.compose_project}` : 'solo'
    const label = c.project?.name ?? (c.compose_project || 'Standalone containers')
    const g = groups.get(key) ?? { key, label, project: c.project, containers: [] }
    g.containers.push(c)
    groups.set(key, g)
  }
  // Groups that need you first, then by name; standalone containers last.
  const rank = (g: ContainerGroup) => (g.containers.some((c) => c.health === 'unhealthy') ? 0 : g.key === 'solo' ? 2 : 1)
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
}

function DockerSheet() {
  const { docker, refreshDocker } = useHub()
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [logs, setLogs] = useState('')
  const [err, setErr] = useState('')
  const [view, setView] = useView('marumado.docker-view', ['grid', 'list'] as const)

  const act = async (id: string, verb: string) => {
    setErr('')
    try {
      await api(`docker/${id}/${verb}`, { method: 'POST' })
      refreshDocker()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed')
    }
  }
  const showLogs = async (id: string) => {
    if (logsFor === id) return setLogsFor(null)
    setLogsFor(id)
    setLogs('Loading logs…')
    try {
      setLogs((await api<{ logs: string }>(`docker/${id}/logs?tail=300`)).logs || 'No log output.')
    } catch (e) {
      setLogs(e instanceof Error ? `Couldn't read logs: ${e.message}` : "Couldn't read logs.")
    }
  }

  if (!docker) return <div className="sheet__empty">Loading…</div>

  const lampOf = (c: Container) => `row__lamp${c.health === 'unhealthy' ? ' row__lamp--fault' : c.status === 'running' ? ' row__lamp--on' : ''}`
  const subOf = (c: Container) =>
    [c.image, c.ports.length ? c.ports.map((p) => `:${p.host_port}`).join(' ') : ''].filter(Boolean).join(' · ')
  const usage = (c: Container) => (c.status === 'running' && c.cpu != null ? `${c.cpu}% · ${bytes(c.mem)}` : c.status)
  const actions = (c: Container) => (
    <>
      {c.status === 'running' ? (
        <>
          <button className="chip" type="button" onClick={() => act(c.id, 'restart')}>
            Restart
          </button>
          <ConfirmButton className="chip" confirmLabel="Confirm stop" onConfirm={() => act(c.id, 'stop')}>
            Stop
          </ConfirmButton>
        </>
      ) : (
        <button className="chip" type="button" onClick={() => act(c.id, 'start')}>
          Start
        </button>
      )}
      <button className="chip" type="button" onClick={() => showLogs(c.id)} aria-expanded={logsFor === c.id}>
        Logs
      </button>
    </>
  )

  return (
    <div className="sheet">
      <SheetHead id="machine">
        {docker.available && docker.containers.length > 0 && <ViewSwitch value={view} views={[['grid', 'Grid'], ['list', 'List']]} onChange={setView} />}
      </SheetHead>
      <ViewTabs at="docker" />
      {!docker.available ? (
        <p className="notice">
          <strong>Docker is off.</strong> <Redacted text={docker.error} /> Containers show up here as soon as the Docker daemon is reachable.
        </p>
      ) : docker.containers.length === 0 ? (
        <p className="sheet__lede">Docker is running, with no containers.</p>
      ) : (
        groupContainers(docker.containers).map((g) => {
          const running = g.containers.filter((c) => c.status === 'running').length
          const shownLogs = g.containers.find((c) => c.id === logsFor)
          return (
            <section className="sheet__section" key={g.key}>
              <h3 className="docker__group">
                {g.project ? <a href={`#/m/projects/${g.project.id}`}>{g.label}</a> : g.label}
                <span className="docker__count">
                  {running} of {g.containers.length} running
                </span>
              </h3>
              {view === 'grid' ? (
                <>
                  <ul className="cardgrid cardgrid--wide">
                    {g.containers.map((c) => (
                      <li className={`itemcard${logsFor === c.id ? ' is-open' : ''}`} key={c.id}>
                        <span className="itemcard__state">
                          <span className={lampOf(c)} aria-hidden />
                          {c.health === 'unhealthy' ? 'unhealthy' : c.status}
                        </span>
                        <span className="itemcard__name" title={c.name}>
                          {c.compose_service || c.name}
                        </span>
                        <span className="itemcard__sub" title={subOf(c)}>
                          {subOf(c)}
                        </span>
                        {c.status === 'running' && c.cpu != null && <span className="itemcard__sub mono">{usage(c)}</span>}
                        <span className="chips">{actions(c)}</span>
                      </li>
                    ))}
                  </ul>
                  {shownLogs && (
                    <div className="sheet__section">
                      <h3>Logs · {shownLogs.name}</h3>
                      <pre className="logs">
                        <Secret label="Logs">{logs}</Secret>
                      </pre>
                    </div>
                  )}
                </>
              ) : (
                <ul className="list">
                  {g.containers.map((c) => (
                    <li className="block" key={c.id}>
                      <div className="row">
                        <span className={lampOf(c)} role="img" aria-label={c.status} />
                        <span className="row__main" title={c.name}>
                          {c.compose_service || c.name}
                          <span className="row__sub">{subOf(c)}</span>
                        </span>
                        <span className="row__meta">{usage(c)}</span>
                      </div>
                      <div className="chips" style={{ paddingLeft: 26 }}>
                        {actions(c)}
                      </div>
                      {logsFor === c.id && (
                        <pre className="logs">
                          <Secret label="Logs">{logs}</Secret>
                        </pre>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })
      )}
      {err && <p className="notice signal-text">{err}</p>}
    </div>
  )
}

function ProcessesSheet() {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'cpu' | 'rss'>('cpu')
  const [open, setOpen] = useState<number | null>(null)
  const [msg, setMsg] = useState('')
  const { data, refresh } = usePoll<{ total: number; processes: Proc[] }>(`processes?sort=${sort}&limit=60&q=${encodeURIComponent(q)}`, 3000)

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

  return (
    <div className="sheet">
      <SheetHead id="machine">
        <button className={`btn${sort === 'cpu' ? '' : ' btn--quiet'}`} type="button" onClick={() => setSort('cpu')} aria-pressed={sort === 'cpu'}>
          By CPU
        </button>
        <button className={`btn${sort === 'rss' ? '' : ' btn--quiet'}`} type="button" onClick={() => setSort('rss')} aria-pressed={sort === 'rss'}>
          By memory
        </button>
      </SheetHead>
      <ViewTabs at="processes" />
      <label className="filter">
        <Icon name="search" size={18} />
        <span className="sr-only">Filter processes</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, command or pid" />
        {data && <span className="mono">{data.total}</span>}
      </label>
      {msg && <p className="notice">{msg}</p>}
      {!data ? (
        <div className="sheet__empty">Loading…</div>
      ) : data.processes.length === 0 ? (
        <div className="sheet__empty">No process matches “{q}”.</div>
      ) : (
        <ul className="list">
          {data.processes.map((p) => (
            <li className="block" key={p.pid}>
              <button className="row row--button" type="button" onClick={() => setOpen(open === p.pid ? null : p.pid)} aria-expanded={open === p.pid}>
                <span className="row__main">
                  {p.name}
                  <span className="row__sub">
                    pid {p.pid}
                    {p.project ? ` · ${p.project.name}` : ''}
                  </span>
                </span>
                <span className="row__meta">{p.cpu.toFixed(1)}%</span>
                <span className="row__meta" style={{ minWidth: '8ch' }}>
                  {bytes(p.rss)}
                </span>
              </button>
              {open === p.pid && (
                <div className="sheet__section" style={{ padding: 'var(--sp-3) 0 var(--sp-5)' }}>
                  <dl className="facts">
                    <dt>Command</dt>
                    <dd>
                      <Secret label="Command">{p.cmdline || '—'}</Secret>
                    </dd>
                    <dt>Folder</dt>
                    <dd>
                      <Secret label="Folder">{p.cwd || '—'}</Secret>
                    </dd>
                    <dt>User</dt>
                    <dd>
                      <Secret label="User">{p.user || '—'}</Secret> · {p.threads} threads · {p.status}
                    </dd>
                  </dl>
                  <div className="chips">
                    <ConfirmButton className="chip" confirmLabel={`Confirm stop ${p.pid}`} onConfirm={() => kill(p.pid, false)}>
                      Stop (SIGTERM)
                    </ConfirmButton>
                    <ConfirmButton className="chip" confirmLabel={`Confirm kill ${p.pid}`} onConfirm={() => kill(p.pid, true)}>
                      Force kill
                    </ConfirmButton>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const AGENT_STATE: Record<AgentStatus, string> = {
  working: 'WORKING',
  blocked: 'NEEDS YOU',
  idle: 'IDLE',
  done: 'DONE',
  unknown: '—',
}

const AGENT_ORDER: AgentStatus[] = ['blocked', 'working', 'done', 'idle', 'unknown']

/** Polled terminal output of one agent, for when the live terminal is turned off. */
function AgentOutput({ paneId, source }: { paneId: string; source: number }) {
  const out = usePoll<{ output: string }>(`agents/${encodeURIComponent(paneId)}/output?lines=200&${sourceQuery(source)}`, 3000)
  const ref = useRef<HTMLPreElement>(null)
  // Follow the newest lines, unless the reader has scrolled up to read.
  const follow = useRef(true)
  const text = out.error ? `Couldn't read the output: ${out.error.message}` : out.data ? out.data.output || 'No output yet.' : 'Loading output…'
  useLayoutEffect(() => {
    if (ref.current && follow.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text])
  const onScroll = () => {
    const el = ref.current
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }
  return (
    <pre className="logs logs--fill" ref={ref} onScroll={onScroll}>
      {text}
    </pre>
  )
}

const KEYS: [string, string][] = [
  ['esc', 'Esc'],
  ['tab', 'Tab'],
  ['up', '↑'],
  ['down', '↓'],
  ['left', '←'],
  ['right', '→'],
  ['enter', 'Enter'],
  ['ctrl+c', 'Ctrl C'],
]

/** Phones: a prompt box and the keys an agent's dialogs need, instead of typing into a tiny terminal. */
function AgentComposer({ paneId, source }: { paneId: string; source: number }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const send = async (json: { text?: string; keys?: string[] }) => {
    setBusy(true)
    setError('')
    try {
      await api(`agents/${encodeURIComponent(paneId)}/input?${sourceQuery(source)}`, { method: 'POST', json })
      if (json.text) setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach the agent.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault()
        if (text.trim()) send({ text })
      }}
    >
      <div className="composer__keys" role="group" aria-label="Keys">
        {KEYS.map(([key, label]) => (
          <button key={key} className="composer__key" type="button" disabled={busy} onClick={() => send({ keys: [key] })}>
            {label}
          </button>
        ))}
      </div>
      <div className="composer__row">
        <label className="sr-only" htmlFor="composer-text">
          Prompt
        </label>
        <textarea
          id="composer-text"
          className="composer__text"
          rows={2}
          value={text}
          placeholder="Write to the agent…"
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn composer__send" type="submit" disabled={busy || !text.trim()}>
          Send
        </button>
      </div>
      {error && <p className="composer__error signal-text">{error}</p>}
    </form>
  )
}

const TERMINAL_HINT = {
  control: 'Live. Click the terminal and type: keys go straight to the agent.',
  observe: 'Live, watch only (MARUMADO_HERDR_TERMINAL=observe).',
  off: 'Live terminal off (MARUMADO_HERDR_TERMINAL=off); output refreshes every 3 seconds.',
}

/** Desktop: show the pane at the window's size instead of Herdr's (remembered per browser). */
function useFitPreference(): [boolean, (on: boolean) => void] {
  const [fit, setFit] = useState(() => {
    try {
      return localStorage.getItem('marumado.terminal-fit') !== 'off'
    } catch {
      return true
    }
  })
  const set = (on: boolean) => {
    setFit(on)
    try {
      localStorage.setItem('marumado.terminal-fit', on ? 'on' : 'off')
    } catch {
      // private mode: remember for this visit only
    }
  }
  return [fit, set]
}

/** The + on a source's heading: opens a shell there (in a new tab of `workspace`, or a new Herdr workspace), and switches to it. */
function NewTerminal({ source, sourceName, workspace }: { source: number; sourceName: string; workspace?: string }) {
  const { refreshAgents } = useHub()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const open = async () => {
    setBusy(true)
    setError('')
    try {
      const made = await api<{ pane_id: string; source?: number }>('agents/terminal', { method: 'POST', json: { source, ...(workspace ? { workspace } : {}) } })
      refreshAgents()
      go(agentHref({ pane_id: made.pane_id, source: made.source ?? source }))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open a terminal.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      className={`agent-group__add${error ? ' signal-text' : ''}`}
      type="button"
      onClick={open}
      disabled={busy}
      aria-label={`New terminal on ${sourceName}`}
      title={error ? `Couldn't open a terminal: ${error}` : workspace ? `Open a shell in a new tab of ${workspace}` : `Open a shell in a new Herdr workspace on ${sourceName}`}
    >
      <Icon name="plus" size={14} />
    </button>
  )
}

const agentLabel = (a: Agent) => (a.title && a.title !== a.kind ? a.title : a.name || a.kind)

const lampOf = (a: Agent) =>
  a.status === 'blocked' ? ' row__lamp--fault' : a.status === 'working' ? ' row__lamp--on' : a.status === 'done' ? ' row__lamp--done' : ''

/** The bell beside the Agents title: how many agents wait on you, and the way to them. */
function InboxBell({ waiting, asks, active }: { waiting: number; asks: number; active: boolean }) {
  const what =
    [waiting ? `${waiting} agent${waiting === 1 ? '' : 's'} need${waiting === 1 ? 's' : ''} you` : '', asks ? `${asks} step${asks === 1 ? '' : 's'} wait${asks === 1 ? 's' : ''} for your go` : '']
      .filter(Boolean)
      .join(', ') || 'Nothing needs you'
  const count = waiting + asks
  return (
    <a className={`tool tool--bell${count ? ' is-fault' : ''}`} href="#/m/agents/inbox" aria-current={active ? 'page' : undefined} title={`${what}: answer them here`}>
      <Icon name="bell" size={18} />
      {count > 0 && <span className="tool__count">{count}</span>}
      <span className="sr-only">Needs you: {what}</span>
    </a>
  )
}

/** The plans, over the Agents page: lay out a new one or follow one, even with no agent running. Its badge counts
    the steps of every plan whose turn has come and that wait for your go, those for an agent not started yet too. */
function PlansButton({ onOpen }: { onOpen: () => void }) {
  const { plans } = useHub()
  const asks = (plans ?? []).reduce((n, p) => n + p.asking.length, 0)
  const scheduled = (plans ?? []).filter((p) => p.start_at && !p.running && !(p.steps.length && p.steps.every((t) => t.state === 'review' || t.state === 'done'))).length
  const what = [
    asks ? `${asks} step${asks === 1 ? '' : 's'} wait${asks === 1 ? 's' : ''} for your go` : '',
    scheduled ? `${scheduled} scheduled plan${scheduled === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join('; ')
  return (
    <button
      type="button"
      className={`tool${asks ? ' is-fault' : ''}`}
      aria-haspopup="dialog"
      onClick={onOpen}
      title={what ? `Plans: ${what}` : 'Plans: make a new one, or follow one'}
    >
      <Icon name="tasks" size={18} />
      <CountBadge n={asks} />
      {scheduled > 0 && (
        <span className={`tool__badge tool__badge--scheduled${asks ? ' tool__badge--lower' : ''}`} aria-hidden="true">
          {scheduled > 9 ? '9+' : scheduled}
        </span>
      )}
      <span className="sr-only">Plans{what && `: ${what}`}</span>
    </button>
  )
}

/** An agent in the side list. Its + queues a task for it in the plans modal, without leaving the agent on screen. */
function AgentTab({ agent: a, active, sub, onQueue }: { agent: Agent; active: boolean; sub: string; onQueue: (a: Agent) => void }) {
  const lamp = lampOf(a)
  const name = a.name || a.kind
  const queued = a.queued?.length ?? 0
  // The whole card is the link (stretched over it), so the + can sit on it without nesting a button in a link.
  return (
    <div className={`agent-tab${active ? ' is-active' : ''}${a.status === 'blocked' ? ' is-fault' : ''}${a.kind !== 'terminal' ? ' has-queue' : ''}`}>
      <span className={`row__lamp${lamp}`} role="img" aria-label={a.status} />
      <span className="agent-tab__main">
        <a className="agent-tab__title" href={agentHref(a)} aria-current={active ? 'page' : undefined}>
          {agentLabel(a)}
        </a>
        <span className="agent-tab__sub">
          <span className={`agent-tab__state${a.status === 'blocked' ? ' signal-text' : ''}`}>{AGENT_STATE[a.status]}</span> {a.kind} · {sub}
        </span>
      </span>
      {a.kind !== 'terminal' && (
        <button
          type="button"
          className={`tool agent-tab__queue${queued ? ' tool--bell is-queued mod-tasks' : ''}`}
          aria-haspopup="dialog"
          onClick={() => onQueue(a)}
          title={queued ? `${queued} queued for ${name}: queue more, or see them` : `New task: queue what ${name} does next`}
        >
          {queued ? <Icon name="queue" size={16} /> : <Icon name="plus" size={16} />}
          {queued > 0 && <span className="tool__count">{queued}</span>}
          <span className="sr-only">{queued ? `${queued} queued for ${name}: queue more` : `New task for ${name}`}</span>
        </button>
      )}
    </div>
  )
}

/** A source's heading in the list of agents: whether it answers, its name, and how many agents it runs. */
function SourceHeading({ source: s, agents, control, workspace }: { source: AgentSource; agents: Agent[]; control: boolean; workspace?: string }) {
  const redact = useRedact()
  const live = agents.filter((a) => a.kind !== 'terminal')
  const waiting = live.filter((a) => a.status === 'blocked').length
  const working = live.filter((a) => a.status === 'working').length
  const count = !s.available ? 'unreachable' : waiting ? `${waiting} need${waiting === 1 ? 's' : ''} you` : working ? `${working} of ${live.length} working` : live.length ? `${live.length} resting` : 'nothing open'
  return (
    <div className={`agent-group${s.available ? '' : ' is-down'}`} role="group" aria-label={`${s.name}: ${count}`}>
      <div className="agent-group__head">
        <span className={`row__lamp agent-group__lamp${s.available ? (working || waiting ? ' row__lamp--on' : '') : ' row__lamp--fault'}`} aria-hidden="true" />
        <span className="agent-group__name" title={redact(s.where)}>
          {s.name}
        </span>
        {control && s.available && <NewTerminal source={s.id} sourceName={s.name} workspace={workspace} />}
      </div>
      <span className={`agent-group__count${!s.available || waiting ? ' signal-text' : ''}`}>{count}</span>
      {!s.available && (
        <p className="agent-group__error" title={redact(s.error)}>
          <Redacted text={s.error || 'Herdr is not answering.'} />
        </p>
      )}
    </div>
  )
}

/** The task an agent is on, or a way to make what it is doing one, so it shows in Tasks and on its project. */
function AgentTask({ agent: a, projectId }: { agent: Agent; projectId: number | null }) {
  const { tasks, refreshTasks } = useHub()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const task = (tasks ?? []).find((t) => t.live && t.pane_id === a.pane_id && t.agent_source === sourceOf(a))
  if (task)
    return (
      <span className="agent-head__item mod-tasks">
        <Icon name="tasks" size={15} />
        <a href={`#/m/tasks/${task.id}`} title={`Task: ${task.title}`}>
          {task.title}
        </a>
      </span>
    )
  const make = async () => {
    setBusy(true)
    setError('')
    try {
      const title = a.title && a.title !== a.kind ? a.title : `${a.name || a.kind}'s work`
      const made = await api<{ id: number }>('tasks', { method: 'POST', json: { title: title.slice(0, 200), project: projectId } })
      await api(`tasks/${made.id}/follow`, { method: 'POST', json: { pane_id: a.pane_id, source: sourceOf(a) } })
      refreshTasks()
      go(`#/m/tasks/${made.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't make it a task.")
      setBusy(false)
    }
  }
  return (
    <span className="agent-head__item mod-tasks">
      <Icon name="tasks" size={15} />
      <button
        className="agent-head__link"
        type="button"
        onClick={make}
        disabled={busy}
        title="Follow what this agent does as a task: its states, what it changed, and a review when it finishes. Nothing is sent to it."
      >
        {busy ? 'Making it a task…' : 'Make it a task'}
      </button>
      {error && <span className="signal-text">{error}</span>}
    </span>
  )
}

function AgentsSheet({ sub }: { sub?: string }) {
  const { agents, projects, refreshAgents, needsYou } = useHub()
  const [closeError, setCloseError] = useState('')
  const narrow = useIsNarrow()
  const [view, setView] = useState<'text' | 'screen'>('text')
  const [fit, setFit] = useFitPreference()
  const [full, setFull] = useState(false)
  // An agent: the modal opens on what that agent does next; 'plans': on the plans alone, whatever is running.
  const [plansOpen, setPlansOpen] = useState<false | 'plans' | Agent>(false)
  const [changesAgent, setChangesAgent] = useState<Agent | null>(null)
  const plansButton = <PlansButton onOpen={() => setPlansOpen('plans')} />
  const [pickedWorkspace, setWorkspace] = useWorkspace()

  if (sub === 'sources' || sub?.startsWith('sources/')) return <AgentSourcesSheet sub={sub.slice(8)} />
  if (!agents) return <div className="sheet__empty">Loading…</div>
  // The backend links each agent to its project (by folder, or by name on another machine); older ones don't.
  const projectFor = (a: Agent) =>
    a.project !== undefined
      ? a.project
      : (projects ?? []).filter((p) => p.path && (a.cwd === p.path || a.cwd.startsWith(`${p.path}/`))).sort((x, y) => y.path.length - x.path.length)[0]
  // The workspace picked shows only its agents, and new terminals open in it. One gone from Herdr shows them all again.
  const workspace = findWorkspace(agents, pickedWorkspace)
  const inWorkspace = (a: Agent) => !workspace || (sourceOf(a) === workspace.source && a.workspace_id === workspace.id)
  const allSources = sourcesOf(agents)
  const sources = workspace ? allSources.filter((s) => s.id === workspace.source) : allSources
  const multi = allSources.length > 1
  // Grouped by source (in the order they are listed), then most urgent first. Even one source gets its heading,
  // with the + that opens a terminal there. Older Marumados don't list sources: a plain list then.
  const grouped = sources.length > 0
  const order = (a: Agent) => (grouped ? sources.findIndex((s) => s.id === sourceOf(a)) * 10 : 0) + AGENT_ORDER.indexOf(a.status)
  const everyAgent = [...agents.agents].sort((a, b) => order(a) - order(b))
  const list = everyAgent.filter(inWorkspace)
  const ref = parseAgentRef(sub)
  // A link to an agent in another workspace still opens it.
  const current = (ref && everyAgent.find((a) => a.pane_id === ref.pane && sourceOf(a) === ref.source)) || list[0]
  const mode = agents.terminal ?? 'control'
  const sourcesLabel = `Sources${multi ? ` · ${allSources.length}` : ''}`
  const workspaceBar = <WorkspaceBar agents={agents} chosen={workspace} onChoose={setWorkspace} control={mode === 'control'} />

  if (!agents.available || !current) {
    return (
      <div className="sheet">
        <SheetHead id="agents">
          {plansButton}
          <a className="btn btn--quiet" href="#/m/agents/sources">
            {sourcesLabel}
          </a>
        </SheetHead>
        {agents.available && workspaceBar}
        {!agents.available ? (
          <div className="notice">
            {multi ? (
              <>
                <strong>None of your agent sources answer.</strong>
                <ul className="agent-errors">
                  {sources.map((s) => (
                    <li key={s.id}>
                      <strong>{s.name}</strong>: <Redacted text={s.error} />
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>
                <strong>Herdr isn&rsquo;t reachable <Redacted text={agents.where} />.</strong> <Redacted text={agents.error} />
              </p>
            )}
            <p>
              If your agents run in VMs or on other machines, <a href="#/m/agents/sources/new">add each one as a source</a>.
            </p>
          </div>
        ) : (
          <>
            <p className="sheet__lede">
              {multi ? 'Nothing is open in Herdr on any of your sources.' : <>Herdr is running <Redacted text={agents.where} />, with nothing open.</>}
              {mode === 'control' && grouped && ' Open a terminal with + beside a source.'}
            </p>
            {grouped && (
              <div className="agent-tabs agent-tabs--empty">
                {sources.map((s) => (
                  <section className="agent-tabs__group" key={s.id}>
                    <SourceHeading source={s} agents={[]} control={mode === 'control'} />
                  </section>
                ))}
              </div>
            )}
          </>
        )}
        {plansOpen && <PlansModal agent={null} onClose={() => setPlansOpen(false)} />}
      </div>
    )
  }

  const project = projectFor(current)
  const currentSource = sourceOf(current)
  const currentSourceName = sourceLabel(agents, current)
  const closePane = async () => {
    setCloseError('')
    try {
      await api(`agents/${encodeURIComponent(current.pane_id)}/close?${sourceQuery(currentSource)}`, { method: 'POST' })
      refreshAgents()
      go('#/m/agents')
    } catch (err) {
      setCloseError(err instanceof Error ? `Couldn't close it: ${err.message}` : "Couldn't close it.")
    }
  }
  const inbox = sub === 'inbox' || Boolean(sub?.startsWith('inbox/'))
  // Needs you counts every workspace: an agent waiting elsewhere still waits on you.
  const waiting = everyAgent.filter((a) => a.kind !== 'terminal' && a.status === 'blocked')
  // Plans' steps whose turn has come, waiting for your go: they need you too, those starting a new agent as well.
  const asks = needsYou.asks
  const queued = current.queued ?? []
  const currentAsks = queued.filter((q) => q.asking).length
  const working = everyAgent.filter((a) => a.kind !== 'terminal' && a.status === 'working').length
  const tab = (a: Agent) => <AgentTab key={agentKey(a)} agent={a} active={!inbox && a === current} sub={projectFor(a)?.name ?? a.cwd} onQueue={setPlansOpen} />
  return (
    <div className="sheet sheet--fill agents">
      <aside className="agents__side">
        <SheetHead id="agents">
          <InboxBell waiting={waiting.length} asks={asks.length} active={inbox} />
          {plansButton}
          <a className="tool" href="#/m/agents/sources" title="Where your agents run: add, edit or remove sources">
            <Icon name="sliders" size={18} />
            <span className="sr-only">{sourcesLabel}</span>
          </a>
        </SheetHead>
        {workspaceBar}
        <nav className="agent-tabs" aria-label={workspace ? `Agents in ${workspaceLabel(workspace)}` : 'Agents'}>
          {grouped
            ? sources.map((s) => {
                const mine = list.filter((a) => sourceOf(a) === s.id)
                return (
                  <section className="agent-tabs__group" key={s.id}>
                    <SourceHeading source={s} agents={mine} control={mode === 'control'} workspace={workspace?.id} />
                    {mine.map(tab)}
                  </section>
                )
              })
            : list.map(tab)}
        </nav>
        <p className="agent-hint">{TERMINAL_HINT[mode]}</p>
      </aside>
      {inbox ? (
        <div className="agents__stage">
          <header className="agent-head">
            <div className="agent-head__line">
              <span className={`agent-head__bell${waiting.length ? ' signal-text' : ''}`} aria-hidden="true">
                <Icon name="bell" size={20} />
              </span>
              <h3 className="agent-head__title">Needs you</h3>
              <span className={`agent-head__state${waiting.length + asks.length ? ' signal-text' : ''}`}>{waiting.length + asks.length ? `${waiting.length + asks.length} waiting` : 'none'}</span>
            </div>
            <p className="agent-head__meta">Every agent waiting on an answer, from every source, and every step waiting for your go. Answer here, or open its terminal.</p>
          </header>
          <AgentInbox target={sub?.startsWith('inbox/') ? sub.slice(6) : undefined} waiting={waiting} asks={asks} working={working} control={mode === 'control'} />
        </div>
      ) : (
        <div className={`agents__stage${full && !narrow ? ' is-full' : ''}`}>
          <header className="agent-head">
            <div className="agent-head__line">
              <span className={`row__lamp${lampOf(current)}`} role="img" aria-label={current.status} />
              <h3 className="agent-head__title" title={agentLabel(current)}>
                {agentLabel(current)}
              </h3>
              <span className={`agent-head__state${current.status === 'blocked' ? ' signal-text' : ''}`}>{AGENT_STATE[current.status]}</span>
              <div className="agent-tools" role="toolbar" aria-label="Terminal">
                <button type="button" className="tool" aria-haspopup="dialog" onClick={() => setChangesAgent(current)} title="Files changed in this agent’s repository">
                  <Icon name="file" size={18} />
                  <span className="sr-only">Files changed</span>
                </button>
                {current.kind !== 'terminal' && (
                  <button
                    type="button"
                    className={`tool tool--bell${currentAsks ? ' is-fault' : queued.length ? ' is-queued mod-tasks' : ''}`}
                    aria-haspopup="dialog"
                    onClick={() => setPlansOpen(current)}
                    title={currentAsks ? `${currentAsks} queued for ${current.name || current.kind} wait${currentAsks === 1 ? 's' : ''} for your go: open to give it` : queued.length ? `${queued.length} queued for ${current.name || current.kind}: queue more, or open the plans` : `Queue what ${current.name || current.kind} does next, or open the plans`}
                  >
                    <Icon name="queue" size={18} />
                    {queued.length > 0 && <span className="tool__count">{queued.length}</span>}
                    <CountBadge n={currentAsks} />
                    <span className="sr-only">Queue next and plans{currentAsks ? `: ${currentAsks} waiting for your go` : ''}</span>
                  </button>
                )}
                {!narrow && mode === 'control' && (
                  <button
                    type="button"
                    className="tool"
                    aria-pressed={fit}
                    onClick={() => setFit(!fit)}
                    title={fit ? 'Fit to window is on: show the pane at its Herdr size instead, scaled to fit' : 'Fit to window: resize the pane to this window while you watch (the Herdr TUI gets it back when you leave)'}
                  >
                    <Icon name="fit" size={18} />
                    <span className="sr-only">Fit to window</span>
                  </button>
                )}
                {!narrow && mode !== 'off' && (
                  <button type="button" className="tool" aria-pressed={full} onClick={() => setFull(!full)} title={full ? 'Exit full screen' : 'Full screen'}>
                    <Icon name={full ? 'collapse' : 'expand'} size={18} />
                    <span className="sr-only">Full screen</span>
                  </button>
                )}
                {mode === 'control' && (
                  <ConfirmButton
                    className="tool tool--danger"
                    confirmLabel={current.kind === 'terminal' ? 'Close it' : `End ${current.kind}`}
                    onConfirm={closePane}
                    title={current.kind === 'terminal' ? 'Close this terminal' : `Close this pane and end ${current.kind}`}
                  >
                    <Icon name="close" size={18} />
                    <span className="sr-only">Close</span>
                  </ConfirmButton>
                )}
              </div>
            </div>
            <p className="agent-head__meta">
              {currentSourceName && (
                <a className="agent-source" href="#/m/agents/sources" title="Where this agent runs">
                  {currentSourceName}
                </a>
              )}
              <span className="agent-head__item mod-projects">
                <Icon name="folder" size={15} />
                {project ? <a href={`#/m/projects/${project.id}`}>{project.name}</a> : <Secret label="Folder">{current.cwd}</Secret>}
              </span>
              <span className="agent-head__item agent-head__mono" title="Herdr workspace and pane">
                <Icon name="terminal" size={15} />
                {current.name ? `${current.name} · ` : ''}
                {current.kind}
                {current.workspace ? ` · ${current.workspace}` : ''} · {current.pane_id}
              </span>
              {current.kind !== 'terminal' && (
                <span className="agent-head__chain mod-tasks">
                  <AgentTask agent={current} projectId={project?.id ?? null} />
                  {queued.length > 0 && (
                    <span className={`agent-head__next${queued[0].asking ? ' signal-text' : ''}`}>
                      <Icon name="arrow" size={14} />
                      <button
                        className="agent-head__link"
                        type="button"
                        onClick={() => setPlansOpen(current)}
                        title={`Next: ${queued[0].title}${queued[0].asking ? ' (waits for your go)' : ''}${queued.length > 1 ? `, then ${queued.length - 1} more` : ''}`}
                      >
                        {queued[0].title}
                      </button>
                      {queued[0].asking ? (
                        <span className="agent-head__pill agent-head__pill--go">go?</span>
                      ) : queued.length > 1 ? (
                        <span className="agent-head__pill">+{queued.length - 1}</span>
                      ) : null}
                    </span>
                  )}
                </span>
              )}
            </p>
          </header>
          {closeError && <p className="notice signal-text">{closeError}</p>}
          {narrow && mode !== 'off' && (
            <div className="seg" role="group" aria-label="View">
              <button type="button" className="seg__btn" aria-pressed={view === 'text'} onClick={() => setView('text')}>
                Text
              </button>
              <button type="button" className="seg__btn" aria-pressed={view === 'screen'} onClick={() => setView('screen')}>
                Screen
              </button>
            </div>
          )}
          {mode === 'off' || (narrow && view === 'text') ? (
            <AgentOutput paneId={current.pane_id} source={currentSource} key={agentKey(current)} />
          ) : (
            <Terminal paneId={current.pane_id} source={currentSource} control={mode === 'control'} phone={narrow} fit={fit} key={agentKey(current)} />
          )}
          {narrow && mode === 'control' && <AgentComposer paneId={current.pane_id} source={currentSource} key={`c${agentKey(current)}`} />}
        </div>
      )}
      {plansOpen && <PlansModal agent={plansOpen !== 'plans' && plansOpen.kind !== 'terminal' ? plansOpen : null} onClose={() => setPlansOpen(false)} key={plansOpen === 'plans' ? 'plans' : agentKey(plansOpen)} />}
      {changesAgent && <AgentChangesModal agent={changesAgent} onClose={() => setChangesAgent(null)} key={agentKey(changesAgent)} />}
    </div>
  )
}
