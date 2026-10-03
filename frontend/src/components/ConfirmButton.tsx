import { useEffect, useState, type ReactNode } from 'react'

/** Two-step destructive action: first press arms it, second press within 4s runs it. */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel,
  className = 'btn btn--quiet',
  disabled,
  title,
}: {
  onConfirm: () => void | Promise<void>
  children: ReactNode
  confirmLabel: string
  className?: string
  disabled?: boolean
  /** what the action does, on hover */
  title?: string
}) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), 4000)
    return () => window.clearTimeout(t)
  }, [armed])
  return (
    <button
      type="button"
      className={`${className}${armed ? ' btn--armed' : ''}`}
      title={title}
      disabled={disabled || busy}
      onClick={async () => {
        if (!armed) return setArmed(true)
        setBusy(true)
        try {
          await onConfirm()
        } finally {
          setBusy(false)
          setArmed(false)
        }
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  )
}
