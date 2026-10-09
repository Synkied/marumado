import { useLayoutEffect, useRef, useState } from 'react'
import { AgentChangesModal } from './agentChanges'
import { Terminal } from '../components/Terminal'
import { ConfirmButton } from '../components/ConfirmButton'
import { DotChart } from '../components/DotChart'
import { CountBadge } from '../components/CountBadge'
import { Critter } from '../components/Critter'
import { Icon } from '../components/Icon'
import { Meter } from '../components/Meter'
import { agentHref, agentKey, CHAT_KINDS, findWorkspace, parseAgentRef, sourceLabel, sourceOf, sourceQuery, sourcesOf, STATE_WORDS, useWorkspace, workspaceLabel } from '../lib/agents'
import { api } from '../lib/api'
import { bytes, duration, rate } from '../lib/format'
import { useHub } from '../lib/hub'
import { useMachines } from '../lib/machines'
import { Redacted, Secret, useRedact } from '../lib/streaming'
import { go, type Route } from '../lib/route'
import type { Agent, Agents, AgentSource, AgentStatus, Container, ProjectRef, Pulse } from '../lib/types'
import { useIsNarrow } from '../lib/useIsNarrow'
import { usePoll } from '../lib/usePoll'
import { MomentumSheet, SkillsSheet, useView, ViewSwitch } from './growth'
import { NotifyToggle } from './agentInbox'
import { AgentSourcesSheet } from './agentSources'
import { MachinesSheet } from './machines'
import { ProcessesSheet } from './processes'
import { Fleet } from './fleet'
import { ProjectForm, ProjectsSheet } from './projects'
import { SheetHead, ViewTabs } from './sheetHead'
import { TasksSheet } from './tasks'
import { PlansModal } from './planModal'
import { AgentConversation } from './agentChat'
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

/** Interfaces Docker makes for each container (veth…) and its bridges: counted, not listed, unless they carry traffic. */
const VIRTUAL_NIC = /^(veth|br-|docker|virbr|cni|flannel|cali)/

