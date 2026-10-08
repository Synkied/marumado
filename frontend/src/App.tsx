import { useEffect, useState } from 'react'
import { CountBadge } from './components/CountBadge'
import { Dial } from './components/Dial'
import { HistoryArrows } from './components/HistoryArrows'
import { Icon } from './components/Icon'
import { Palette } from './components/Palette'
import { TokenGate } from './components/TokenGate'
import { logOut } from './lib/api'
import { bytes } from './lib/format'
import { CPU_BUDGET, isMachineModule, MEM_BUDGET, useHub, type ModuleId } from './lib/hub'
import { agentHref } from './lib/agents'
import { useMachines } from './lib/machines'
import { useAgentCallbacks } from './lib/notify'
import { useStreaming } from './lib/streaming'
import { useIsNarrow } from './lib/useIsNarrow'
import { go, useRoute } from './lib/route'
import { meta, useSummaries } from './modules/registry'
import { pinnedProjects, PinnedProjects } from './modules/projectPin'
import { SheetFor } from './modules/sheets'
import { TopPets } from './modules/agentPulse'
import { Fleet } from './modules/fleet'
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
      <span className="wordmark__name">
        <span className="wordmark__text">marumado</span>
        <span className="wordmark__version" title="Marumado's version">v{__MARUMADO_VERSION__}</span>
      </span>
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

/** Your work, as small dials in the top bar, one click from anywhere: Agents, Tasks, Projects and URLs. The agents'
    dial carries a count of what waits on you there (an agent's question or approval, a plan's step waiting for your
    go) and opens the first agent waiting on you, to answer it in its conversation; otherwise the Agents page. */
const WORK: ModuleId[] = ['agents', 'tasks', 'projects', 'urls']

function WorkDials({ active }: { active?: ModuleId }) {
  const summaries = useSummaries()
  const { needsYou: n } = useHub()
  const waits =
    [
      n.waiting.length ? `${n.waiting.length} agent${n.waiting.length === 1 ? '' : 's'} need${n.waiting.length === 1 ? 's' : ''} you` : '',
      n.asks.length ? `${n.asks.length} step${n.asks.length === 1 ? '' : 's'} wait${n.asks.length === 1 ? 's' : ''} for your go` : '',
    ]
      .filter(Boolean)
      .join(', ') || 'nothing needs you'
  return (
    <nav className="work" aria-label="Your work">
      {WORK.map((id) => {
        const s = summaries[id]
        const m = meta(id)
        const agents = id === 'agents'
        const fault = !!s?.fault || (agents && n.count > 0)
        const tone = s?.off ? 'off' : fault ? 'signal' : 'ink'
        const reading = agents ? waits : [s?.value, s?.caption].filter(Boolean).join(', ')
        return (
          <a
            key={id}
            className={`cell work__cell mod-${id}${active === id ? ' is-active' : ''}${fault ? ' is-fault' : ''}`}
            href={agents && n.waiting.length ? agentHref(n.waiting[0]) : `#/m/${id}`}
            aria-current={active === id ? 'page' : undefined}
            title={reading ? `${m.label}: ${reading}` : m.label}
          >
            <span className="work__face">
              <Dial value={s?.value ?? '··'} fraction={s?.fraction ?? null} tone={tone} chart={s?.chart} quiet={!!s?.quiet && !fault} busy={!!s?.busy} />
              {agents && <CountBadge n={n.count} />}
            </span>
            <span className="cell__label" aria-hidden="true">
              {m.label}
            </span>
            <span className="sr-only">{reading ? `${m.label}: ${reading}` : m.label}</span>
          </a>
        )
      })}
      <TopPets />
    </nav>
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

const SIDEBAR_KEY = 'marumado.sidebar'

/** Whether the sidebar shows the pinned projects' names or only their first letters; remembered in this browser. */
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
  const { projects } = useHub()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const narrow = useIsNarrow()
  const [sidebarOpen, toggleSidebar] = useSidebarOpen()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)
      // Keys typed into a live terminal belong to the agent.
      if (e.target instanceof HTMLElement && e.target.closest('.xterm')) return
      // Ctrl/⌘+Enter sends any text box, as in chat apps: its form's submit button, unless the box handled it itself.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.defaultPrevented && e.target instanceof HTMLTextAreaElement) {
        const form = e.target.closest('form')
        const button = form?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? e.target.closest('label')?.parentElement?.querySelector<HTMLButtonElement>('[data-submit]')
        if (button && !button.disabled) {
          e.preventDefault()
          if (form) form.requestSubmit(button)
          else button.click()
        }
        return
      }
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
  // The sidebar holds only the pinned projects for now: none pinned (or a phone), no sidebar.
  const sidebar = !narrow && pinnedProjects(projects).length > 0

  return (
    <TokenGate>
      <div className={`app${narrow ? (home ? ' app--home' : ' app--sheet-only') : ''}`}>
        <header className="top">
          <div className="top__brand">
            {!narrow && <HistoryArrows />}
            <Wordmark />
            {activeModule && isMachineModule(activeModule) && <MachinePicker />}
            <StreamingToggle />
            <LockButton />
          </div>
          <WorkDials active={activeModule} />
          <button className="search" type="button" onClick={() => setPaletteOpen(true)} title="Search (/)">
            <Icon name="search" size={20} />
            <span className="sr-only">Search</span>
          </button>
          <Vitals />
          <StatusBadge />
        </header>

        {home ? (
          <main className="main main--home">
            <Fleet />
          </main>
        ) : (
          <main className={`main${sidebar ? (sidebarOpen ? '' : ' main--rail') : ' main--solo'}`}>
            {sidebar && (
              <section className={`panel${sidebarOpen ? '' : ' panel--rail'}`} aria-label="Sidebar">
                <button className="panel__toggle" type="button" onClick={toggleSidebar} aria-expanded={sidebarOpen} title={sidebarOpen ? 'Show only their first letters' : 'Show the names'}>
                  <Icon name="back" size={16} />
                  <span className="panel__toggle-text">{sidebarOpen ? 'Less' : 'More'}</span>
                </button>
                <PinnedProjects />
              </section>
            )}
            <section className={`side${activeModule ? ` mod-${activeModule}` : ''}`}>
              {narrow && (
                <button className="side__back" type="button" onClick={() => go('#/')}>
                  <Icon name="back" size={18} /> Home
                </button>
              )}
              <SheetFor route={route} />
            </section>
          </main>
        )}

        {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
      </div>
    </TokenGate>
  )
}
