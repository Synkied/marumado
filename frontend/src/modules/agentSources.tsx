import { useState, type FormEvent } from 'react'
import { ConfirmButton } from '../components/ConfirmButton'
import { Icon } from '../components/Icon'
import { sourcesOf } from '../lib/agents'
import { api } from '../lib/api'
import { useHub } from '../lib/hub'
import { go } from '../lib/route'
import { Redacted, useStreaming } from '../lib/streaming'
import type { SavedAgentSource } from '../lib/types'
import { usePoll } from '../lib/usePoll'

/** Agents → Sources: every place Herdr runs (`sub`: '' the list, 'new', or 'edit/<id>'). */
export function AgentSourcesSheet({ sub }: { sub: string }) {
  const saved = usePoll<SavedAgentSource[]>('agent-sources', 30000)
  if (sub === 'new') return <SourceForm onSaved={saved.refresh} />
  if (sub.startsWith('edit/')) {
    if (!saved.data) return <div className="sheet__empty">{saved.error ? `Couldn't load the sources: ${saved.error.message}` : 'Loading…'}</div>
    const source = saved.data.find((s) => String(s.id) === sub.slice(5))
    return source ? <SourceForm source={source} onSaved={saved.refresh} key={source.id} /> : <SourcesPage />
  }
  return <SourcesPage />
}

function SourcesPage() {
  return (
    <div className="sheet">
      <a className="side__back" href="#/m/agents">
        <Icon name="back" size={18} /> Agents
      </a>
      <header className="sheet__head mod-agents">
        <h2 className="sheet__title">Agent sources</h2>
        <div className="sheet__actions">
          <a className="btn" href="#/m/agents/sources/new">
            <Icon name="plus" size={18} /> Add source
          </a>
        </div>
      </header>
      <p className="sheet__lede">
        Every place your coding agents run in Herdr: this machine, VMs, servers. Agents lists them all together, under the source each one runs in.
      </p>
      <SourcesList />
      <section className="sheet__section">
        <h3>Adding a source</h3>
        <ul className="machines__steps">
          <li>
            <strong>Over SSH</strong>: a VM or server where Herdr runs. Check that <span className="mono">ssh you@that-vm</span> works from this machine without a
            password (key login), and connect once by hand to trust its host key. Is this Marumado running in Docker? Set{' '}
            <span className="mono">MARUMADO_SSH_DIR=~/.ssh</span> in .env and run <span className="mono">make up</span>, so the container gets your SSH keys.
          </li>
          <li>
            <strong>smolvm machine</strong>: a VM on this machine, by its name (<span className="mono">smolvm machine ls</span>). In Docker,{' '}
            <span className="mono">make up</span> mounts smolvm when it is installed.
          </li>
        </ul>
        <p className="sheet__lede">
          Machines you added under Machines need nothing here: when their Marumado sees a Herdr, their agents show up on their own.
        </p>
        <p className="sheet__lede">
          The source in .env (<span className="mono">MARUMADO_HERDR_*</span>) stays listed first. It is left out when it points nowhere and Herdr isn&rsquo;t installed
          on this machine.
        </p>
      </section>
    </div>
  )
}

