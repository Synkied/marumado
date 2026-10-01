import { useEffect, useMemo, useState } from 'react'
import { Dial } from './components/Dial'
import { Icon } from './components/Icon'
import { Palette } from './components/Palette'
import { TokenGate } from './components/TokenGate'
import { bytes } from './lib/format'
import { CPU_BUDGET, MEM_BUDGET, useHub, type ModuleId } from './lib/hub'
import { useIsNarrow } from './lib/useIsNarrow'
import { usePins } from './lib/pins'
import { go, useRoute } from './lib/route'
import { MODULES, meta, useSummaries } from './modules/registry'
import { SheetFor } from './modules/sheets'
import './app.css'

function Wordmark() {
  return (
    <a className="wordmark" href="#/" aria-label="Marumado home">
      <svg className="wordmark__mark" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="9" cy="9" r="6" />
        <circle cx="23" cy="9" r="6" />
        <circle cx="9" cy="23" r="6" />
        <circle cx="23" cy="23" r="6" />
      </svg>
      <span className="wordmark__text">MARUMADO</span>
    </a>
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
            <span style={{ width: `${Math.min(100, r.value)}%` }} />
          </span>
          <span className="vitals__value">{r.value}%</span>
        </span>
      ))}
    </a>
  )
}

function StatusBadge() {
  const { alerts, system, error } = useHub()
  const count = alerts.length
  const offline = !!error && !system
  const label = offline ? 'Backend offline' : count ? `${count} ${count === 1 ? 'thing needs' : 'things need'} you` : 'All clear'
  return (
    <a className={`badge${count || offline ? ' badge--alert' : ''}`} href="#/alerts" aria-label={label}>
      <span className="badge__disc">
        <span className="badge__value">{offline ? '!' : count || 'OK'}</span>
      </span>
      <span className="badge__caption">{offline ? 'OFFLINE' : count ? 'NEEDS YOU' : 'ALL CLEAR'}</span>
    </a>
  )
}

function ModuleCell({ id, active }: { id: ModuleId; active: boolean }) {
  const m = meta(id)
  const s = useSummaries()[id]
  const index = String(MODULES.findIndex((x) => x.id === id) + 1).padStart(2, '0')
  const tone = s?.off ? 'off' : s?.fault ? 'signal' : 'ink'
  const reading = [s?.value, s?.caption].filter(Boolean).join(', ')
  return (
    <a
      className={`cell mod-${id}${active ? ' is-active' : ''}${s?.fault ? ' is-fault' : ''}`}
      href={`#/m/${id}`}
      aria-current={active ? 'page' : undefined}
      title={reading ? `${m.label}: ${reading}` : m.label}
    >
      <span className="cell__label">
        <span className="cell__index">{index}</span>
        {m.label.toUpperCase()}
      </span>
      <Icon name={m.icon} size={34} className="cell__icon" />
      <Dial value={s?.value ?? '··'} fraction={s?.fraction ?? null} tone={tone} caption={s?.caption} />
    </a>
  )
}

type PanelProps = { pins: ModuleId[]; active?: ModuleId; perRow: number; onEdit: () => void; open: boolean; onToggle: () => void }

function DialPanel({ pins, active, perRow, onEdit, open, onToggle }: PanelProps) {
  const rows: ModuleId[][] = []
  for (let i = 0; i < pins.length; i += perRow) rows.push(pins.slice(i, i + perRow))
  return (
    <section className={`panel${open ? '' : ' panel--rail'}`} aria-label="Modules">
      <button className="panel__toggle" type="button" onClick={onToggle} aria-expanded={open} title={open ? 'Show only the dials' : 'Show module details'}>
        <Icon name="back" size={16} />
        <span className="panel__toggle-text">{open ? 'Less' : 'More'}</span>
      </button>
      {rows.map((row, i) => (
        <div className="panel__row" key={i}>
          {row.map((id) => (
            <ModuleCell key={id} id={id} active={active === id} />
          ))}
        </div>
      ))}
      <button className="panel__edit" type="button" onClick={onEdit} title="Arrange the modules">
        <Icon name="sliders" size={16} /> <span className="panel__edit-text">Arrange</span>
      </button>
    </section>
  )
}

