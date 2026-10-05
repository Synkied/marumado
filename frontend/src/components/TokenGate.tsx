import { useEffect, useState, type ReactNode } from 'react'
import { ApiError, logIn } from '../lib/api'
import { desktop, desktopLogIn, inDesktop } from '../lib/desktop'
import { useHub } from '../lib/hub'

/** Marumado always needs its password or access token: ask for it once, and the browser stays logged in. */
export function TokenGate({ children }: { children: ReactNode }) {
  const { error } = useHub()
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const locked = error instanceof ApiError && error.status === 403
  // The desktop app logs its window in with the token it was given; the form shows if that is refused.
  const [auto, setAuto] = useState(inDesktop)
  useEffect(() => {
    if (locked && auto) desktopLogIn().then((ok) => (ok ? window.location.reload() : setAuto(false)))
  }, [locked, auto])
  if (!locked) return <>{children}</>
  if (auto) return <main className="app" aria-busy="true" />
  return (
    <main className="app" style={{ alignContent: 'center', justifyItems: 'center' }}>
      <form
        className="sheet"
        style={{ width: 'min(440px, 100%)' }}
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setProblem('')
          try {
            await logIn(value.trim())
            window.location.reload()
          } catch (err) {
            setProblem(err instanceof Error ? err.message : 'Could not log in.')
            setBusy(false)
          }
        }}
      >
        <h1 className="sheet__title">Marumado</h1>
        <p className="sheet__lede">
          This Marumado is protected. Enter its password (set with <code>make password</code>) or its access token
          (<code>make access-token</code> prints it).
        </p>
        <label className="field">
          Password or access token
          <input
            type="password"
            autoComplete="current-password"
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={!!problem}
            aria-describedby={problem ? 'token-problem' : undefined}
          />
        </label>
        {problem && (
          <p id="token-problem" className="notice signal-text" role="alert">
            {problem}
          </p>
        )}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
        {inDesktop && (
          <p className="sheet__lede">
            The desktop app&rsquo;s token was refused.{' '}
            <button type="button" className="btn btn--quiet" onClick={() => desktop('reconnect')}>
              Connect again or to another Marumado…
            </button>
          </p>
        )}
      </form>
    </main>
  )
}
