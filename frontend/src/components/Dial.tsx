import { useId } from 'react'
import type { Chart } from '../modules/registry'
import './dial.css'

type Props = {
  value: string
  /** 0..1 of the channel; drawn as an arc only when there is no chart to draw. null draws only the graticule. */
  fraction: number | null
  tone?: 'ink' | 'signal' | 'off'
  caption?: string
  /** The channel's name, printed on the disc itself, as on the home table. Elsewhere the label sits beside the disc. */
  label?: string
  size?: 'lg' | 'md'
  /** Nothing to look at: the pen draws lighter. */
  quiet?: boolean
  /** Something is at work: the pen tip pulses where it writes. */
  busy?: boolean
  /** What the pen has drawn: a trace, event ticks, or one lane per item. */
  chart?: Chart
}

// A circular chart, read from twelve o'clock clockwise: the oldest record just past the top, "now" at the top,
// where the pen sits. The hub in the middle carries the reading.
const C = 100
const RIM = 96
const HUB = 44
const BAND = [52, 90] // where a trace runs, from its zero to its full scale
const RINGS = [52, 66, 80]
const SPOKES = 12
const LANE = 82

const polar = (r: number, turn: number) => {
  const a = turn * 2 * Math.PI - Math.PI / 2
  return [C + r * Math.cos(a), C + r * Math.sin(a)] as const
}
const pt = (r: number, turn: number) => polar(r, turn).map((n) => n.toFixed(2)).join(' ')

/** An arc on the disc, from one turn to another (0..1 from twelve o'clock). */
function arc(r: number, from: number, to: number) {
  const large = to - from > 0.5 ? 1 : 0
  return `M${pt(r, from)}A${r} ${r} 0 ${large} 1 ${pt(r, to)}`
}

/** A trace as polar path segments, broken wherever a sample is missing. `from` is the first sample to draw. */
function tracePath(values: (number | null)[], from = 0, to = values.length) {
  const n = values.length
  let d = ''
  let pen = false
  for (let i = from; i < to; i++) {
    const v = values[i]
    if (v == null) {
      pen = false
      continue
    }
    const r = BAND[0] + Math.max(0, Math.min(1, v)) * (BAND[1] - BAND[0])
    // The newest sample lands just before the top, where the pen sits.
    d += `${pen ? 'L' : 'M'}${pt(r, (i + 1) / n)}`
    pen = true
  }
  return d
}

/** A module's channel as a circular chart disc: the reading in the hub, its recent record drawn around it by its pen. */
export function Dial({ value, fraction, tone = 'ink', caption, label, size = 'lg', quiet = false, busy = false, chart }: Props) {
  const clip = useId()
  const off = tone === 'off'
  const signal = tone === 'signal'
  const f = Math.max(0, Math.min(1, fraction ?? 0))

  let record = null
  if (!off && chart?.kind === 'trace' && chart.values.some((v) => v != null)) {
    const n = chart.values.length
    // On the alarm, the newest eighth of the record is drawn by the alarm pen.
    const split = signal ? Math.max(0, n - Math.ceil(n / 8)) : n
    const last = [...chart.values].reverse().findIndex((v) => v != null)
    const tip = last >= 0 ? chart.values[n - 1 - last]! : null
    record = (
      <>
        <path className="dial__trace" d={tracePath(chart.values, 0, Math.min(n, split + 1))} pathLength={1} />
        {signal && <path className="dial__trace dial__trace--signal" d={tracePath(chart.values, split)} />}
        {tip != null && last === 0 && <circle className="dial__tip" cx={polar(BAND[0] + tip * (BAND[1] - BAND[0]), 1)[0]} cy={polar(BAND[0] + tip * (BAND[1] - BAND[0]), 1)[1]} r={3.2} />}
      </>
    )
  } else if (!off && chart?.kind === 'ticks' && chart.values.length) {
    const n = chart.values.length
    const top = Math.max(1, ...chart.values)
    record = chart.values.map((v, i) => {
      const turn = (i + 0.5) / n
      if (!v) return <circle key={i} className="dial__tick-dot" cx={polar(RIM - 7, turn)[0]} cy={polar(RIM - 7, turn)[1]} r={1.3} />
      // Square-root scale, so one busy week doesn't flatten the rest.
      const len = 6 + Math.sqrt(v / top) * 30
      return <path key={i} className="dial__tick" d={`M${pt(RIM - 7, turn)}L${pt(RIM - 7 - len, turn)}`} />
    })
  } else if (!off && chart?.kind === 'lanes' && chart.items.length) {
    const n = chart.items.length
    const gap = n > 1 ? Math.min(0.02, 0.25 / n) : 0
    record = chart.items.map((state, i) => {
      const from = i / n + gap / 2
      const to = n === 1 ? 0.9999 : (i + 1) / n - gap / 2
      return <path key={i} className={`dial__lane dial__lane--${state}`} d={arc(LANE, from, to)} />
    })
  } else if (!off && fraction !== null && f > 0) {
    record = <path className="dial__lane dial__lane--on" d={arc(LANE, 0, Math.min(f, 0.9999))} />
  }

  return (
    <div className={`dial dial--${size} dial--${tone}${label ? ' dial--named' : ''}${quiet ? ' dial--quiet' : ''}${busy ? ' dial--busy' : ''}`}>
      <div className="dial__face">
        <svg viewBox="0 0 200 200" aria-hidden="true">
          <clipPath id={clip}>
            <circle cx={C} cy={C} r={RIM} />
          </clipPath>
          <circle className="dial__paper" cx={C} cy={C} r={RIM} />
          <g className="dial__grid" clipPath={`url(#${clip})`}>
            {RINGS.map((r) => (
              <circle key={r} cx={C} cy={C} r={r} />
            ))}
            {Array.from({ length: SPOKES }, (_, i) => (
              <path key={i} d={`M${pt(HUB, i / SPOKES)}L${pt(RIM, i / SPOKES)}`} />
            ))}
          </g>
          <circle className="dial__rim" cx={C} cy={C} r={RIM} />
          {/* "Now": the pen's place at the top of the disc. */}
          {!off && <path className="dial__now" d={`M${pt(RIM + 1, 0)}L${pt(RIM - 6, 0)}`} />}
          <g className="dial__record">{record}</g>
          {busy && !off && <circle className="dial__pulse" cx={C} cy={C - RIM} r={4} />}
          <circle className="dial__hub" cx={C} cy={C} r={HUB} />
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
