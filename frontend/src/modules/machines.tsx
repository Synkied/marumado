import { useState, type FormEvent } from 'react'
import { ConfirmButton } from '../components/ConfirmButton'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { duration } from '../lib/format'
import { CPU_BUDGET, MEM_BUDGET } from '../lib/hub'
import { useMachines } from '../lib/machines'
import { go } from '../lib/route'
import type { Machine } from '../lib/types'
import { SheetHead } from './sheetHead'

const DISK_BUDGET = 90

export function MachinesSheet({ sub }: { sub?: string }) {
  const { machines } = useMachines()
  if (sub === 'new') return <MachineForm />
  if (sub?.startsWith('edit/')) {
    const machine = machines?.find((m) => String(m.id) === sub.slice(5))
    if (!machines) return <div className="sheet__empty">Loading…</div>
    return machine && !machine.local ? <MachineForm machine={machine} key={machine.id} /> : <MachinesList />
  }
  return <MachinesList />
}

function Reading({ label, percent, budget }: { label: string; percent: number; budget: number }) {
  return (
    <span className={percent >= budget ? 'signal-text' : undefined}>
      {label} {Math.round(percent)}%
    </span>
  )
}

function stateText(m: Machine): string {
  if (m.state === 'connecting') return `Connecting over SSH to ${m.ssh_target}…`
  if (m.state === 'down') return m.error || 'Unreachable'
  const s = m.summary
  if (!s) return 'Reachable, waiting for its first reading'
  const where = m.local ? s.hostname : `${s.hostname} · via ${m.ssh_target}`
  return `${where} · ${s.os} · ${s.cores} cores · up ${duration(s.time - s.boot_time)}`
}

function RetryButton({ machine }: { machine: Machine }) {
  const { refresh } = useMachines()
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    setBusy(true)
    try {
      await api(`machines/${machine.id}/retry`, { method: 'POST' })
    } finally {
      refresh()
      setBusy(false)
    }
  }
  return (
    <button className="btn" type="button" disabled={busy} onClick={retry} aria-label={`Retry connecting to ${machine.name}`}>
      {busy ? 'Retrying' : 'Retry'}
    </button>
  )
}

