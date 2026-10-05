import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Critter } from '../components/Critter'
import { Icon } from '../components/Icon'
import { Terminal } from '../components/Terminal'
import { agentHref, agentKey, nameOf, sourceLabel, sourceOf, STATE_WORDS } from '../lib/agents'
import { useHub } from '../lib/hub'
import type { Agent } from '../lib/types'
import { useIsNarrow } from '../lib/useIsNarrow'
import { Question } from './agentInbox'
import './agentDock.css'
import { GoButton } from './plans'

const FOLD_KEY = 'marumado.dock'
const ORDER_KEY = 'marumado.dock.order'
// Places kept for agents that went away (a source that is off for a while), so they come back where they were.
const ORDER_KEEP = 64

function useFolded(): [boolean, () => void] {
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(FOLD_KEY) === 'folded'
    } catch {
      return false
    }
  })
  const toggle = () =>
    setFolded((f) => {
      try {
        localStorage.setItem(FOLD_KEY, f ? 'open' : 'folded')
      } catch {
        /* for this visit only */
      }
      return !f
    })
  return [folded, toggle]
}

/** Where each critter stands, by agent: set by hand, never by state, so an agent is always found in the same place.
    A new agent joins at the end. Remembered per browser. */
function useOrder(keys: string[]): [string[], (next: string[]) => void] {
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]')
      return Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string') : []
    } catch {
      return []
    }
  })
  const save = (next: string[]) => {
    // Past the limit, forget the places of agents that are gone, oldest first.
    const present = new Set(keys)
    let extra = next.length - ORDER_KEEP
    const kept = extra > 0 ? next.filter((k) => present.has(k) || extra-- <= 0) : next
    setOrder(kept)
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(kept))
    } catch {
      /* for this visit only */
    }
  }
  const fresh = keys.filter((k) => !order.includes(k))
  // Newcomers take their place at the end once, so the ones after them never shift.
  useEffect(() => {
    if (fresh.length) save([...order, ...fresh])
  })
  return [[...order, ...fresh], save]
}

/** What one agent is up to, opened from its critter: who it is, its live terminal (typed into when the terminal is
    in control mode), and the answer keys when it is waiting on you. Not modal: Escape outside the terminal or a click
    elsewhere puts it away. */