/** Each source with whether it answers and how many panes it has open. */
function SourcesList() {
  const { agents } = useHub()
  const sources = sourcesOf(agents)
  if (!agents) return <div className="sheet__empty">Loading…</div>
  if (!sources.length) return <p className="notice">This Marumado is older than agent sources: update it to add more.</p>
  return (
    <ul className="list">
      {sources.map((s) => (
        <li className="row" key={s.id}>
          <span className={`row__lamp${s.available ? ' row__lamp--on' : ' row__lamp--fault'}`} role="img" aria-label={s.available ? 'answering' : 'unreachable'} />
          <span className="row__main">
            {s.name}
            <span className={`row__sub${s.available ? '' : ' signal-text'}`}>
              <Redacted text={s.available ? `Herdr ${s.where}` : s.error || 'Herdr is not answering'} />
            </span>
          </span>
          <span className="row__meta">{s.available ? `${s.agents} open` : 'unreachable'}</span>
          <span className="row__actions">
            {s.kind === 'env' ? (
              <span className="row__meta" title="Set with MARUMADO_HERDR_* in .env">
                from .env
              </span>
            ) : s.kind === 'machine' ? (
              <a className="row__meta" href="#/m/machines" title="A machine in Machines whose Marumado sees a Herdr: added on its own">
                from Machines
              </a>
            ) : (
              <a className="btn btn--quiet" href={`#/m/agents/sources/edit/${s.id}`} aria-label={`Edit ${s.name}`}>
                Edit
              </a>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

const KINDS: { kind: SavedAgentSource['kind']; label: string; field: string; placeholder: string }[] = [
  { kind: 'ssh', label: 'Over SSH', field: 'SSH target', placeholder: 'you@dev-vm, ssh://you@dev-vm:2222, or a ~/.ssh/config alias' },
  { kind: 'smolvm', label: 'smolvm machine', field: 'Machine name', placeholder: 'dev-vm' },
]

function SourceForm({ source, onSaved }: { source?: SavedAgentSource; onSaved: () => void }) {
  const { refreshAgents } = useHub()
  const streaming = useStreaming().on
  const [form, setForm] = useState({ name: source?.name ?? '', kind: source?.kind ?? 'ssh', target: source?.target ?? '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const kind = KINDS.find((k) => k.kind === form.kind) ?? KINDS[0]

  const done = () => {
    onSaved()
    refreshAgents()
    go('#/m/agents/sources')
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const json = { name: form.name.trim(), kind: form.kind, target: form.target.trim() }
      await api(source ? `agent-sources/${source.id}` : 'agent-sources', { method: source ? 'PATCH' : 'POST', json })
      done()
    } catch (err) {
      setError(err instanceof Error ? `Couldn't save: ${err.message}` : "Couldn't save.")
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!source) return
    try {
      await api(`agent-sources/${source.id}`, { method: 'DELETE' })
      done()
    } catch (err) {
      setError(err instanceof Error ? `Couldn't remove: ${err.message}` : "Couldn't remove.")
    }
  }

  return (
    <form className="sheet" onSubmit={submit}>
      <a className="side__back" href="#/m/agents/sources">
        <Icon name="back" size={18} /> All sources
      </a>
      <header className="sheet__head mod-agents">
        <h2 className="sheet__title">{source ? `Edit ${source.name}` : 'Add source'}</h2>
      </header>
      <label className="field">
        Name
        <input required maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="dev-vm" />
      </label>
      <div className="field">
        <span id="source-kind">Where Herdr runs</span>
        <div className="seg seg--mod mod-agents" role="group" aria-labelledby="source-kind">
          {KINDS.map((k) => (
            <button key={k.kind} type="button" className="seg__btn" aria-pressed={form.kind === k.kind} onClick={() => setForm({ ...form, kind: k.kind })}>
              {k.label}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        {kind.field}
        <input
          required
          value={form.target}
          onChange={(e) => setForm({ ...form, target: e.target.value })}
          type={streaming && form.kind === 'ssh' ? 'password' : 'text'}
          autoComplete="off"
          placeholder={kind.placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </label>
      {error && <p className="notice signal-text">{error}</p>}
      <div className="sheet__actions" style={{ justifyContent: 'start' }}>
        <button className="btn" type="submit" disabled={saving}>
          {saving ? 'Saving' : source ? 'Save changes' : 'Add source'}
        </button>
        <a className="btn btn--quiet" href="#/m/agents/sources">
          Cancel
        </a>
        {source && (
          <ConfirmButton onConfirm={remove} confirmLabel="Confirm remove">
            Remove
          </ConfirmButton>
        )}
      </div>
      <p className="sheet__lede">
        Marumado runs <span className="mono">herdr</span> there to list your agents and stream their terminals. Removing a source stops watching it; the agents keep
        running.
      </p>
    </form>
  )
}
