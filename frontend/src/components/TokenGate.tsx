import { useState, type ReactNode } from 'react'
import { ApiError, logIn } from '../lib/api'
import { useHub } from '../lib/hub'

/** Marumado always needs its password or access token: ask for it once, and the browser stays logged in. */
export function TokenGate({ children }: { children: ReactNode }) {
  const { error } = useHub()
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  if (!(error instanceof ApiError && error.status === 403)) return <>{children}</>
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
      </form>
    </main>
  )
}