function AgentCard({ agent: a, control, onClose }: { agent: Agent; control: boolean; onClose: () => void }) {
  const { agents } = useHub()
  const ref = useRef<HTMLElement>(null)
  const narrow = useIsNarrow()
  const waiting = a.status === 'blocked'
  const on = sourceLabel(agents, a)

  useEffect(() => {
    // The terminal takes the keyboard when it can be typed into; otherwise the card does.
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus()
    // Escape in the terminal is the agent's (it interrupts Claude Code), not the card's.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as Element).closest?.('.term') && onClose()
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element
      if (!ref.current?.contains(t) && !t.closest?.('.dock__pet')) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [onClose])

  return (
    <section className={`dock__card${waiting ? ' is-fault' : ' dock__card--term'}`} ref={ref} tabIndex={-1} role="dialog" aria-labelledby="dock-card-title">
      <header className="dock__card-head">
        <Critter seed={agentKey(a)} status={a.status} size={60} />
        <div className="dock__card-who">
          <h2 className="dock__card-title" id="dock-card-title">
            {nameOf(a)}
          </h2>
          <p className="dock__card-where">
            {a.name && a.name !== nameOf(a) ? `${a.name} · ` : ''}
            {a.kind}
            {a.project ? ` · ${a.project.name}` : ''}
            {on ? ` on ${on}` : ''}
          </p>
          <p className={`dock__card-state${waiting ? ' signal-text' : ''}`}>
            <span className={`row__lamp${waiting ? ' row__lamp--fault' : a.status === 'working' ? ' row__lamp--on' : a.status === 'done' ? ' row__lamp--done' : ''}`} aria-hidden="true" />
            {STATE_WORDS[a.status]}
          </p>
          {a.queued?.length ? (
            <p className={`dock__card-next${a.queued[0].asking ? ' signal-text' : ''}`}>
              Next: <a href={`#/m/tasks/plan/${a.queued[0].plan}`} onClick={onClose}>{a.queued[0].title}</a>
              {a.queued[0].asking ? (
                <>
                  {' · waits for your go '}
                  <GoButton step={a.queued[0].id} title={a.queued[0].title} className="btn dock__go" />
                </>
              ) : a.queued.length > 1 ? (
                ` · ${a.queued.length - 1} more queued`
              ) : (
                ''
              )}
            </p>
          ) : null}
        </div>
        <button className="dock__close" type="button" onClick={onClose} aria-label="Close">
          <Icon name="close" size={18} />
        </button>
      </header>
      {waiting ? (
        <Question agent={a} control={control} head={false} />
      ) : (
        <div className="dock__term">
          <Terminal paneId={a.pane_id} source={sourceOf(a)} control={control} phone={narrow} fit key={agentKey(a)} />
        </div>
      )}
      <footer className="dock__card-links">
        <a className="agent-fit" href={agentHref(a)} onClick={onClose}>
          Open terminal
        </a>
        {a.project && (
          <a className="agent-fit" href={`#/m/projects/${a.project.id}`} onClick={onClose}>
            Project page
          </a>
        )}
      </footer>
    </section>
  )
}

/** Every agent that is running, from every source, as a critter in the bottom corner of every page, each in the place
    you gave it (drag it, or Alt+arrow keys). One that needs you lifts off the line in persimmon; choosing one opens
    its card. Folded, only those that need you stay out.
    Not shown since the tray (tray/) took its place; kept for now. */
export function AgentDock() {
  const { agents } = useHub()
  const [folded, toggleFold] = useFolded()
  const [open, setOpen] = useState<string | null>(null)
  const control = (agents?.terminal ?? 'control') === 'control'
  // As many critters as fit a phone's width, more on a desk.
  const max = useIsNarrow() ? 5 : 8

  const live = useMemo(() => (agents?.available ? agents.agents : []).filter((a) => a.kind !== 'terminal'), [agents])
  const [order, setOrder] = useOrder(live.map(agentKey))
  // While a critter is dragged, the order it would land in.
  const [dragged, setDragged] = useState<{ key: string; order: string[] } | null>(null)
  const pets = useRef<HTMLUListElement>(null)
  const grab = useRef<{ key: string; x: number; y: number; moved: boolean } | null>(null)
  const landing = useRef<string[] | null>(null)
  const dropped = useRef(false)

  const place = new Map((dragged?.order ?? order).map((k, i) => [k, i]))
  const all = [...live].sort((a, b) => (place.get(agentKey(a)) ?? 1e9) - (place.get(agentKey(b)) ?? 1e9))
  const waiting = all.filter((a) => a.status === 'blocked')
  const shown = (folded ? waiting : all).slice(0, max)
  const hidden = (folded ? waiting : all).slice(max)
  const current = all.find((a) => agentKey(a) === open)

  /** The full order with the critters on show rearranged as `visible`; the hidden ones keep their places. */
  const reorder = (visible: string[]) => {
    const on = new Set(visible)
    const queue = [...visible]
    return order.map((k) => (on.has(k) ? queue.shift()! : k))
  }
  const moveBy = (key: string, by: number) => {
    const visible = shown.map(agentKey)
    const i = visible.indexOf(key)
    const j = i + by
    if (i < 0 || j < 0 || j >= visible.length) return
    ;[visible[i], visible[j]] = [visible[j], visible[i]]
    setOrder(reorder(visible))
  }

  // Dragging a critter: past a few pixels it follows the pointer along the line, landing where it's let go.
  const onGrab = (e: ReactPointerEvent, key: string) => {
    if (e.button !== 0) return
    dropped.current = false
    grab.current = { key, x: e.clientX, y: e.clientY, moved: false }
    const move = (ev: PointerEvent) => {
      const g = grab.current
      if (!g) return
      if (!g.moved && Math.hypot(ev.clientX - g.x, ev.clientY - g.y) < 6) return
      g.moved = true
      const items = [...(pets.current?.children ?? [])] as HTMLElement[]
      const others = shown.map(agentKey).filter((k) => k !== g.key)
      const at = items.filter((el) => el.dataset.key !== g.key && el.getBoundingClientRect().left + el.offsetWidth / 2 < ev.clientX).length
      others.splice(at, 0, g.key)
      const next = reorder(others)
      landing.current = next
      setDragged((d) => (d && d.order.join() === next.join() ? d : { key: g.key, order: next }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (grab.current?.moved) {
        dropped.current = true
        if (landing.current) setOrder(landing.current)
        setDragged(null)
      }
      landing.current = null
      grab.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // An agent that went away takes its card with it.
  useEffect(() => {
    if (open && !current) setOpen(null)
  }, [open, current])

  if (!all.length) return null
  const working = all.filter((a) => a.status === 'working').length
  const needs = waiting.length
  const more = hidden.length
  const hiddenWaiting = hidden.filter((a) => a.status === 'blocked').length
  const summary = [needs && `${needs} need${needs === 1 ? 's' : ''} you`, working && `${working} working`].filter(Boolean).join(', ') || `${all.length} idle`

  return (
    <aside className={`dock${folded ? ' dock--folded' : ''}`} aria-label={`Agents: ${summary}`}>
      {current && <AgentCard agent={current} control={control} onClose={() => setOpen(null)} />}
      <div className="dock__plate">
        <ul className="dock__pets" ref={pets}>
          {shown.map((a) => {
            const key = agentKey(a)
            const queued = a.queued?.length ? `, ${a.queued.length} queued${a.queued[0].asking ? ', the next waits for your go' : ''}` : ''
            const label = `${nameOf(a)}, ${a.kind}${a.project ? ` in ${a.project.name}` : ''}: ${STATE_WORDS[a.status]}${queued}`
            return (
              <li key={key} data-key={key}>
                <button
                  className={`dock__pet${a.status === 'blocked' ? ' is-fault' : ''}${dragged?.key === key ? ' is-dragged' : ''}`}
                  type="button"
                  aria-label={label}
                  aria-expanded={open === key}
                  aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                  title={`${label}\nDrag, or Alt+arrow keys, to move it`}
                  onPointerDown={(e) => onGrab(e, key)}
                  onKeyDown={(e) => {
                    if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
                    e.preventDefault()
                    moveBy(key, e.key === 'ArrowLeft' ? -1 : 1)
                  }}
                  onClick={() => {
                    // The click that ends a drag doesn't open the card.
                    if (dropped.current) return void (dropped.current = false)
                    setOpen(open === key ? null : key)
                  }}
                >
                  <Critter seed={key} status={a.status} size={52} />
                </button>
              </li>
            )
          })}
        </ul>
        {more > 0 && (
          <a
            className={`dock__more${hiddenWaiting ? ' signal-text' : ''}`}
            href="#/m/agents"
            title={`${more} more agent${more === 1 ? '' : 's'}${hiddenWaiting ? `, ${hiddenWaiting} of them waiting for you` : ''}`}
          >
            +{more}
          </a>
        )}
        <button className="dock__fold" type="button" onClick={toggleFold} aria-pressed={folded} title={folded ? `Show all ${all.length} agents (${summary})` : 'Fold: keep out only the agents that need you'}>
          {folded && !shown.length ? <span className="dock__count">{all.length}</span> : null}
          <Icon name="chevron" size={16} className="dock__fold-icon" />
          <span className="sr-only">{folded ? 'Show all agents' : 'Fold the agents'}</span>
        </button>
      </div>
    </aside>
  )
}
