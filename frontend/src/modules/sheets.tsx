import { useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '../components/Terminal'
import { ConfirmButton } from '../components/ConfirmButton'
import { DotChart } from '../components/DotChart'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { bytes, duration, rate } from '../lib/format'
import { useHub } from '../lib/hub'
import { go, type Route } from '../lib/route'
import type { Agent, AgentStatus, Proc } from '../lib/types'
import { useIsNarrow } from '../lib/useIsNarrow'
import { usePoll } from '../lib/usePoll'
import { MomentumSheet, SkillsSheet } from './growth'
import { ProjectForm, ProjectsSheet } from './projects'
import { SheetHead } from './sheetHead'

export function SheetFor({ route }: { route: Route }) {
  if (route.kind === 'alerts') return <AlertsSheet />
  if (route.kind !== 'module') return null
  switch (route.id) {
    case 'projects':
      return <ProjectsSheet sub={route.sub} key={route.sub ?? 'list'} />
    case 'machine':
      return <MachineSheet />
    case 'urls':
      return route.sub === 'new' ? <ProjectForm kind="link" onDone={() => go('#/m/urls')} /> : <UrlsSheet />
    case 'ports':
      return <PortsSheet />
    case 'docker':
      return <DockerSheet />
    case 'processes':
      return <ProcessesSheet />
    case 'agents':
      return <AgentsSheet sub={route.sub} />
    case 'momentum':
      return <MomentumSheet />
    case 'skills':
      return <SkillsSheet sub={route.sub} key={route.sub ?? 'list'} />
  }
}

function AlertsSheet() {
  const { alerts, system, error } = useHub()
  return (
    <div className="sheet">
      <header className="sheet__head">
        <h2 className="sheet__title">{alerts.length ? 'Needs you' : 'All clear'}</h2>
      </header>
      {error && !system ? (
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
                {a.title}
                <span className="row__sub">{a.detail}</span>
              </span>
              <a className="go" href={a.href} aria-label={`Go to ${a.module}`}>
                <Icon name="arrow" size={20} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Meter({ percent, budget }: { percent: number; budget?: number }) {
  return (
    <div className="meter" role="meter" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`meter__fill${budget && percent >= budget ? ' meter__fill--fault' : ''}`} style={{ width: `${Math.min(100, percent)}%` }} />
      {budget && <div className="meter__budget" style={{ left: `${budget}%` }} aria-hidden="true" />}
    </div>
  )
}

function MachineSheet() {
  const { system: s, history } = useHub()
  if (!s) return <div className="sheet__empty">Reading the machine…</div>
  const last = history.slice(-150)
  return (
    <div className="sheet">
      <SheetHead id="machine" />
      <p className="sheet__lede">
        {s.host.hostname} · {s.host.os} · {s.host.cpu_model || s.host.arch} · {s.host.cores_logical} cores · up {duration(s.time - s.host.boot_time)}
      </p>

      <section className="sheet__section">
        <h3>
          CPU {Math.round(s.cpu.percent)}% · load {s.cpu.load.join(' ')}
        </h3>
        <DotChart values={last.map((h) => h.cpu)} max={100} label="CPU over the last 5 minutes" unit="%" />
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
        <DotChart values={last.map((h) => h.mem)} max={100} label="Memory over the last 5 minutes" unit="%" />
        {s.memory.swap_total > 0 && <span className="row__sub">Swap {bytes(s.memory.swap_used)} of {bytes(s.memory.swap_total)}</span>}
      </section>

      <section className="sheet__section">
        <h3>
          Network ↓ {rate(s.net.rx_rate)} · ↑ {rate(s.net.tx_rate)}
        </h3>
        <DotChart values={last.map((h) => h.rx + h.tx)} label="Network throughput" unit=" B/s" />
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
                  {st.latency.length > 1 && !!st.uptime_percent && <DotChart values={st.latency} tone={fault ? 'signal' : 'ink'} height={48} label={`${p.name} ${t} latency`} unit=" ms" />}
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
      <SheetHead id="ports" />
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
                    {p.process ? `${p.process} · pid ${p.pid}` : 'Process hidden by the OS'} · {p.address}
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

function DockerSheet() {
  const { docker, refreshDocker } = useHub()
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [logs, setLogs] = useState('')
  const [err, setErr] = useState('')

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
  return (
    <div className="sheet">
      <SheetHead id="docker" />
      {!docker.available ? (
        <p className="notice">
          <strong>Docker is off.</strong> {docker.error} Containers show up here as soon as the Docker daemon is reachable.
        </p>
      ) : docker.containers.length === 0 ? (
        <p className="sheet__lede">Docker is running, with no containers.</p>
      ) : (
        <ul className="list">
          {docker.containers.map((c) => {
            const running = c.status === 'running'
            return (
              <li className="block" key={c.id}>
                <div className="row">
                  <span className={`row__lamp${c.health === 'unhealthy' ? ' row__lamp--fault' : running ? ' row__lamp--on' : ''}`} role="img" aria-label={c.status} />
                  <span className="row__main">
                    {c.name}
                    <span className="row__sub">
                      {c.image}
                      {c.project ? ` · ${c.project.name}` : ''}
                      {c.ports.length ? ` · ${c.ports.map((p) => `:${p.host_port}`).join(' ')}` : ''}
                    </span>
                  </span>
                  <span className="row__meta">
                    {running && c.cpu != null ? `${c.cpu}% · ${bytes(c.mem)}` : c.status}
                  </span>
                </div>
                <div className="chips" style={{ paddingLeft: 26 }}>
                  {running ? (
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
                </div>
                {logsFor === c.id && <pre className="logs">{logs}</pre>}
              </li>
            )
          })}
        </ul>
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
      <SheetHead id="processes">
        <button className={`btn${sort === 'cpu' ? '' : ' btn--quiet'}`} type="button" onClick={() => setSort('cpu')} aria-pressed={sort === 'cpu'}>
          By CPU
        </button>
        <button className={`btn${sort === 'rss' ? '' : ' btn--quiet'}`} type="button" onClick={() => setSort('rss')} aria-pressed={sort === 'rss'}>
          By memory
        </button>
      </SheetHead>
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
                <div className="sheet__section" style={{ padding: '6px 0 10px' }}>
                  <dl className="facts">
                    <dt>Command</dt>
                    <dd>{p.cmdline || '—'}</dd>
                    <dt>Folder</dt>
                    <dd>{p.cwd || '—'}</dd>
                    <dt>User</dt>
                    <dd>
                      {p.user || '—'} · {p.threads} threads · {p.status}
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
function AgentOutput({ paneId }: { paneId: string }) {
  const out = usePoll<{ output: string }>(`agents/${encodeURIComponent(paneId)}/output?lines=200`, 3000)
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
function AgentComposer({ paneId }: { paneId: string }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const send = async (json: { text?: string; keys?: string[] }) => {
    setBusy(true)
    setError('')
    try {
      await api(`agents/${encodeURIComponent(paneId)}/input`, { method: 'POST', json })
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

function AgentsSheet({ sub }: { sub?: string }) {
  const { agents, projects } = useHub()
  const narrow = useIsNarrow()
  const [view, setView] = useState<'text' | 'screen'>('text')
  const [fit, setFit] = useFitPreference()
  const [full, setFull] = useState(false)

  if (!agents) return <div className="sheet__empty">Loading…</div>
  const projectFor = (a: Agent) =>
    (projects ?? []).filter((p) => p.path && (a.cwd === p.path || a.cwd.startsWith(`${p.path}/`))).sort((x, y) => y.path.length - x.path.length)[0]
  const list = [...agents.agents].sort((a, b) => AGENT_ORDER.indexOf(a.status) - AGENT_ORDER.indexOf(b.status))
  const current = list.find((a) => a.pane_id === sub) ?? list[0]
  const mode = agents.terminal ?? 'control'

  if (!agents.available || !current) {
    return (
      <div className="sheet">
        <SheetHead id="agents" />
        {!agents.available ? (
          <p className="notice">
            <strong>Herdr isn&rsquo;t reachable {agents.where}.</strong> {agents.error} If your agents run on another machine or VM, set <code>MARUMADO_HERDR_SMOLVM</code> (the smolvm machine name), <code>MARUMADO_HERDR_EXEC</code> or <code>MARUMADO_HERDR_SSH</code> in .env.
          </p>
        ) : (
          <p className="sheet__lede">Herdr is running {agents.where}, with no coding agents open.</p>
        )}
      </div>
    )
  }

  const project = projectFor(current)
  return (
    <div className="sheet sheet--fill agents">
      <aside className="agents__side">
        <SheetHead id="agents" />
        <nav className="agent-tabs" aria-label="Agents">
          {list.map((a) => {
            const lamp = a.status === 'blocked' ? ' row__lamp--fault' : a.status === 'working' ? ' row__lamp--on' : ''
            return (
              <a
                key={a.pane_id}
                className={`agent-tab${a === current ? ' is-active' : ''}${a.status === 'blocked' ? ' is-fault' : ''}`}
                href={`#/m/agents/${a.pane_id}`}
                aria-current={a === current ? 'page' : undefined}
              >
                <span className={`row__lamp${lamp}`} role="img" aria-label={a.status} />
                <span className="agent-tab__main">
                  <span className="agent-tab__title">{a.title && a.title !== a.kind ? a.title : a.name || a.kind}</span>
                  <span className="agent-tab__sub">
                    <span className={`agent-tab__state${a.status === 'blocked' ? ' signal-text' : ''}`}>{AGENT_STATE[a.status]}</span> {a.kind} · {projectFor(a)?.name ?? a.cwd}
                  </span>
                </span>
              </a>
            )
          })}
        </nav>
        <p className="agent-hint">{TERMINAL_HINT[mode]}</p>
      </aside>
      <div className={`agents__stage${full && !narrow ? ' is-full' : ''}`}>
        <div className="agent-bar">
          <p className="agent-meta">
            {current.name ? `${current.name} · ` : ''}
            {current.kind} · {project ? <a href={`#/m/projects/${project.id}`}>{project.name}</a> : current.cwd}
            {current.workspace ? ` · ${current.workspace} ${current.pane_id}` : ` · ${current.pane_id}`}
          </p>
          {!narrow && mode === 'control' && (
            <button
              type="button"
              className="agent-fit"
              aria-pressed={fit}
              onClick={() => setFit(!fit)}
              title={fit ? 'Show the pane at its Herdr size, scaled to fit' : 'Resize the pane to this window while you watch (the Herdr TUI gets it back when you leave)'}
            >
              Fit to window
            </button>
          )}
          {!narrow && mode !== 'off' && (
            <button type="button" className="agent-fit" aria-pressed={full} onClick={() => setFull(!full)}>
              {full ? 'Exit full screen' : 'Full screen'}
            </button>
          )}
        </div>
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
          <AgentOutput paneId={current.pane_id} key={current.pane_id} />
        ) : (
          <Terminal paneId={current.pane_id} control={mode === 'control'} phone={narrow} fit={fit} key={current.pane_id} />
        )}
        {narrow && mode === 'control' && <AgentComposer paneId={current.pane_id} key={`c${current.pane_id}`} />}
      </div>
    </div>
  )
}
