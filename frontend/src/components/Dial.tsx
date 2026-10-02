import { useEffect, useState } from 'react'
import './dial.css'

type Props = {
  value: string
  /** 0..1 of the ripple arc; null draws only the rings. */
  fraction: number | null
  tone?: 'ink' | 'signal' | 'off'
  caption?: string
  /** A name set on the stone itself, as in the garden. Elsewhere the label sits beside the stone. */
  label?: string
  size?: 'lg' | 'md'
  /** Nothing to look at: the stone pales but keeps its mineral. */
  quiet?: boolean
  /** Something is at work: rings spread slowly from the stone, like a drop in still water. */
  busy?: boolean
}

// The stone sits in raked ripples; the reading is drawn as one ripple, raked darker from the top.
const STONE = 54
const RIPPLES = [64, 72, 80, 88, 96]
const ARC = 72
const C = 2 * Math.PI * ARC

/** A module's reading as a stone in the gravel: the value on the stone, the fraction as one darker ripple. */
export function Dial({ value, fraction, tone = 'ink', caption, label, size = 'lg', quiet = false, busy = false }: Props) {
  // Rake from empty once on mount, then follow values without tweening.
  const [mounted, setMounted] = useState(false)
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true))
    const t = window.setTimeout(() => setSettled(true), 1500)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(t)
    }
  }, [])
  const f = Math.max(0, Math.min(1, fraction ?? 0))
  const off = tone === 'off'
  const offset = C * (1 - (mounted ? f : 0))

  return (
    <div className={`dial dial--${size} dial--${tone}${label ? ' dial--named' : ''}${quiet ? ' dial--quiet' : ''}${busy ? ' dial--busy' : ''}`}>
      <div className="dial__face">
        {/* Two layers, so in the garden every stone lies above every other stone's ripples. */}
        <svg className="dial__bed" viewBox="0 0 200 200" aria-hidden="true">
          <circle className="dial__apron" cx="100" cy="100" r={RIPPLES[RIPPLES.length - 1] + 3} />
          {!off && RIPPLES.map((r) => <circle key={r} className="dial__ripple" cx="100" cy="100" r={r} />)}
          {busy && !off && [0, 1].map((n) => <circle key={n} className="dial__wave" cx="100" cy="100" r={RIPPLES[RIPPLES.length - 1]} style={{ animationDelay: `${n * -1.8}s` }} />)}
        </svg>
        <svg className="dial__body" viewBox="0 0 200 200" aria-hidden="true">
          {fraction !== null && !off && f > 0 && (
            <circle
              className={`dial__arc${settled ? ' is-settled' : ''}`}
              cx="100"
              cy="100"
              r={ARC}
              strokeDasharray={C}
              strokeDashoffset={offset}
              transform="rotate(-90 100 100)"
            />
          )}
          <circle className="dial__stone" cx="100" cy="100" r={STONE} />
        </svg>
        <span className="dial__text">
          {label && <span className="dial__label">{label}</span>}
          <span className="dial__value">{value}</span>
          {label && caption && <span className="dial__sub">{caption}</span>}
        </span>
      </div>
      {!label && caption && <span className="dial__caption">{caption}</span>}
    </div>
  )
}
