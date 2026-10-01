import { useEffect, useState } from 'react'
import './dial.css'

type Props = {
  value: string
  /** 0..1 fill of the arc; null draws only the track. */
  fraction: number | null
  tone?: 'ink' | 'signal' | 'off'
  caption?: string
  size?: 'lg' | 'md'
}

const R = 52
const C = 2 * Math.PI * R

export function Dial({ value, fraction, tone = 'ink', caption, size = 'lg' }: Props) {
  // Sweep from empty once on mount, then follow values without tweening.
  const [mounted, setMounted] = useState(false)
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true))
    const t = window.setTimeout(() => setSettled(true), 1200)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(t)
    }
  }, [])
  const f = Math.max(0, Math.min(1, fraction ?? 0))
  const offset = C * (1 - (mounted ? f : 0))

  return (
    <div className={`dial dial--${size} dial--${tone}`}>
      <div className="dial__face">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle className="dial__rim" cx="60" cy="60" r="58" />
          <circle className={tone === 'off' ? 'dial__track dial__track--off' : 'dial__track'} cx="60" cy="60" r={R} />
          {fraction !== null && tone !== 'off' && (
            <circle
              className={`dial__arc${settled ? ' is-settled' : ''}`}
              cx="60"
              cy="60"
              r={R}
              strokeDasharray={C}
              strokeDashoffset={offset}
              transform="rotate(-90 60 60)"
            />
          )}
          <circle className="dial__pip" cx="6" cy="60" r="1.8" />
          <circle className="dial__pip" cx="114" cy="60" r="1.8" />
        </svg>
        <span className="dial__value">{value}</span>
      </div>
      {caption && <span className="dial__caption">{caption}</span>}
    </div>
  )
}
