import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { Arrangement, Place, Places } from '../lib/garden'
import type { ModuleId } from '../lib/hub'
import { MODULES, meta, useSummaries } from '../modules/registry'
import { Dial } from './Dial'
import { Icon } from './Icon'
import './garden.css'

/* Where each pinned module's chart lies, in reading order: x and y as fractions of the table, s as its size.
   The first pin is the principal chart; the others gather in uneven groups around it, never on a grid.
   Any prefix of the list stays balanced, and no two charts overlap (checked from 1000×560 up to 2400×1150). */
const SLOTS: [number, number, number][] = [
  [0.229, 0.36, 0.98],
  [0.535, 0.27, 0.68],
  [0.814, 0.39, 0.74],
  [0.139, 0.8, 0.44],
  [0.392, 0.79, 0.46],
  [0.639, 0.77, 0.52],
  [0.868, 0.79, 0.46],
  [0.94, 0.11, 0.34],
  [0.5, 0.6, 0.34],
  [0.71, 0.1, 0.32],
  [0.05, 0.09, 0.28],
]

const MINOR = 16 // px between the graticule's fine lines
const MAJOR = 5 // fine lines per major division

/** The chart table's graticule: fine lines every 16px, a major division every fifth, aligned to the table's centre. */
function Graticule({ width, height }: { width: number; height: number }) {
  if (!width || !height) return null
  const span = MINOR * MAJOR
  // Centred, so the grid sits square to the table whatever its size.
  const ox = (width / 2) % span
  const oy = (height / 2) % span
  return (
    <svg className="garden__grid" width={width} height={height} aria-hidden="true">
      <defs>
        <pattern id="graticule-minor" width={MINOR} height={MINOR} patternUnits="userSpaceOnUse" x={ox} y={oy}>
          <path d={`M${MINOR} 0V${MINOR}M0 ${MINOR}H${MINOR}`} className="garden__minor" />
        </pattern>
        <pattern id="graticule-major" width={span} height={span} patternUnits="userSpaceOnUse" x={ox} y={oy}>
          <path d={`M${span} 0V${span}M0 ${span}H${span}`} className="garden__major" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#graticule-minor)" />
      <rect width="100%" height="100%" fill="url(#graticule-major)" />
    </svg>
  )
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize((s) => (Math.abs(s.width - width) < 1 && Math.abs(s.height - height) < 1 ? s : { width: Math.round(width), height: Math.round(height) }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

const GAP = 10 // px of paper kept between two charts
const STEP = 0.01 // how far Shift + an arrow key moves a chart, as a fraction of the table
const SIZES = [0.24, 1.1] // the smallest and largest a chart can be set, as a share of --base
const GROW = 0.04 // how much + or − changes a chart's size
const NEW_SIZE = 0.4 // a chart newly laid on the table
const LONG_PRESS = 500 // ms

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const narrow = () => window.matchMedia('(max-width: 860px)').matches

type Drag = { id: ModuleId; kind: 'move' | 'size'; pointer: number; px: number; py: number; from: Place; moved: boolean }
/** The menu a long press or right-click opens: on a chart, or on empty paper at x, y (px in the table). */
type Menu = { x: number; y: number; chart?: ModuleId }

/** Home: every pinned module as a circular chart laid on the recorder's table. Drag a chart to set it where you like,
    drag its rim grip to size it, long-press (or right-click) the paper to lay a new chart or a chart to take it off, and
    save the layout when it's right. Choosing a chart opens its module. */
export function Garden({ arrangement, onArrange }: { arrangement: Arrangement; onArrange: () => void }) {
  const { pins, places, dirty, edit, save, discard } = arrangement
  const summaries = useSummaries()
  const [ref, size] = useSize<HTMLDivElement>()
  const [lifted, setLifted] = useState<{ id: ModuleId; at: Place } | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const drag = useRef<Drag | null>(null)
  const press = useRef<{ timer: number; px: number; py: number } | null>(null)
  const swallowClick = useRef(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const { width: W, height: H } = size
  // Mirrors garden.css: a chart's diameter is --base × its size.
  const base = Math.min(0.34 * W, 0.62 * H)
  const radius = (s: number) => base * s * 0.5
  const charts = pins.map((id, i) => {
    const [x, y, s] = SLOTS[i % SLOTS.length]
    const at = lifted?.id === id ? lifted.at : (places[id] ?? { x, y })
    return { id, i, at: { ...at, s: at.s ?? s } as Required<Place> }
  })
  const placed = (id: ModuleId) => charts.find((st) => st.id === id)?.at

  /** Keeps a chart wholly on the table, at a size the table can hold. */
  const inBounds = (at: Required<Place>): Required<Place> => {
    const s = clamp(at.s, SIZES[0], Math.min(SIZES[1], Math.min(W, H) / 2 / radius(1)))
    const r = radius(s)
    return { x: clamp(at.x, r / W, 1 - r / W), y: clamp(at.y, r / H, 1 - r / H), s }
  }

  /** Where a set-down chart comes to rest: on the table, and nudged clear of any chart it was dropped onto or grown into. */
  const settle = (id: ModuleId, at: Required<Place>): Required<Place> => {
    const { s } = inBounds(at)
    const r = radius(s)
    let px = at.x * W
    let py = at.y * H
    for (let pass = 0; pass < 4; pass++) {
      for (const o of charts) {
        if (o.id === id) continue
        const ox = o.at.x * W
        const oy = o.at.y * H
        const min = r + radius(o.at.s) + GAP
        let dx = px - ox
        let dy = py - oy
        const d = Math.hypot(dx, dy)
        if (d >= min) continue
        if (d < 0.5) [dx, dy] = [1, 0]
        else [dx, dy] = [dx / d, dy / d]
        px = ox + dx * min
        py = oy + dy * min
      }
      px = clamp(px, r, W - r)
      py = clamp(py, r, H - r)
    }
    return { x: px / W, y: py / H, s }
  }

  const set = (id: ModuleId, at: Required<Place>) => edit({ places: { ...places, [id]: settle(id, at) } })

  // Adding or removing a chart changes which authored slot the others would fall back to, so every chart is
  // first held where it lies now.
  const held = (): Places => Object.fromEntries(charts.map((st) => [st.id, st.at]))

  const lift = (id: ModuleId) => {
    const next = held()
    delete next[id]
    edit({ pins: pins.filter((p) => p !== id), places: next })
    setMenu(null)
  }

  const add = (id: ModuleId, x: number, y: number) => {
    edit({ pins: [...pins, id], places: { ...held(), [id]: settle(id, { x: x / W, y: y / H, s: NEW_SIZE }) } })
    setMenu(null)
  }

  /** Where the chart under a drag is now: moved with the pointer, or sized so its rim follows the pointer. */
  const follow = (d: Drag, e: ReactPointerEvent): Required<Place> => {
    const from = { ...d.from, s: d.from.s ?? placed(d.id)!.s }
    if (d.kind === 'move') return inBounds({ ...from, x: from.x + (e.clientX - d.px) / W, y: from.y + (e.clientY - d.py) / H })
    const box = ref.current!.getBoundingClientRect()
    const reach = Math.hypot(e.clientX - box.left - from.x * W, e.clientY - box.top - from.y * H)
    return inBounds({ ...from, s: reach / radius(1) })
  }

  const inGarden = (e: { clientX: number; clientY: number }) => {
    const box = ref.current!.getBoundingClientRect()
    return { x: e.clientX - box.left, y: e.clientY - box.top }
  }

  /** Starts a long press; held still for LONG_PRESS, it opens the menu. */
  const pressStart = (e: ReactPointerEvent, open: () => void) => {
    pressEnd()
    press.current = {
      px: e.clientX,
      py: e.clientY,
      timer: window.setTimeout(() => {
        press.current = null
        drag.current = null
        setLifted(null)
        swallowClick.current = true
        open()
      }, LONG_PRESS),
    }
  }
  const pressMoved = (e: ReactPointerEvent) => {
    if (press.current && Math.hypot(e.clientX - press.current.px, e.clientY - press.current.py) >= 5) pressEnd()
  }
  const pressEnd = () => {
    if (press.current) window.clearTimeout(press.current.timer)
    press.current = null
  }

  const chartMenu = (id: ModuleId) => {
    const at = placed(id)!
    setMenu({ chart: id, x: at.x * W, y: at.y * H })
  }

  const handlers = (id: ModuleId, kind: Drag['kind']) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      swallowClick.current = false
      if (kind === 'move') pressStart(e, () => chartMenu(id))
      if (!W || narrow()) return
      if (kind === 'size') e.preventDefault()
      // Captured at once: a grip is small, and the first move already leaves it.
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { id, kind, pointer: e.pointerId, px: e.clientX, py: e.clientY, from: placed(id)!, moved: false }
    },
    onPointerMove: (e: ReactPointerEvent) => {
      pressMoved(e)
      const d = drag.current
      if (!d || d.pointer !== e.pointerId || d.kind !== kind) return
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.px, e.clientY - d.py) < (kind === 'move' ? 5 : 1)) return
        d.moved = true
        setMenu(null)
      }
      setLifted({ id, at: follow(d, e) })
    },
    onPointerUp: (e: ReactPointerEvent) => {
      pressEnd()
      const d = drag.current
      if (!d || d.kind !== kind) return
      drag.current = null
      if (!d.moved) return
      swallowClick.current = true
      set(id, follow(d, e))
      setLifted(null)
    },
    onPointerCancel: () => {
      pressEnd()
      drag.current = null
      setLifted(null)
    },
  })

  const resizeKey = (id: ModuleId, e: ReactKeyboardEvent, keys: Record<string, number>) => {
    const grow = keys[e.key]
    if (!grow || !W || narrow()) return false
    e.preventDefault()
    const at = placed(id)!
    set(id, { ...at, s: at.s + grow * GROW })
    return true
  }

  // A menu closes on Escape or a press anywhere outside it, and takes focus when it opens.
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const away = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', esc)
    }
  }, [menu])

  const unpinned = MODULES.filter((m) => !pins.includes(m.id))

  return (
    <section className="garden" aria-label="Modules">
      <div
        className="garden__bed"
        ref={ref}
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as Element).closest('.garden__spot, .garden__menu')) return
          const at = inGarden(e)
          pressStart(e, () => setMenu(at))
        }}
        onPointerMove={(e) => {
          if (!(e.target as Element).closest('.garden__spot')) pressMoved(e)
        }}
        onPointerUp={pressEnd}
        onPointerCancel={pressEnd}
        onContextMenu={(e) => {
          if ((e.target as Element).closest('.garden__menu')) return
          e.preventDefault()
          pressEnd()
          const chart = (e.target as Element).closest<HTMLElement>('[data-chart]')?.dataset.chart as ModuleId | undefined
          if (chart) chartMenu(chart)
          else setMenu(inGarden(e))
        }}
      >
        <Graticule {...size} />
        <ul className="garden__charts">
          {charts.map(({ id, i, at }) => {
            const s = summaries[id]
            const m = meta(id)
            const tone = s?.off ? 'off' : s?.fault ? 'signal' : 'ink'
            const reading = [s?.value, s?.caption, s?.subject].filter(Boolean).join(', ')
            // A chart that needs you is never quiet, whatever its numbers say; one still waiting for them is.
            const quiet = !s || (!!s.quiet && !s.fault && !s.off)
            return (
              <li
                key={id}
                data-chart={id}
                className={`garden__spot${lifted?.id === id ? ' is-lifted' : ''}`}
                style={{ '--x': at.x, '--y': at.y, '--s': at.s, '--i': i } as CSSProperties}
              >
                <a
                  className={`chart mod-${id}${s?.fault ? ' is-fault' : ''}${s?.off ? ' is-off' : ''}`}
                  href={`#/m/${id}`}
                  draggable={false}
                  aria-label={reading ? `${m.label}: ${reading}` : m.label}
                  title="Drag to move this chart (or Shift + arrow keys); + and − size it; long-press to take it off"
                  {...handlers(id, 'move')}
                  onClick={(e) => {
                    // The click that ends a drag or a long press doesn't open the module.
                    if (swallowClick.current) e.preventDefault()
                    swallowClick.current = false
                  }}
                  onKeyDown={(e) => {
                    if (resizeKey(id, e, { '+': 1, '=': 1, '-': -1 })) return
                    const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
                    if (!e.shiftKey || !move || !W || narrow()) return
                    e.preventDefault()
                    set(id, { ...at, x: at.x + move[0] * STEP, y: at.y + move[1] * STEP * (W / H) })
                  }}
                >
                  <Dial
                    label={m.label}
                    value={s?.value ?? '·'}
                    fraction={s?.fraction ?? null}
                    tone={tone}
                    caption={s?.subject ?? s?.caption}
                    quiet={quiet}
                    busy={!!s?.busy && !s.off}
                    chart={s?.chart}
                  />
                </a>
                {/* A grip on the rim: drag it out to grow the chart, in to shrink it. */}
                <button
                  className="chart__grip"
                  type="button"
                  aria-label={`Resize the ${m.label} chart`}
                  title="Drag to resize; arrow keys also work"
                  {...handlers(id, 'size')}
                  onKeyDown={(e) => resizeKey(id, e, { ArrowUp: 1, ArrowRight: 1, '+': 1, '=': 1, ArrowDown: -1, ArrowLeft: -1, '-': -1 })}
                />
              </li>
            )
          })}
        </ul>
        {menu && (
          <div
            ref={menuRef}
            className="garden__menu"
            role="menu"
            aria-label={menu.chart ? meta(menu.chart).label : 'Add a chart here'}
            // Opens toward the open side of the table, so it never runs off it.
            style={{
              left: clamp(menu.x, 8, Math.max(8, W - 228)),
              ...(menu.y > H / 2 ? { bottom: H - menu.y } : { top: menu.y }),
            }}
          >
            {menu.chart ? (
              <>
                <p className="garden__menu-title">{meta(menu.chart).label}</p>
                <a className="garden__menu-item" role="menuitem" href={`#/m/${menu.chart}`} onClick={() => setMenu(null)}>
                  Open
                </a>
                <button className="garden__menu-item" role="menuitem" type="button" disabled={pins.length === 1} onClick={() => lift(menu.chart!)}>
                  Take off home
                </button>
              </>
            ) : (
              <>
                <p className="garden__menu-title">Add a chart here</p>
                {unpinned.length ? (
                  unpinned.map((m) => (
                    <button key={m.id} className={`garden__menu-item mod-${m.id}`} role="menuitem" type="button" onClick={() => add(m.id, menu.x, menu.y)}>
                      <span className="garden__menu-dot" aria-hidden="true" />
                      {m.label}
                    </button>
                  ))
                ) : (
                  <p className="garden__menu-empty">Every module is already on home.</p>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {/* Below the table, never on it, so it can't cover a chart however many are pinned. */}
      <div className="garden__foot">
        {dirty ? (
          <>
            <span className="garden__note">Unsaved layout</span>
            <button className="garden__arrange" type="button" onClick={discard} title="Put the charts back as they were last saved">
              Discard
            </button>
            <button className="garden__arrange garden__save" type="button" onClick={save}>
              Save layout
            </button>
          </>
        ) : (
          Object.keys(places).length > 0 && (
            <button className="garden__arrange" type="button" onClick={() => edit({ places: {} })} title="Put every chart back where it first lay, at its first size">
              Reset layout
            </button>
          )
        )}
        <button className="garden__arrange" type="button" onClick={onArrange} title="Choose which modules are on home">
          <Icon name="sliders" size={16} /> Arrange
        </button>
      </div>
    </section>
  )
}
