/** A percentage bar, with an optional budget mark past which it turns to the alert colour. */
export function Meter({ percent, budget }: { percent: number; budget?: number }) {
  return (
    <div className="meter" role="meter" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`meter__fill${budget && percent >= budget ? ' meter__fill--fault' : ''}`} style={{ width: `${Math.min(100, percent)}%` }} />
      {budget && <div className="meter__budget" style={{ left: `${budget}%` }} aria-hidden="true" />}
    </div>
  )
}
