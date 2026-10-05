import { useEffect, useState } from 'react'
import { Dial } from './components/Dial'
import { Icon } from './components/Icon'
import { Palette } from './components/Palette'
import { TokenGate } from './components/TokenGate'
import { logOut } from './lib/api'
import { bytes } from './lib/format'
import { CPU_BUDGET, isMachineModule, MEM_BUDGET, useHub, type ModuleId } from './lib/hub'
import { useMachines } from './lib/machines'
import { useAgentCallbacks } from './lib/notify'
import { useStreaming } from './lib/streaming'
import { useIsNarrow } from './lib/useIsNarrow'
import { usePins } from './lib/pins'
import { go, useRoute } from './lib/route'
import { meta, PANEL_MODULES, useSummaries, type Summary } from './modules/registry'
import { PinnedProjects } from './modules/projectPin'
import { SheetFor } from './modules/sheets'
import { Fleet } from './modules/fleet'
import { AgentDock } from './modules/agentDock'
import './app.css'

function Wordmark() {
  return (
    <a className="wordmark" href="#/" aria-label="Marumado home">
      {/* A round chart: the rim, its hub, and the pen's mark at the top. */}
      <svg className="wordmark__mark" viewBox="0 0 32 32" aria-hidden="true">
        <circle className="wordmark__ring" cx="16" cy="16" r="14.5" />
        <circle className="wordmark__hub" cx="16" cy="16" r="5" />
        <path className="wordmark__pen" d="M16 1.5V8" />
      </svg>
      <span className="wordmark__text">marumado</span>
      <span className="wordmark__kanji" lang="ja">丸窓</span>
    </a>
  )
}

const MANAGE = 'manage'

/** Which machine the machine modules (Machine, Processes, Ports, Docker) show. Another machine than this one is
    marked, so it is never mistaken for it. Your work (projects, tasks, agents…) lives here whichever it is. */
function MachinePicker() {
  const { machines, current, currentMachine, select } = useMachines()
  const streaming = useStreaming().on
  if (!machines) return null
  const remote = currentMachine && !currentMachine.local
  return (
    <label className={`picker${remote ? ' picker--remote' : ''}${currentMachine?.state === 'down' ? ' is-fault' : ''}`} title="Which machine Marumado shows">
      <Icon name="server" size={16} />
      <span className="sr-only">Machine</span>
      <select
        value={String(current)}
        onChange={(e) => (e.target.value === MANAGE ? go('#/m/machines') : select(e.target.value === 'local' ? 'local' : Number(e.target.value)))}
      >
        {machines.map((m) => (
          <option key={m.id} value={String(m.id)}>
            {m.local ? `${(!streaming && m.summary?.hostname) || 'This machine'} (this one)` : m.name}
            {m.state === 'down' ? ' · unreachable' : ''}
          </option>
        ))}
        <option value={MANAGE}>{machines.length > 1 ? 'Manage machines…' : 'Add a machine…'}</option>
      </select>
    </label>
  )
}

/** Streaming mode on or off: hides SSH logins, host names, paths, addresses and logs. */
function StreamingToggle() {
  const { on, toggle } = useStreaming()
  return (
    <button
      className={`stream${on ? ' stream--on' : ''}`}
      type="button"
      onClick={toggle}
      aria-pressed={on}
      title={on ? 'Streaming mode: SSH logins, host names, paths, addresses and logs are hidden. Click to show them.' : 'Streaming mode: hide SSH logins, host names, paths, addresses and logs'}
    >
      <Icon name={on ? 'eye-off' : 'eye'} size={18} />
      <span className="sr-only">Streaming mode</span>
    </button>
  )
}

/** Log this browser out; the next visit asks for the access token again. */
function LockButton() {
  return (
    <button className="stream" type="button" onClick={logOut} title="Log out: this browser will ask for the access token again">
      <Icon name="lock" size={18} />
      <span className="sr-only">Log out</span>
    </button>
  )
}