function ArrangeSheet({ pins, setPins, onDone }: { pins: ModuleId[]; setPins: (p: ModuleId[]) => void; onDone: () => void }) {
  const unpinned = MODULES.filter((m) => !pins.includes(m.id))
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

type ActiveItem = { key: string; icon: string; label: string; href: string; state: 'on' | 'fault'; title: string }

/** What is live right now, in the top bar: for now, agents that are working or waiting on you. */
function ActiveNow() {
  const { agents } = useHub()
  const items = useMemo<ActiveItem[]>(
    () =>
      (agents?.available ? agents.agents : [])
        .filter((a) => a.status === 'working' || a.status === 'blocked')
        .sort((a, b) => Number(b.status === 'blocked') - Number(a.status === 'blocked'))
        .map((a) => ({
          key: `agent:${a.pane_id}`,
          icon: 'agent',
          label: a.title && a.title !== a.kind ? a.title : a.name || a.kind,
          href: `#/m/agents/${a.pane_id}`,
          state: a.status === 'blocked' ? 'fault' : 'on',
          title: `${a.kind} · ${a.status === 'blocked' ? 'needs you' : 'working'}`,
        })),
    [agents],
  )
  if (!items.length) return null
  return (
    <section className="active" aria-labelledby="active-title">
      <h2 className="active__title" id="active-title">
        Active
      </h2>
      <ul className="active__tiles">
        {items.map((it) => (
          <li className={`tile${it.state === 'fault' ? ' is-fault' : ''}`} key={it.key}>
            <a className="tile__main" href={it.href} title={`${it.label} (${it.title})`}>
              <Icon name={it.icon} size={18} />
              <span className="tile__name">{it.label}</span>
              <span className={`tile__live${it.state === 'fault' ? ' tile__live--fault' : ''}`}>{it.state === 'fault' ? 'needs you' : 'working'}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
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
  const route = useRoute()
  const [pins, setPins] = usePins()
  const [arranging, setArranging] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const { alerts } = useHub()
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

  // On wide screens the sheet always shows something: what needs you, else Projects.
  const sheetRoute = route.kind === 'home' ? (alerts.length ? { kind: 'alerts' as const } : { kind: 'module' as const, id: 'projects' as ModuleId }) : route
  const showSheet = arranging || !narrow || route.kind !== 'home'
  const activeModule = sheetRoute.kind === 'module' ? sheetRoute.id : undefined

  return (
    <TokenGate>
      <div className={`app${narrow && route.kind !== 'home' ? ' app--sheet-only' : ''}`}>
        <header className="top">
          <Wordmark />
          <ActiveNow />
          <button className="search" type="button" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={20} />
            <span className="search__hint">/ search</span>
          </button>
          <Vitals />
          <StatusBadge />
        </header>

        <main className={`main${narrow || sidebarOpen ? '' : ' main--rail'}`}>
          <DialPanel
            pins={pins}
            active={narrow ? undefined : activeModule}
            perRow={narrow ? 2 : 1}
            onEdit={() => setArranging(true)}
            open={narrow || sidebarOpen}
            onToggle={toggleSidebar}
          />
          {showSheet && (
            <section className={`side${activeModule && !arranging ? ` mod-${activeModule}` : ''}`} aria-live="polite">
              {narrow && !arranging && (
                <button className="side__back" type="button" onClick={() => go('#/')}>
                  <Icon name="back" size={18} /> Home
                </button>
              )}
              {arranging ? <ArrangeSheet pins={pins} setPins={setPins} onDone={() => setArranging(false)} /> : <SheetFor route={sheetRoute} />}
            </section>
          )}
        </main>

        {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
      </div>
    </TokenGate>
  )
}
