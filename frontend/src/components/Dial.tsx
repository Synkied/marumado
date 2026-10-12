import type { Chart } from '../modules/registry'
import './dial.css'

type Props = {
  value: string
  /** 0..1 of the channel: how far round the needle's arc goes. null draws only the scale. */
  fraction: number | null
  tone?: 'ink' | 'signal' | 'off'
  caption?: string
  /** The channel's name, printed on the dial's face, as on the home table. Elsewhere the label sits beside the dial. */
  label?: string
  size?: 'lg' | 'md'
  /** Nothing to look at: the marks draw lighter. */
  quiet?: boolean
  /** Something is at work: the dial's light pulses. */
  busy?: boolean
  /** Its recent record: a trace, event ticks, or one lane per item. */
  chart?: Chart
}

// A Braun dial: a round face sunk into the panel, a 270° scale from seven-thirty round to four-thirty, the reading in
// mono in the middle. The value runs along the scale as an arc; the recent record stands inside it as scale marks,
// oldest at the left, newest at the right; one lane per item splits the scale into segments.
const C = 100
const SCALE = 80 // the arc's radius
const MARKS = 66 // where the record's marks start, reaching inwards
const MARK_MAX = 18
const START = 0.625 // seven-thirty, in turns from twelve o'clock
const SWEEP = 0.75

const polar = (r: number, turn: number) => {
  const a = turn * 2 * Math.PI - Math.PI / 2
  return [C + r * Math.cos(a), C + r * Math.sin(a)] as const
}
const pt = (r: number, turn: number) => polar(r, turn).map((n) => n.toFixed(2)).join(' ')

/** An arc along the scale, from one fraction of it to another (0..1). */
function arc(r: number, from: number, to: number) {
  const a = START + from * SWEEP
  const b = START + Math.max(from + 0.0001, to) * SWEEP
  return `M${pt(r, a)}A${r} ${r} 0 ${b - a > 0.5 ? 1 : 0} 1 ${pt(r, b)}`
}

/** One scale mark at a fraction of the scale, as long as its value (0..1). */
function mark(at: number, v: number) {
  const t = START + at * SWEEP
  const len = 3 + Math.max(0, Math.min(1, v)) * (MARK_MAX - 3)
  return `M${pt(MARKS, t)}L${pt(MARKS - len, t)}`
}

/** A module's channel as a dial: the reading in the middle, its value on the scale, its recent record as marks. */
export function Dial({ value, fraction, tone = 'ink', caption, label, size = 'lg', quiet = false, busy = false, chart }: Props) {
  const off = tone === 'off'
  const signal = tone === 'signal'
  const f = Math.max(0, Math.min(1, fraction ?? 0))

  let record = null
  let lanes = false
  if (!off && chart?.kind === 'trace' && chart.values.some((v) => v != null)) {
    const n = chart.values.length
    // On the alarm, the newest eighth of the record is marked in orange.
    const split = signal ? Math.max(0, n - Math.ceil(n / 8)) : n
    record = chart.values.map((v, i) =>
      v == null ? null : <path key={i} className={`dial__mark${i >= split ? ' dial__mark--signal' : ''}`} d={mark(n > 1 ? i / (n - 1) : 1, v)} />,
    )
  } else if (!off && chart?.kind === 'ticks' && chart.values.length) {
    const n = chart.values.length
    const top = Math.max(1, ...chart.values)
    // Square-root scale, so one busy week doesn't flatten the rest.
    record = chart.values.map((v, i) => (
      <path key={i} className={`dial__mark${v ? '' : ' dial__mark--none'}`} d={mark(n > 1 ? i / (n - 1) : 1, v ? Math.sqrt(v / top) : 0)} />
    ))
  } else if (!off && chart?.kind === 'lanes' && chart.items.length) {
    lanes = true
    const n = chart.items.length
    const gap = n > 1 ? Math.min(0.03, 0.3 / n) : 0
    record = chart.items.map((state, i) => (
      <path key={i} className={`dial__lane dial__lane--${state}`} d={arc(SCALE, i / n + gap / 2, (i + 1) / n - gap / 2)} />
    ))
  }

  return (
    <div className={`dial dial--${size} dial--${tone}${label ? ' dial--named' : ''}${quiet ? ' dial--quiet' : ''}${busy ? ' dial--busy' : ''}`}>
      <div className="dial__face">
        <svg viewBox="0 0 200 200" aria-hidden="true">
          <path className="dial__scale" d={arc(SCALE, 0, 1)} />
          {!off && !lanes && fraction !== null && f > 0 && <path className="dial__value-arc" d={arc(SCALE, 0, f)} pathLength={1} />}
          <g className="dial__record">{record}</g>
          {(busy || signal) && !off && <circle className="dial__light" cx={polar(93, 0)[0]} cy={polar(93, 0)[1]} r={5} />}
        </svg>
        <span className="dial__text">
          <span className="dial__value">{value}</span>
          {label && <span className="dial__label">{label}</span>}
          {label && caption && <span className="dial__sub">{caption}</span>}
        </span>
        {label && chart && 'span' in chart && chart.span && !off && <span className="dial__span">{chart.span}</span>}
      </div>
      {!label && caption && <span className="dial__caption">{caption}</span>}
    </div>
  )
}