/** CPU and RAM at a glance, in the top bar; opens the Machine module. */
function Vitals() {
  const { system } = useHub()
  if (!system) return null
  const cpu = Math.round(system.cpu.percent)
  const mem = Math.round(system.memory.percent)
  const rows = [
    { key: 'CPU', value: cpu, hot: cpu >= CPU_BUDGET },
    { key: 'RAM', value: mem, hot: mem >= MEM_BUDGET },
  ]
  return (
    <a
      className="vitals"
      href="#/m/machine"
      aria-label={`CPU ${cpu}%, memory ${mem}% (${bytes(system.memory.used)} of ${bytes(system.memory.total)})`}
      title={`Memory: ${bytes(system.memory.used)} of ${bytes(system.memory.total)}`}
    >
      {rows.map((r) => (
        <span key={r.key} className={`vitals__row${r.hot ? ' is-hot' : ''}`}>
          <span className="vitals__key">{r.key}</span>
          <span className="vitals__bar">
            <span style={{ transform: `scaleX(${Math.min(100, r.value) / 100})` }} />
          </span>
          <span className="vitals__value">{r.value}%</span>
        </span>
      ))}
    </a>
  )
}

function StatusBadge() {
  const { alerts, system, error } = useHub()
  const { currentMachine } = useMachines()
  const count = alerts.length
  const offline = !!error && !system
  const label = offline ? (currentMachine && !currentMachine.local ? `${currentMachine.name} unreachable` : 'Backend offline') : count ? `${count} ${count === 1 ? 'thing needs' : 'things need'} you` : 'All clear'
  return (
    <a className={`badge${count || offline ? ' badge--alert' : ''}`} href="#/alerts" aria-label={label}>
      <span className="badge__dot" aria-hidden="true" />
      <span className="badge__caption">{offline ? 'offline' : count ? `${count} ${count === 1 ? 'needs' : 'need'} you` : 'all clear'}</span>
      {/* The one thing announced as it changes; the sheets themselves stay quiet while they refresh. */}
      <span className="sr-only" aria-live="polite">
        {label}
      </span>
    </a>
  )
}

function ModuleCell({ id, active, s }: { id: ModuleId; active: boolean; s: Summary | null }) {
  const m = meta(id)
  const tone = s?.off ? 'off' : s?.fault ? 'signal' : 'ink'
  const reading = [s?.value, s?.caption].filter(Boolean).join(', ')
  return (
    <a
      className={`cell mod-${id}${active ? ' is-active' : ''}${s?.fault ? ' is-fault' : ''}`}
      href={`#/m/${id}`}
      aria-current={active ? 'page' : undefined}
      title={reading ? `${m.label}: ${reading}` : m.label}
    >
      <span className="cell__label">{m.label}</span>
      <Dial value={s?.value ?? '··'} fraction={s?.fraction ?? null} tone={tone} caption={s?.caption} chart={s?.chart} quiet={!!s?.quiet && !s.fault} />
    </a>
  )
}

type PanelProps = { pins: ModuleId[]; active?: ModuleId; perRow: number; onEdit: () => void; open: boolean; onToggle: () => void }

function DialPanel({ pins, active, perRow, onEdit, open, onToggle }: PanelProps) {
  const summaries = useSummaries()
  const rows: ModuleId[][] = []
  for (let i = 0; i < pins.length; i += perRow) rows.push(pins.slice(i, i + perRow))
  return (
    <section className={`panel${open ? '' : ' panel--rail'}`} aria-label="Modules">
      <button className="panel__toggle" type="button" onClick={onToggle} aria-expanded={open} title={open ? 'Show only the charts' : 'Show module details'}>
        <Icon name="back" size={16} />
        <span className="panel__toggle-text">{open ? 'Less' : 'More'}</span>
      </button>
      {rows.map((row, i) => (
        <div className="panel__row" key={i}>
          {row.map((id) => (
            <ModuleCell key={id} id={id} active={active === id} s={summaries[id]} />
          ))}
        </div>
      ))}
      <PinnedProjects />
      <button className="panel__edit" type="button" onClick={onEdit} title="Arrange the modules">
        <Icon name="sliders" size={16} /> <span className="panel__edit-text">Arrange</span>
      </button>
    </section>
  )
}