function MachinesList() {
  const { machines, current, select } = useMachines()
  return (
    <div className="sheet">
      <SheetHead id="machines">
        <a className="btn" href="#/m/machines/new">
          <Icon name="plus" size={18} /> Add machine
        </a>
      </SheetHead>
      <p className="sheet__lede">Each machine runs its own Marumado. This one reaches the others over SSH. Choose one to see it in every module.</p>
      {!machines ? (
        <div className="sheet__empty">Loading…</div>
      ) : (
        <ul className="list">
          {machines.map((m) => {
            const s = m.summary
            const viewing = m.id === current
            return (
              <li className="row" key={m.id}>
                <span
                  className={`row__lamp${m.state === 'up' ? ' row__lamp--on' : m.state === 'down' ? ' row__lamp--fault' : ''}`}
                  role="img"
                  aria-label={m.state === 'up' ? 'reachable' : m.state === 'down' ? 'unreachable' : 'connecting'}
                />
                <span className="row__main">
                  {m.name}
                  <span className={`row__sub${m.state === 'down' ? ' signal-text' : ''}`}>{stateText(m)}</span>
                </span>
                {s && (
                  <span className="row__meta machines__readings">
                    <Reading label="CPU" percent={s.cpu} budget={CPU_BUDGET} />
                    <Reading label="RAM" percent={s.memory} budget={MEM_BUDGET} />
                    {s.disk && <Reading label="Disk" percent={s.disk.percent} budget={DISK_BUDGET} />}
                  </span>
                )}
                <span className="row__actions">
                  {m.state === 'down' && <RetryButton machine={m} />}
                  {!m.local && (
                    <a className="btn btn--quiet" href={`#/m/machines/edit/${m.id}`} aria-label={`Edit ${m.name}`}>
                      Edit
                    </a>
                  )}
                  <button className="btn" type="button" disabled={viewing} onClick={() => select(m.id)} aria-label={viewing ? `Viewing ${m.name}` : `View ${m.name}`}>
                    {viewing ? 'Viewing' : 'View'}
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <section className="sheet__section">
        <h3>Adding a machine</h3>
        <ol className="machines__steps">
          <li>
            Run Marumado on it (<span className="mono">make up</span>). Leave <span className="mono">MARUMADO_BIND</span> at 127.0.0.1: it is reached through SSH, never over the network.
          </li>
          <li>
            Check that <span className="mono">ssh you@that-machine</span> works from this one without a password (key login). Connect once by hand to trust its host key.
          </li>
          <li>
            Is this Marumado running in Docker? Set <span className="mono">MARUMADO_SSH_DIR=~/.ssh</span> in .env and run <span className="mono">make up</span>, so the container gets your SSH keys and config.
          </li>
        </ol>
      </section>
    </div>
  )
}

function MachineForm({ machine }: { machine?: Machine }) {
  const { refresh, current, select } = useMachines()
  const [form, setForm] = useState({ name: machine?.name ?? '', ssh_target: machine?.ssh_target ?? '', port: String(machine?.port ?? 7878), token: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    // An empty token field keeps the saved token.
    const body: Record<string, unknown> = { name: form.name.trim(), ssh_target: form.ssh_target.trim(), port: Number(form.port) }
    if (form.token || !machine) body.token = form.token
    try {
      await api(machine ? `machines/${machine.id}` : 'machines', { method: machine ? 'PATCH' : 'POST', json: body })
      refresh()
      go('#/m/machines')
    } catch (err) {
      setError(err instanceof Error ? `Couldn't save: ${err.message}` : "Couldn't save.")
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!machine) return
    try {
      await api(`machines/${machine.id}`, { method: 'DELETE' })
      if (current === machine.id) select('local')
      refresh()
      go('#/m/machines')
    } catch (err) {
      setError(err instanceof Error ? `Couldn't remove: ${err.message}` : "Couldn't remove.")
    }
  }

  return (
    <form className="sheet" onSubmit={submit}>
      <a className="side__back" href="#/m/machines">
        <Icon name="back" size={18} /> All machines
      </a>
      <header className="sheet__head">
        <h2 className="sheet__title">{machine ? `Edit ${machine.name}` : 'Add machine'}</h2>
      </header>
      <label className="field">
        Name
        <input required maxLength={60} value={form.name} onChange={set('name')} placeholder="build-server" />
      </label>
      <label className="field">
        SSH target
        <input
          required
          value={form.ssh_target}
          onChange={set('ssh_target')}
          placeholder="you@build-server, ssh://you@build-server:2222, or a ~/.ssh/config alias"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </label>
      <label className="field">
        Marumado's port on that machine
        <input required type="number" min={1} max={65535} value={form.port} onChange={set('port')} />
      </label>
      <label className="field">
        Its access token (MARUMADO_TOKEN), if it has one
        <input
          type="password"
          autoComplete="off"
          value={form.token}
          onChange={set('token')}
          placeholder={machine?.has_token ? 'Saved. Type a new one to replace it' : 'None'}
        />
      </label>
      {error && <p className="notice signal-text">{error}</p>}
      <div className="sheet__actions" style={{ justifyContent: 'start' }}>
        <button className="btn" type="submit" disabled={saving}>
          {saving ? 'Saving' : machine ? 'Save changes' : 'Add machine'}
        </button>
        <a className="btn btn--quiet" href="#/m/machines">
          Cancel
        </a>
        {machine && (
          <ConfirmButton onConfirm={remove} confirmLabel="Confirm remove">
            Remove
          </ConfirmButton>
        )}
      </div>
      <p className="sheet__lede">Marumado keeps an SSH tunnel open to the machine and reconnects by itself when it drops. Nothing on the other machine changes.</p>
    </form>
  )
}
