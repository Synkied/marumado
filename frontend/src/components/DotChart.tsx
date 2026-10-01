type Props = {
  values: (number | null)[]
  tone?: 'ink' | 'signal'
  height?: number
  /** Fixed top of the scale; defaults to a rounded max of the data. */
  max?: number
  label?: string
  unit?: string
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const n = v / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p
}

/** A dotted series drawn from data: one dot per sample, gaps for missing samples. */
export function DotChart({ values, tone = 'ink', height = 64, max, label, unit = '' }: Props) {
  const nums = values.filter((v): v is number => v != null)
  const top = max ?? niceMax(Math.max(0, ...nums))
  const w = 300
  const n = Math.max(values.length, 2)
  const pad = 2.5
  const pts = values.map((v, i) =>
    v == null ? null : { x: pad + (i / (n - 1)) * (w - pad * 2), y: pad + (1 - Math.min(v, top) / top) * (height - pad * 2) },
  )
  const fmt = (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : `${Math.round(v)}`)
  return (
    <figure className="dotchart" aria-label={label}>
      <div className="dotchart__axis" aria-hidden="true">
        <span>{fmt(top)}</span>
        <span>{fmt(top / 2)}</span>
        <span>0</span>
      </div>
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true">
        <line className="dotchart__base" x1="0" x2={w} y1={height - 0.5} y2={height - 0.5} />
        {pts.map((p, i) => p && <circle key={i} className={`dotchart__dot dotchart__dot--${tone}`} cx={p.x} cy={p.y} r="1.5" />)}
      </svg>
      {label && (
        <figcaption className="sr-only">
          {label}: latest {nums.length ? `${fmt(nums[nums.length - 1])}${unit}` : 'no data'}
        </figcaption>
      )}
    </figure>
  )
}
