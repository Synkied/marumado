/** A percentage bar, with an optional budget mark past which it turns to the alert colour. */
export function Meter({ percent, budget, label }: { percent: number; budget?: number; label?: string }) {
  // Spans, so a meter can sit inside a button or a heading.
  return (
    <span className="meter" role="meter" aria-label={label} aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      <span className={`meter__fill${budget && percent >= budget ? ' meter__fill--fault' : ''}`} style={{ width: `${Math.min(100, percent)}%` }} />
      {budget && <span className="meter__budget" style={{ left: `${budget}%` }} aria-hidden="true" />}
    </span>
  )
}
