import { downsample, niceMax } from '../lib/chart'

type Props = {
  values: (number | null)[]
  tone?: 'ink' | 'signal'
  height?: number
  /** Fixed top of the scale; defaults to a rounded max of the data. */
  max?: number
  label?: string
  unit?: string
  /** How far back the strip reaches, printed under its left end ("30 min"); the right end is now. */
  span?: string
}

const W = 600
const COLS = 12 // vertical graticule lines
const MOST = 300 // samples drawn at most; longer series are averaged down

/** A strip chart: the channel's pen running across ruled paper, oldest at the left, the pen tip at "now" on the right.
    Missing samples break the trace. */
export function DotChart({ values: raw, tone = 'ink', height = 72, max, label, unit = '', span }: Props) {
  const values = downsample(raw, MOST)
  const nums = values.filter((v): v is number => v != null)
  const top = max ?? niceMax(Math.max(0, ...nums))
  const n = Math.max(values.length, 2)
  const pad = 3
  const y = (v: number) => pad + (1 - Math.min(v, top) / top) * (height - pad * 2)
  let d = ''
  let pen = false
  values.forEach((v, i) => {
    if (v == null) {
      pen = false
      return
    }
    d += `${pen ? 'L' : 'M'}${((i / (n - 1)) * W).toFixed(1)} ${y(v).toFixed(1)}`
    pen = true
  })
  // The newest reading the pen made; when it stopped short of now, the break is where the channel went quiet.
  let last = values.length - 1
  while (last >= 0 && values[last] == null) last--
  const tip = last >= 0 ? values[last] : null
  const broke = last >= 0 && last < values.length - 1
  const at = (i: number) => (i / (n - 1)) * W
  const fmt = (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : `${Math.round(v)}`)
  return (
    <figure className={`strip strip--${tone}`} aria-label={label}>
      <div className="strip__axis" aria-hidden="true">
        <span>{fmt(top)}</span>
        <span>{fmt(top / 2)}</span>
        <span>0</span>
      </div>
      <div className="strip__paper">
        <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true">
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} className={`strip__grid${f === 0.5 ? ' strip__grid--major' : ''}`} x1="0" x2={W} y1={height * f} y2={height * f} />
          ))}
          {Array.from({ length: COLS - 1 }, (_, i) => (
            <line key={i} className={`strip__grid${(i + 1) % 3 === 0 ? ' strip__grid--major' : ''}`} x1={((i + 1) / COLS) * W} x2={((i + 1) / COLS) * W} y1="0" y2={height} />
          ))}
          <line className="strip__base" x1="0" x2={W} y1={height - 0.5} y2={height - 0.5} />
          <path className="strip__trace" d={d} />
          {broke && tone === 'signal' && <line className="strip__break" x1={at(last)} x2={at(last)} y1="0" y2={height} />}
        </svg>
        {/* The pen tip, drawn in HTML so it stays round however wide the strip is stretched. */}
        {tip != null && <span className="strip__tip" style={{ top: y(tip), left: `${(at(last) / W) * 100}%` }} aria-hidden="true" />}
        {span && (
          <div className="strip__time" aria-hidden="true">
            <span>−{span}</span>
            <span>now</span>
          </div>
        )}
      </div>
      {label && (
        <figcaption className="sr-only">
          {label}: latest {nums.length ? `${fmt(nums[nums.length - 1])}${unit}` : 'no data'}
        </figcaption>
      )}
    </figure>
  )
}