function MachineSheet() {
  const { system: s, history } = useHub()
  if (!s) return <div className="sheet__empty">Reading the machine…</div>
  const span = history.length > 1 ? `${Math.max(1, Math.round((history[history.length - 1].t - history[0].t) / 60))} min` : undefined
  const over = span ?? 'moment'
  const nics = s.net.interfaces.filter((n) => n.up && (!VIRTUAL_NIC.test(n.name) || n.rx_rate + n.tx_rate > 1024)).sort((a, b) => b.rx_rate + b.tx_rate - (a.rx_rate + a.tx_rate))
  const quietNics = s.net.interfaces.filter((n) => n.up).length - nics.length
  const disks = [...s.disks].sort((a, b) => b.percent - a.percent)
  const physical = s.host.cores_physical && s.host.cores_physical !== s.host.cores_logical ? ` (${s.host.cores_physical} physical)` : ''
  return (
    <div className="sheet">
      <SheetHead id="machine" />
      <ViewTabs at="machine" />
      <dl className="specs">
        <div>
          <dt>Host</dt>
          <dd>
            <Secret label="Host name">{s.host.hostname}</Secret>
          </dd>
        </div>
        <div>
          <dt>System</dt>
          <dd>{s.host.os}</dd>
        </div>
        <div>
          <dt>Processor</dt>
          <dd>
            {s.host.cpu_model || s.host.arch} · {s.host.cores_logical} cores{physical}
            {s.cpu.freq_mhz ? ` · ${(s.cpu.freq_mhz / 1000).toFixed(1)} GHz` : ''}
          </dd>
        </div>
        <div>
          <dt>Up</dt>
          <dd>{duration(s.time - s.host.boot_time)}</dd>
        </div>
        {s.process_count != null && (
          <div>
            <dt>Processes</dt>
            <dd>{s.process_count}</dd>
          </div>
        )}
      </dl>

      <div className="chans">
        <section className="chan">
          <header className="chan__head">
            <h3>CPU</h3>
            <span className="chan__value">{Math.round(s.cpu.percent)}%</span>
            <span className="chan__aside">load {s.cpu.load.map((l) => l.toFixed(2)).join(' ')}</span>
          </header>
          <DotChart values={history.map((h) => h.cpu)} max={100} height={56} label={`CPU over the last ${over}`} unit="%" span={span} />
          <div className="cores" role="img" aria-label={`Per-core load: ${s.cpu.per_core.map((c) => Math.round(c)).join(', ')}%`}>
            {s.cpu.per_core.map((c, i) => (
              <span key={i} className="core" title={`Core ${i}: ${Math.round(c)}%`}>
                <span className="core__fill" style={{ height: `${Math.min(100, c)}%` }} />
              </span>
            ))}
          </div>
        </section>

        <section className="chan">
          <header className="chan__head">
            <h3>Memory</h3>
            <span className={`chan__value${s.memory.percent >= 92 ? ' signal-text' : ''}`}>{Math.round(s.memory.percent)}%</span>
            <span className="chan__aside">
              {bytes(s.memory.used)} of {bytes(s.memory.total)} · {bytes(s.memory.available)} free
            </span>
          </header>
          <DotChart values={history.map((h) => h.mem)} max={100} height={56} label={`Memory over the last ${over}`} unit="%" span={span} />
          {s.memory.swap_total > 0 && (
            <div className="gauge">
              <span className="gauge__name">Swap</span>
              <Meter percent={s.memory.swap_percent} label="Swap in use" />
              <span className="gauge__value">
                {bytes(s.memory.swap_used)} of {bytes(s.memory.swap_total)}
              </span>
            </div>
          )}
        </section>

        <section className="chan">
          <header className="chan__head">
            <h3>Network</h3>
            <span className="chan__value">
              ↓ {rate(s.net.rx_rate)} <span className="chan__sep">↑</span> {rate(s.net.tx_rate)}
            </span>
          </header>
          <DotChart values={history.map((h) => h.rx + h.tx)} height={56} label={`Network throughput over the last ${over}`} unit=" B/s" span={span} />
          {nics.length > 0 && (
            <table className="mini">
              <tbody>
                {nics.map((n) => (
                  <tr key={n.name}>
                    <th scope="row">{n.name}</th>
                    <td className="mini__dim">{n.speed_mbps ? (n.speed_mbps >= 1000 ? `${n.speed_mbps / 1000} Gb/s` : `${n.speed_mbps} Mb/s`) : ''}</td>
                    <td>↓ {rate(n.rx_rate)}</td>
                    <td>↑ {rate(n.tx_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <span className="chan__foot">
            {bytes(s.net.rx_total)} in · {bytes(s.net.tx_total)} out since boot
            {quietNics > 0 && ` · ${quietNics} quiet virtual interface${quietNics === 1 ? '' : 's'}`}
          </span>
        </section>

        <section className="chan">
          <header className="chan__head">
            <h3>Disk activity</h3>
            <span className="chan__value">
              {rate(s.disk_io.read_rate)} <span className="chan__unit">read</span>
              <span className="chan__sep">{rate(s.disk_io.write_rate)}</span> <span className="chan__unit">written</span>
            </span>
          </header>
          <DotChart values={history.map((h) => h.dr + h.dw)} height={56} label={`Disk reads and writes over the last ${over}`} unit=" B/s" span={span} />
        </section>

        <section className="chan chan--wide">
          <header className="chan__head">
            <h3>Disks</h3>
            <span className="chan__aside">
              {disks.length} mounted, fullest first
            </span>
          </header>
          <ul className="disks">
            {disks.map((d) => (
              <li className="disk" key={d.device + d.mount}>
                <span className="disk__mount" title={d.mount}>
                  {d.mount}
                </span>
                <span className={`disk__pct${d.percent >= 90 ? ' signal-text' : ''}`}>{Math.round(d.percent)}%</span>
                <Meter percent={d.percent} budget={90} label={`${d.mount} in use`} />
                <span className="disk__sub">
                  {bytes(d.used)} of {bytes(d.total)} · {d.fstype || d.device}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {(s.temperatures.length > 0 || s.battery) && (
          <section className="chan chan--wide">
            <header className="chan__head">
              <h3>Sensors</h3>
            </header>
            <dl className="sensors">
              {s.temperatures.map((t, i) => {
                const hot = t.high != null && t.current >= t.high
                return (
                  <div key={i}>
                    <dt title={t.chip}>{t.label || t.chip}</dt>
                    <dd className={hot ? 'signal-text' : undefined}>{Math.round(t.current)}°C</dd>
                  </div>
                )
              })}
              {s.battery && (
                <div>
                  <dt>Battery</dt>
                  <dd>
                    {Math.round(s.battery.percent)}%{s.battery.plugged ? ' · charging' : s.battery.secs_left ? ` · ${duration(s.battery.secs_left)} left` : ''}
                  </dd>
                </div>
              )}
            </dl>
          </section>
        )}
      </div>
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

/** The agent's session as a conversation, or its live terminal instead (remembered per browser): the conversation
    unless you pick the terminal. */
function useChatPreference(): [boolean, (on: boolean) => void] {
  const [chat, setChat] = useState(() => {
    try {
      return localStorage.getItem('marumado.agent-terminal') !== 'on'
    } catch {
      return true
    }
  })
  const set = (on: boolean) => {
    setChat(on)
    try {
      localStorage.setItem('marumado.agent-terminal', on ? 'off' : 'on')
    } catch {
      // private mode: remember for this visit only
    }
  }
  return [chat, set]
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

/** What an agent did last, from its session record (the pulse), and when: only when the record is its own, not one
    it shares with another agent of its kind in the same folder. */
type Doing = { title: string; t: number }

const lately = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Which agent it is and how it is: its critter, the same as in the top bar and the dock (a plain terminal, its lamp). */
function AgentMark({ agent: a, label, size }: { agent: Agent; label: string; size: number }) {
  if (a.kind === 'terminal') return <span className={`row__lamp${lampOf(a)}`} role="img" aria-label={label} />
  return (
    <span className="agent-mark" role="img" aria-label={label}>
      <Critter seed={agentKey(a)} status={a.status} size={size} />
    </span>
  )
}

/** How each agent quits, typed at its prompt. */
const QUIT: Record<string, string> = { claude: '/exit', codex: '/quit', pi: '/quit', gemini: '/quit', opencode: '/exit' }

/** What runs in the pane (claude, codex, pi…), as a small tag beside its name; nothing for a plain terminal. */
function AgentKind({ agent: a }: { agent: Agent }) {
  return a.kind === 'terminal' ? null : <span className="agent-kind">{a.kind}</span>
}

/** An agent in the side list, as a conversation in a chat app, in two lines: its name, how long since its last step and
    what it is (claude, codex…), at the row's end, then where it works and what it is on. The whole row opens it. */
function AgentRow({ agent: a, active, place, doing }: { agent: Agent; active: boolean; place: string; doing?: Doing }) {
  const queued = a.queued?.length ?? 0
  const fault = a.status === 'blocked'
  const state = capital(STATE_WORDS[a.status])
  return (
    <a className={`thread${active ? ' is-active' : ''}${fault ? ' is-fault' : ''}`} href={agentHref(a)} aria-current={active ? 'page' : undefined} title={`${agentLabel(a)} · ${a.kind}`}>
      <AgentMark agent={a} label={state} size={30} />
      <span className="thread__main">
        <span className="thread__top">
          <span className="thread__name">{agentLabel(a)}</span>
          {doing && (
            <time className="thread__ago" dateTime={new Date(doing.t).toISOString()} title={`Last step at ${new Date(doing.t).toLocaleString()}`}>
              {lately(doing.t)}
            </time>
          )}
          <AgentKind agent={a} />
        </span>
        <span className="thread__doing">
          <span className="thread__where">{a.project ? a.project.name : <Secret label="Folder">{place}</Secret>}</span>
          {' · '}
          {(fault || !doing || a.status !== 'working') && <span className={fault ? 'signal-text' : undefined}>{fault ? 'Needs you' : state}</span>}
          {doing && (
            <>
              {(fault || a.status !== 'working') && ' · '}
              <Secret label="Step">{doing.title}</Secret>
            </>
          )}
          {queued > 0 && ` · ${queued} queued`}
        </span>
      </span>
    </a>
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
        <span className={`agent-group__count${!s.available || waiting ? ' signal-text' : ''}`}>{count}</span>
        {control && s.available && <NewTerminal source={s.id} sourceName={s.name} workspace={workspace} />}
      </div>
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
  const [chat, setChat] = useChatPreference()
  const [fit, setFit] = useFitPreference()
  const [full, setFull] = useState(false)
  // An agent: the modal opens on what that agent does next; 'plans': on the plans alone, whatever is running.
  const [plansOpen, setPlansOpen] = useState<false | 'plans' | Agent>(false)
  const [changesAgent, setChangesAgent] = useState<Agent | null>(null)
  const plansButton = <PlansButton onOpen={() => setPlansOpen('plans')} />
  const [pickedWorkspace, setWorkspace] = useWorkspace()
  // What each agent did last, for the list.
  const pulse = usePoll<Pulse>(agents?.available && !sub?.startsWith('sources') ? 'agents/pulse' : null, 15000)

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
  // Needs you counts every workspace: an agent waiting elsewhere still waits on you.
  const waiting = everyAgent.filter((a) => a.kind !== 'terminal' && a.status === 'blocked')
  // Plans' steps whose turn has come, waiting for your go: they need you too, those starting a new agent as well.
  const asks = needsYou.asks
  // The old inbox's links (#/m/agents/inbox, …/inbox/<agent>) open the agent waiting on you, to answer it there.
  const inbox = sub === 'inbox' || Boolean(sub?.startsWith('inbox/'))
  const ref = parseAgentRef(inbox ? sub?.slice(6) : sub)
  // A link to an agent in another workspace still opens it.
  const current = (ref && everyAgent.find((a) => a.pane_id === ref.pane && sourceOf(a) === ref.source)) || (inbox && waiting[0]) || list[0]
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
  // Claude Code, Codex and Pi keep a record of their session, which the conversation reads: it opens on that.
  const canChat = CHAT_KINDS.includes(current.kind)
  const showChat = chat && canChat
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
  // Quit the agent, keeping its pane: its shell is back, and the page shows the terminal. Busy or asking, Esc first,
  // which may be all it takes (a question asked as it starts quits it); a question can also hold the command back until
  // its screen says it is gone, so that is tried again a moment later. Ctrl+C empties its input box before the command
  // is typed: what was there (a draft, or the prompt an interrupt gives back) would go with it.
  const quitWith = QUIT[current.kind]
  const quitAgent = async () => {
    setCloseError('')
    const input = (json: { text?: string; keys?: string[] }) => api(`agents/${encodeURIComponent(current.pane_id)}/input?${sourceQuery(currentSource)}`, { method: 'POST', json })
    const pause = (ms: number) => new Promise((r) => window.setTimeout(r, ms))
    // Typed with no agent there, the command would go to its shell.
    const still = async () => (await api<Agents>('agents')).agents.some((a) => agentKey(a) === agentKey(current) && a.kind !== 'terminal')
    try {
      let interrupt = current.status === 'working' || current.status === 'blocked'
      for (let tries = 1; ; tries++) {
        if (interrupt) {
          await input({ keys: ['esc'] })
          await pause(1000)
          if (!(await still())) break
        }
        try {
          await input({ keys: ['ctrl+c'] })
          await pause(300)
          await input({ text: quitWith })
          break
        } catch (err) {
          if (tries === 3 || !(err instanceof Error && /question/.test(err.message))) throw err
          interrupt = true
        }
      }
      for (const ms of [800, 2500, 5000]) window.setTimeout(refreshAgents, ms)
    } catch (err) {
      setCloseError(err instanceof Error ? `Couldn't quit it: ${err.message}` : "Couldn't quit it.")
    }
  }
  const queued = current.queued ?? []
  const currentAsks = queued.filter((q) => q.asking).length
  // Phones show one thing at a time, like a chat app: the list, or the agent opened from it.
  const listOnly = narrow && !ref && !inbox
  const folderOf = new Map<string, NonNullable<Pulse['folders']>[number]>()
  for (const f of pulse.data?.folders ?? []) for (const p of f.panes) folderOf.set(`${f.source}/${p}`, f)
  const doingOf = (a: Agent): Doing | undefined => {
    const f = folderOf.get(agentKey(a))
    return f?.now && f.panes.length === 1 ? { title: f.now.title, t: f.now.t } : undefined
  }
  const row = (a: Agent) => <AgentRow key={agentKey(a)} agent={a} active={!listOnly && a === current} place={projectFor(a)?.name ?? a.cwd} doing={doingOf(a)} />
  const calm = (as: Agent[]) => as.filter((a) => !(a.kind !== 'terminal' && a.status === 'blocked'))
  const elsewhere = waiting.filter((a) => a !== current).length + asks.length
  const where = (
    <span className="agent-head__meta">
      {currentSourceName && (
        <a className="agent-source" href="#/m/agents/sources" title="Where this agent runs">
          {currentSourceName}
        </a>
      )}
      <span className="agent-head__item mod-projects">
        <Icon name="folder" size={15} />
        {project ? <a href={`#/m/projects/${project.id}`}>{project.name}</a> : <Secret label="Folder">{current.cwd}</Secret>}
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
              {queued[0].asking ? <span className="agent-head__pill agent-head__pill--go">go?</span> : queued.length > 1 ? <span className="agent-head__pill">+{queued.length - 1}</span> : null}
            </span>
          )}
        </span>
      )}
    </span>
  )
  return (
    <div className={`sheet sheet--fill agents${narrow ? (listOnly ? ' agents--list' : ' agents--thread') : ''}`}>
      <aside className="agents__side">
        <SheetHead id="agents">
          {plansButton}
          <a className="tool" href="#/m/agents/sources" title="Where your agents run: add, edit or remove sources">
            <Icon name="sliders" size={18} />
            <span className="sr-only">{sourcesLabel}</span>
          </a>
        </SheetHead>
        {workspaceBar}
        <nav className="agent-tabs threads" aria-label={workspace ? `Agents in ${workspaceLabel(workspace)}` : 'Agents'}>
          {(waiting.length > 0 || asks.length > 0) && (
            <section className="agent-tabs__group threads__needs" aria-label="Needs you">
              <h3 className="threads__head">
                <Icon name="bell" size={14} />
                Needs you <span className="threads__count">{waiting.length + asks.length}</span>
              </h3>
              {waiting.map(row)}
              {asks.map(({ step, agent: a }) => (
                <a className="thread is-fault" key={`go${step.id}`} href={`#/m/tasks/plan/${step.plan}`} title="Open its plan to give it the go">
                  <span className="row__lamp row__lamp--fault" aria-hidden="true" />
                  <span className="thread__main">
                    <span className="thread__name">{step.title}</span>
                    <span className="thread__doing">
                      <span className="signal-text">Waits for your go</span> · {a ? `next for ${a.name || a.kind}` : 'starts a new agent'}
                    </span>
                  </span>
                </a>
              ))}
            </section>
          )}
          {grouped
            ? sources.map((s) => {
                const mine = list.filter((a) => sourceOf(a) === s.id)
                return (
                  <section className="agent-tabs__group" key={s.id}>
                    <SourceHeading source={s} agents={mine} control={mode === 'control'} workspace={workspace?.id} />
                    {calm(mine).map(row)}
                  </section>
                )
              })
            : calm(list).map(row)}
        </nav>
        <NotifyToggle />
      </aside>
      {!listOnly && (
        <div className={`agents__stage${full && !narrow ? ' is-full' : ''}`}>
          <header className="agent-head">
            <div className="agent-head__line">
              {narrow && (
                <a className="tool agent-head__back" href="#/m/agents" title={elsewhere ? `All agents: ${elsewhere} more need you` : 'All agents'}>
                  <Icon name="back" size={18} />
                  <CountBadge n={elsewhere} />
                  <span className="sr-only">All agents{elsewhere ? `, ${elsewhere} more need you` : ''}</span>
                </a>
              )}
              <AgentMark agent={current} label={current.status} size={30} />
              <h3
                className="agent-head__title"
                title={`${agentLabel(current)}: ${current.name ? `${current.name} · ` : ''}${current.kind}${current.workspace ? ` · ${current.workspace}` : ''} · ${current.pane_id}`}
              >
                {agentLabel(current)}
              </h3>
              <AgentKind agent={current} />
              <span className={`agent-head__state${current.status === 'blocked' ? ' signal-text' : ''}`}>{AGENT_STATE[current.status]}</span>
              {!narrow && where}
              <div className="agent-tools" role="toolbar" aria-label="Agent">
                {canChat && (
                  <button
                    type="button"
                    className="agent-fit agent-fit--icon agent-view"
                    aria-pressed={!showChat}
                    onClick={() => setChat(!showChat)}
                    title={showChat ? 'Show its live terminal instead of the conversation' : 'Back to the conversation'}
                  >
                    <Icon name="terminal" size={16} />
                    <span className={narrow ? 'sr-only' : undefined}>Terminal</span>
                  </button>
                )}
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
                {!narrow && mode === 'control' && !showChat && (
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
                {mode === 'control' && quitWith && (
                  <ConfirmButton className="tool" confirmLabel={`Quit ${current.kind}`} onConfirm={quitAgent} title={`Quit ${current.kind} and keep this pane as a terminal (${quitWith})`}>
                    <Icon name="stop" size={18} />
                    <span className="sr-only">Quit {current.kind}</span>
                  </ConfirmButton>
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
          </header>
          {closeError && <p className="notice signal-text">{closeError}</p>}
          {!showChat && narrow && mode !== 'off' && (
            <div className="seg" role="group" aria-label="Terminal as">
              <button type="button" className="seg__btn" aria-pressed={view === 'text'} onClick={() => setView('text')}>
                Text
              </button>
              <button type="button" className="seg__btn" aria-pressed={view === 'screen'} onClick={() => setView('screen')}>
                Screen
              </button>
            </div>
          )}
          {showChat ? (
            <AgentConversation agent={current} control={mode === 'control'} key={`chat${agentKey(current)}`} />
          ) : mode === 'off' || (narrow && view === 'text') ? (
            <AgentOutput paneId={current.pane_id} source={currentSource} key={agentKey(current)} />
          ) : (
            <Terminal paneId={current.pane_id} source={currentSource} control={mode === 'control'} phone={narrow} fit={fit} key={agentKey(current)} />
          )}
          {!showChat && narrow && mode === 'control' && <AgentComposer paneId={current.pane_id} source={currentSource} key={`c${agentKey(current)}`} />}
          {!showChat && !narrow && <p className="agent-hint">{TERMINAL_HINT[mode]}</p>}
        </div>
      )}
      {plansOpen && <PlansModal agent={plansOpen !== 'plans' && plansOpen.kind !== 'terminal' ? plansOpen : null} onClose={() => setPlansOpen(false)} key={plansOpen === 'plans' ? 'plans' : agentKey(plansOpen)} />}
      {changesAgent && <AgentChangesModal agent={changesAgent} onClose={() => setChangesAgent(null)} key={agentKey(changesAgent)} />}
    </div>
  )
}