function ArrangeSheet({ pins, setPins, onDone }: { pins: ModuleId[]; setPins: (p: ModuleId[]) => void; onDone: () => void }) {
  const unpinned = PANEL_MODULES.filter((m) => !pins.includes(m.id))
  const move = (i: number, d: number) => {
    const next = [...pins]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    setPins(next)
  }
  return (
    <div className="sheet">
      <header className="sheet__head">
        <h2 className="sheet__title">Arrange</h2>
        <button className="btn" type="button" onClick={onDone}>
          Done
        </button>
      </header>
      <p className="sheet__lede">Choose what sits on the home panel and in which order.</p>
      <ol className="list">
        {pins.map((id, i) => (
          <li className="row" key={id}>
            <Icon name={meta(id).icon} size={20} className={`arrange__icon mod-${id}`} />
            <span className="row__main">{meta(id).label}</span>
            <span className="row__actions">
              <button className="btn btn--quiet" type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${meta(id).label} up`}>
                Up
              </button>
              <button className="btn btn--quiet" type="button" onClick={() => move(i, 1)} disabled={i === pins.length - 1} aria-label={`Move ${meta(id).label} down`}>
                Down
              </button>
              <button className="btn btn--quiet" type="button" onClick={() => setPins(pins.filter((p) => p !== id))} disabled={pins.length === 1}>
                Unpin
              </button>
            </span>
          </li>
        ))}
        {unpinned.map((m) => (
          <li className="row row--muted" key={m.id}>
            <Icon name={m.icon} size={20} className={`arrange__icon mod-${m.id}`} />
            <span className="row__main">
              {m.label}
              <span className="row__sub">{m.blurb}</span>
            </span>
            <span className="row__actions">
              <button className="btn" type="button" onClick={() => setPins([...pins, m.id])}>
                Pin
              </button>
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

const SIDEBAR_KEY = 'marumado.sidebar'

/** Whether the module sidebar shows details or only the dials; remembered in this browser. */
function useSidebarOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === 'open'
    } catch {
      return false
    }
  })
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, o ? 'closed' : 'open')
      } catch {
        /* not remembered */
      }
      return !o
    })
  return [open, toggle]
}

export default function App() {
  useAgentCallbacks()
  const route = useRoute()
  // Most modules are your work, the same on every machine: one arrangement for all.
  const [pins, setPins] = usePins('local')
  const [arranging, setArranging] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const narrow = useIsNarrow()
  const [sidebarOpen, toggleSidebar] = useSidebarOpen()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)
      // Keys typed into a live terminal belong to the agent.
      if (e.target instanceof HTMLElement && e.target.closest('.xterm')) return
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const home = route.kind === 'home'
  const activeModule = route.kind === 'module' ? route.id : undefined

  return (
    <TokenGate>
      <div className={`app${narrow ? (home ? ' app--home' : ' app--sheet-only') : ''}`}>
        <header className="top">
          <div className="top__brand">
            <Wordmark />
            {activeModule && isMachineModule(activeModule) && <MachinePicker />}
            <StreamingToggle />
            <LockButton />
          </div>
          <button className="search" type="button" onClick={() => setPaletteOpen(true)} title="Search (/)">
            <Icon name="search" size={20} />
            <span className="sr-only">Search</span>
          </button>
          <Vitals />
          <StatusBadge />
        </header>

        {home && !arranging ? (
          <main className="main main--home">
            <Fleet />
          </main>
        ) : (
          <main className={`main${narrow || sidebarOpen ? '' : ' main--rail'}`}>
            <DialPanel
              pins={pins}
              active={narrow ? undefined : activeModule}
              perRow={narrow ? 2 : 1}
              onEdit={() => setArranging(true)}
              open={narrow || sidebarOpen}
              onToggle={toggleSidebar}
            />
            <section className={`side${activeModule && !arranging ? ` mod-${activeModule}` : ''}`}>
              {narrow && !arranging && !home && (
                <button className="side__back" type="button" onClick={() => go('#/')}>
                  <Icon name="back" size={18} /> Home
                </button>
              )}
              {arranging ? <ArrangeSheet pins={pins} setPins={setPins} onDone={() => setArranging(false)} /> : <SheetFor route={route} />}
            </section>
          </main>
        )}

        <AgentDock />
        {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
      </div>
    </TokenGate>
  )
}
