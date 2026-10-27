import { useState } from 'react'
import { copy } from '../components/Terminal'
import { api } from '../lib/api'
import { ago } from '../lib/format'
import { useHub } from '../lib/hub'
import { Secret } from '../lib/streaming'
import type { SecurityAudit, SecurityFinding, Severity } from '../lib/types'
import { SheetHead, ViewTabs } from './sheetHead'
import './security.css'

/** Worst first, each under a heading that says how soon it matters. */
const GROUPS: [Severity, string][] = [
  ['high', 'Fix now'],
  ['medium', 'Worth fixing'],
  ['low', 'To consider'],
  ['info', 'Good to know'],
]

const AREA: Record<SecurityFinding['area'], string> = {
  network: 'Network',
  marumado: 'Marumado',
  processes: 'Processes',
  containers: 'Containers',
  system: 'System',
  secrets: 'Keys and secrets',
}

/** The machine's security audit: what is open to the network, what runs that shouldn't, how SSH, updates and
    containers are set up, and secrets in the projects. Each finding says what to do; nothing is changed from here. */
export function SecuritySheet() {
  const { security, refreshSecurity } = useHub()
  const [audit, setAudit] = useState<SecurityAudit>()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // An answer of our own (a fresh run, an acceptance) wins until the next poll brings a newer one.
  const data = audit && (!security || audit.checked_at >= security.checked_at) ? audit : security

  const run = async (call: () => Promise<SecurityAudit>) => {
    setErr('')
    setBusy(true)
    try {
      setAudit(await call())
      refreshSecurity()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The audit failed')
    } finally {
      setBusy(false)
    }
  }
  const recheck = () => run(() => api<SecurityAudit>('security?fresh=1'))
  const accept = (id: string, note: string) => run(() => api<SecurityAudit>('security/accept', { method: 'POST', json: { id, note } }))
  const reopen = (id: string) => run(() => api<SecurityAudit>(`security/accept?id=${encodeURIComponent(id)}`, { method: 'DELETE' }))

  if (!data) return <div className="sheet__empty">Checking this machine…</div>

  const open = data.findings.filter((f) => !f.accepted)
  const accepted = data.findings.filter((f) => f.accepted)
  const count = (s: Severity) => open.filter((f) => f.severity === s).length
  const urgent = count('high') + count('medium')

  return (
    <div className="sheet">
      <SheetHead id="machine">
        <button className="chip" type="button" onClick={recheck} disabled={busy}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
      </SheetHead>
      <ViewTabs at="security" />
      <p className="sheet__lede">
        {urgent ? (
          <>
            <strong className={count('high') ? 'signal-text' : undefined}>
              {urgent} thing{urgent > 1 ? 's' : ''} to fix
            </strong>
            {count('low') ? `, ${count('low')} to consider` : ''}.
          </>
        ) : open.length ? (
          `Nothing urgent; ${open.length} thing${open.length > 1 ? 's' : ''} to consider.`
        ) : (
          'Nothing found.'
        )}{' '}
        Checked {ago(data.checked_at)}. Commands are to run on this machine yourself: nothing is changed from here.
      </p>

      {GROUPS.map(([severity, label]) => {
        const items = open.filter((f) => f.severity === severity)
        return items.length ? (
          <section className="sheet__section" key={severity}>
            <h3>{label}</h3>
            <ul className="list">
              {items.map((f) => (
                <Finding key={f.id} finding={f} busy={busy} onAccept={(note) => accept(f.id, note)} />
              ))}
            </ul>
          </section>
        ) : null
      })}

      {accepted.length > 0 && (
        <details className="sheet__section sec__accepted">
          <summary>
            <h3>Accepted risks · {accepted.length}</h3>
          </summary>
          <ul className="list">
            {accepted.map((f) => (
              <li className="row row--muted" key={f.id}>
                <span className="row__main">
                  {f.title}
                  <span className="row__sub">
                    {f.accepted!.note || 'No reason given'} · {ago(f.accepted!.at)}
                  </span>
                </span>
                <button className="chip" type="button" onClick={() => reopen(f.id)} disabled={busy}>
                  Reopen
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {data.unknown.map((u) => (
        <p className="notice" key={u}>
          {u}
        </p>
      ))}
      {err && <p className="notice signal-text">{err}</p>}
    </div>
  )
}

function Finding({ finding: f, busy, onAccept }: { finding: SecurityFinding; busy: boolean; onAccept: (note: string) => void }) {
  const [accepting, setAccepting] = useState(false)
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState(false)
  const lamp = f.severity === 'high' ? ' row__lamp--fault' : f.severity === 'medium' ? ' sec__lamp--medium' : ''
  return (
    <li className="block sec__finding">
      <div className="row">
        <span className={`row__lamp${lamp}`} role="img" aria-label={f.severity} />
        <span className="row__main">
          {f.title}
          <span className="row__sub">{f.detail}</span>
        </span>
        <span className="sec__area">{AREA[f.area]}</span>
      </div>
      <div className="sec__body">
        <p className="sec__action">{f.action}</p>
        {f.command && (
          <div className="sec__command">
            <pre className="mono">
              <Secret label="Command">{f.command}</Secret>
            </pre>
            <button
              className="chip"
              type="button"
              onClick={() => {
                copy(f.command)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
        {accepting ? (
          <form
            className="sec__accept"
            onSubmit={(e) => {
              e.preventDefault()
              onAccept(note.trim())
            }}
          >
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it is fine here (optional)" aria-label="Why the risk is accepted" autoFocus />
            <button className="chip" type="submit" disabled={busy}>
              Accept
            </button>
            <button className="chip" type="button" onClick={() => setAccepting(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <div className="chips">
            <button className="chip" type="button" onClick={() => setAccepting(true)}>
              Accept the risk
            </button>
          </div>
        )}
      </div>
    </li>
  )
}
