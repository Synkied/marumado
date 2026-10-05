import type { CSSProperties } from 'react'
import type { AgentStatus } from '../lib/types'
import './critter.css'

/** A small, seeded random: the same agent always draws the same critter. */
function seeded(key: string) {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  return () => {
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Topper = 'none' | 'ears' | 'points' | 'antenna' | 'sprout' | 'tuft' | 'horns'
type Marking = 'none' | 'ring' | 'spots' | 'band' | 'belly'

export type Traits = {
  rx: number
  ry: number
  /** how square the top and bottom of the body are: 0.55 is a circle */
  kTop: number
  kBottom: number
  topper: Topper
  marking: Marking
  eyeGap: number
  eyeY: number
  eyeTall: boolean
  feet: boolean
  /** blinks and breaths are out of step from one critter to the next */
  delay: number
  pace: number
}

const TOPPERS: Topper[] = ['none', 'ears', 'points', 'antenna', 'sprout', 'tuft', 'horns']
const MARKINGS: Marking[] = ['none', 'ring', 'spots', 'band', 'belly']

export function traitsOf(key: string): Traits {
  const r = seeded(key)
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]
  return {
    rx: 11 + r() * 3.5,
    ry: 10 + r() * 3,
    kTop: 0.45 + r() * 0.3,
    kBottom: 0.55 + r() * 0.25,
    topper: pick(TOPPERS),
    marking: pick(MARKINGS),
    eyeGap: 3.2 + r() * 2.6,
    eyeY: -2.5 + r() * 2.5,
    eyeTall: r() < 0.4,
    feet: r() < 0.7,
    delay: -r() * 6,
    pace: 0.85 + r() * 0.35,
  }
}

// The critter stands on the line at y = 42, its body centred on x = 24.
const CX = 24
const GROUND = 42

function bodyPath(t: Traits, cy: number) {
  const { rx, ry, kTop, kBottom } = t
  const top = cy - ry
  const bot = cy + ry
  return [
    `M${CX} ${top}`,
    `C${CX + rx * kTop} ${top} ${CX + rx} ${cy - ry * kTop} ${CX + rx} ${cy}`,
    `C${CX + rx} ${cy + ry * kBottom} ${CX + rx * kBottom} ${bot} ${CX} ${bot}`,
    `C${CX - rx * kBottom} ${bot} ${CX - rx} ${cy + ry * kBottom} ${CX - rx} ${cy}`,
    `C${CX - rx} ${cy - ry * kTop} ${CX - rx * kTop} ${top} ${CX} ${top}Z`,
  ].join(' ')
}

function Topper({ t, top }: { t: Traits; top: number }) {
  const w = t.rx * 0.55
  switch (t.topper) {
    case 'ears':
      return (
        <>
          <circle cx={CX - w} cy={top + 1.2} r={3} className="critter__fill" />
          <circle cx={CX + w} cy={top + 1.2} r={3} className="critter__fill" />
        </>
      )
    case 'points':
      return <path className="critter__fill" d={`M${CX - w - 3} ${top + 3}L${CX - w} ${top - 4}L${CX - w + 3} ${top + 2} M${CX + w - 3} ${top + 2}L${CX + w} ${top - 4}L${CX + w + 3} ${top + 3}`} />
    case 'antenna':
      return (
        <>
          <path d={`M${CX} ${top}C${CX} ${top - 3} ${CX + 2} ${top - 5} ${CX + 3} ${top - 6}`} />
          <circle cx={CX + 3.4} cy={top - 7} r={1.6} className="critter__ink" />
        </>
      )
    case 'sprout':
      return <path className="critter__fill" d={`M${CX} ${top}V${top - 4} M${CX} ${top - 3}C${CX - 1} ${top - 7} ${CX - 5} ${top - 7} ${CX - 6} ${top - 6}C${CX - 5} ${top - 3} ${CX - 2} ${top - 3} ${CX} ${top - 3}Z`} />
    case 'tuft':
      return <path d={`M${CX - 2.5} ${top + 0.6}L${CX - 3.5} ${top - 3} M${CX} ${top}V${top - 4} M${CX + 2.5} ${top + 0.6}L${CX + 3.5} ${top - 3}`} />
    case 'horns':
      return <path d={`M${CX - w} ${top + 2}C${CX - w - 1} ${top - 2} ${CX - w - 4} ${top - 3} ${CX - w - 5} ${top - 2} M${CX + w} ${top + 2}C${CX + w + 1} ${top - 2} ${CX + w + 4} ${top - 3} ${CX + w + 5} ${top - 2}`} />
    default:
      return null
  }
}

function Marking({ t, cy }: { t: Traits; cy: number }) {
  switch (t.marking) {
    // The chart disc it came from: a ring of the graticule on its belly.
    case 'ring':
      return <circle cx={CX} cy={cy + t.ry * 0.38} r={t.ry * 0.36} className="critter__mark" />
    case 'spots':
      return (
        <>
          <circle cx={CX - t.rx * 0.55} cy={cy + t.ry * 0.35} r={1} className="critter__ink critter__mark-ink" />
          <circle cx={CX - t.rx * 0.38} cy={cy + t.ry * 0.62} r={0.8} className="critter__ink critter__mark-ink" />
          <circle cx={CX + t.rx * 0.5} cy={cy + t.ry * 0.5} r={1} className="critter__ink critter__mark-ink" />
        </>
      )
    case 'band':
      return <path className="critter__mark" d={`M${CX - t.rx * 0.7} ${cy - t.ry * 0.62}Q${CX} ${cy - t.ry * 0.38} ${CX + t.rx * 0.7} ${cy - t.ry * 0.62}`} />
    case 'belly':
      return <path className="critter__mark" d={`M${CX - t.rx * 0.45} ${cy + t.ry * 0.85}Q${CX - t.rx * 0.5} ${cy + t.ry * 0.2} ${CX} ${cy + t.ry * 0.2}Q${CX + t.rx * 0.5} ${cy + t.ry * 0.2} ${CX + t.rx * 0.45} ${cy + t.ry * 0.85}`} />
    default:
      return null
  }
}

function Eyes({ t, status, cy }: { t: Traits; status: AgentStatus; cy: number }) {
  const y = cy + t.eyeY
  const g = t.eyeGap
  // Asleep at the prompt: closed. Its turn finished: content. Writing: looking down at the pen.
  if (status === 'idle') return <path className="critter__eyes" d={`M${CX - g - 1.6} ${y}q1.6 1.4 3.2 0 M${CX + g - 1.6} ${y}q1.6 1.4 3.2 0`} />
  if (status === 'done') return <path className="critter__eyes" d={`M${CX - g - 1.6} ${y + 0.6}q1.6 -1.8 3.2 0 M${CX + g - 1.6} ${y + 0.6}q1.6 -1.8 3.2 0`} />
  const look = status === 'working' ? 1.2 : 0
  const wide = status === 'blocked'
  const ry = wide ? 2.3 : t.eyeTall ? 2 : 1.4
  const rx = wide ? 1.8 : 1.4
  return (
    <g className="critter__eyes critter__blink">
      <ellipse cx={CX - g + look * 0.5} cy={y + look} rx={rx} ry={ry} className="critter__ink" />
      <ellipse cx={CX + g + look * 0.5} cy={y + look} rx={rx} ry={ry} className="critter__ink" />
    </g>
  )
}

/** What it is up to, drawn beside it: a pen writing its record, a question, sleep, a finished mark. */
function Prop({ status, t, cy }: { status: AgentStatus; t: Traits; cy: number }) {
  const side = CX + t.rx
  switch (status) {
    case 'working':
      return (
        <g className="critter__prop">
          <g className="critter__pen">
            <path d={`M${side - 1} ${cy + 3}l6 3`} />
            <path d={`M${side + 4} ${cy + 3.5}l4.5 6.5 -1.6 1 -4.5 -6.5Z`} className="critter__fill" />
          </g>
        </g>
      )
    case 'blocked':
      return (
        <g className="critter__prop critter__ask">
          <path d={`M${side - 1} ${cy - 1}l3.5 -6.5`} />
          <circle cx={side + 5} cy={cy - 13} r={5.2} className="critter__fill" />
          <path d={`M${side + 5} ${cy - 16}v3.6`} />
          <circle cx={side + 5} cy={cy - 10.6} r={0.7} className="critter__ink" />
        </g>
      )
    case 'idle':
      return <path className="critter__prop critter__z" d={`M${side} ${cy - t.ry - 2}h4l-4 4h4`} />
    case 'done':
      return <path className="critter__prop critter__check" pathLength={1} d={`M${side - 1} ${cy - t.ry}l2.6 2.6 5 -5.6`} />
    default:
      return null
  }
}

/** One agent as a small ink critter, unique to it (seeded by `seed`) and posed by what it is doing. Decorative: the
    control that holds it carries the words. */
export function Critter({ seed, status, size = 48 }: { seed: string; status: AgentStatus; size?: number }) {
  const t = traitsOf(seed)
  const cy = GROUND - (t.feet ? 2.5 : 0) - t.ry
  const style = { '--critter-delay': `${t.delay}s`, '--critter-pace': t.pace } as CSSProperties
  return (
    <svg className={`critter critter--${status}`} viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" style={style}>
      {/* At work it writes its own record along the ground, as every channel here does. */}
      {status === 'working' && <path className="critter__trace" pathLength={1} d={`M4 ${GROUND + 3.5}l3 -2 3 2.5 3 -3.5 3 3 3 -1 3 1.5 3 -2.5 3 2 3 -1.5 3 1`} />}
      <g className="critter__body">
        {t.feet && <path d={`M${CX - t.rx * 0.4} ${cy + t.ry - 0.5}v3 M${CX + t.rx * 0.4} ${cy + t.ry - 0.5}v3`} />}
        <Topper t={t} top={cy - t.ry} />
        <path className="critter__fill" d={bodyPath(t, cy)} />
        <Marking t={t} cy={cy} />
        <Eyes t={t} status={status} cy={cy} />
        <Prop status={status} t={t} cy={cy} />
      </g>
    </svg>
  )
}
