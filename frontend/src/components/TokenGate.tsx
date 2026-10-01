import { useState, type ReactNode } from 'react'
import { ApiError, setToken } from '../lib/api'
import { useHub } from '../lib/hub'

/** When the backend requires MARUMADO_TOKEN, ask for it once and keep it in this browser. */
export function TokenGate({ children }: { children: ReactNode }) {
  const { error } = useHub()
  const [value, setValue] = useState('')
  if (!(error instanceof ApiError && error.status === 403)) return <>{children}</>
  return (
    <main className="app" style={{ alignContent: 'center', justifyItems: 'center' }}>
      <form
        className="sheet"
        style={{ width: 'min(440px, 100%)' }}
        onSubmit={(e) => {
          e.preventDefault()
          setToken(value.trim())
          window.location.reload()
        }}
      >
        <h1 className="sheet__title">Marumado</h1>
        <p className="sheet__lede">This Marumado is protected. Enter the access token set in MARUMADO_TOKEN on the host.</p>
        <label className="field">
          Access token
          <input type="password" autoComplete="current-password" required value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <button className="btn" type="submit">
          Unlock
        </button>
      </form>
    </main>
  )
}
