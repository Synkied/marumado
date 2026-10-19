import { useState, type FormEvent } from 'react'
import { ConfirmButton } from '../components/ConfirmButton'
import { Icon } from '../components/Icon'
import { sourcesOf } from '../lib/agents'
import { api } from '../lib/api'
import { useHub } from '../lib/hub'
import { go } from '../lib/route'
import { Redacted, useStreaming } from '../lib/streaming'
import type { SavedAgentSource, SavedModelApi, SourceFolder } from '../lib/types'
import { usePoll } from '../lib/usePoll'

/** Agents → Sources: every place Herdr runs (`sub`: '' the list, 'new', 'edit/<id>', or 'edit/env' for the .env one),
    and the model APIs agents can be pointed at ('api/new', 'api/<id>'). */
export function AgentSourcesSheet({ sub }: { sub: string }) {
  const saved = usePoll<SavedAgentSource[]>('agent-sources', 30000)
  const apis = usePoll<SavedModelApi[]>('model-apis', 30000)
  if (sub === 'api/new') return <ModelApiForm onSaved={apis.refresh} />
  if (sub.startsWith('api/')) {
    if (!apis.data) return <div className="sheet__empty">{apis.error ? `Couldn't load the model APIs: ${apis.error.message}` : 'Loading…'}</div>
    const found = apis.data.find((a) => String(a.id) === sub.slice(4))
    return found ? <ModelApiForm api={found} onSaved={apis.refresh} key={found.id} /> : <SourcesPage apis={apis.data} />
  }
  if (sub === 'new') return <SourceForm onSaved={saved.refresh} />
  if (sub === 'edit/env') return <EnvSourceForm />
  if (sub.startsWith('edit/')) {
    if (!saved.data) return <div className="sheet__empty">{saved.error ? `Couldn't load the sources: ${saved.error.message}` : 'Loading…'}</div>
    const source = saved.data.find((s) => String(s.id) === sub.slice(5))
    return source ? <SourceForm source={source} onSaved={saved.refresh} key={source.id} /> : <SourcesPage apis={apis.data} />
  }
  return <SourcesPage apis={apis.data} apisError={apis.error?.message} />
}

function SourcesPage({ apis, apisError }: { apis?: SavedModelApi[]; apisError?: string }) {
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
      <ModelApis apis={apis} error={apisError} />
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
            {(s.folders?.length ?? 0) > 0 && (
              <span className="row__sub mono">
                <Redacted text={s.folders!.map((f) => `${f.here} → ${f.there}`).join(' · ')} />
              </span>
            )}
          </span>
          <span className="row__meta">{s.available ? `${s.agents} open` : 'unreachable'}</span>
          <span className="row__actions">
            {s.kind === 'env' ? (
              <>
                <span className="row__meta" title="Set with MARUMADO_HERDR_* in .env">
                  from .env
                </span>
                <a className="btn btn--quiet" href="#/m/agents/sources/edit/env" aria-label={`Edit ${s.name}'s folders`}>
                  Folders
                </a>
              </>
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
  const [folders, setFolders] = useState<SourceFolder[]>(source?.folders ?? [])
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
      const json = { name: form.name.trim(), kind: form.kind, target: form.target.trim(), folders: filled(folders) }
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
      <FoldersField folders={folders} onChange={setFolders} />
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

/** The model APIs, under the sources: what a new agent can use instead of its own login. */
function ModelApis({ apis, error }: { apis?: SavedModelApi[]; error?: string }) {
  return (
    <section className="sheet__section">
      <h3>Model APIs</h3>
      <p className="sheet__lede">
        Point a new Claude Code or Codex agent at another model server instead of its own login: Ollama, llama.cpp&rsquo;s llama-server, a proxy like LiteLLM, or a
        provider with an API token. You pick one when you start an agent, give a task to a new one, or make a plan.
      </p>
      {!apis ? (
        <div className="sheet__empty">{error ? `Couldn't load them: ${error}` : 'Loading…'}</div>
      ) : apis.length ? (
        <ul className="list">
          {apis.map((a) => (
            <li className="row" key={a.id}>
              <span className="row__lamp" aria-hidden />
              <span className="row__main">
                {a.name}
                <span className="row__sub mono">
                  <Redacted text={a.base_url} />
                </span>
              </span>
              <span className="row__meta">
                {a.model || 'default model'} · {a.has_token ? 'token saved' : 'no token'}
              </span>
              <span className="row__actions">
                <a className="btn btn--quiet" href={`#/m/agents/sources/api/${a.id}`} aria-label={`Edit ${a.name}`}>
                  Edit
                </a>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <a className="btn btn--quiet" href="#/m/agents/sources/api/new">
        <Icon name="plus" size={16} /> Add model API
      </a>
    </section>
  )
}

/** Servers with an address everyone uses: picking one fills it in. */
const PRESETS: { label: string; url: string; note: string }[] = [
  { label: 'Ollama', url: 'http://localhost:11434', note: 'Serves both Claude Code and Codex. No token. The model is one you pulled, like qwen3-coder:30b.' },
  { label: 'llama.cpp', url: 'http://localhost:8080', note: 'llama-server, on its --port. No token unless you started it with --api-key.' },
  { label: 'OpenAI', url: 'https://api.openai.com/v1', note: 'For Codex, with an API key.' },
  { label: 'Anthropic', url: 'https://api.anthropic.com', note: 'For Claude Code, with an API key.' },
  { label: 'OpenRouter', url: 'https://openrouter.ai/api', note: 'Serves both, with an OpenRouter key. The model is its id, like qwen/qwen3-coder.' },
]

function ModelApiForm({ api: saved, onSaved }: { api?: SavedModelApi; onSaved: () => void }) {
  const { refreshAgents } = useHub()
  const streaming = useStreaming().on
  const [form, setForm] = useState({ name: saved?.name ?? '', base_url: saved?.base_url ?? '', model: saved?.model ?? '' })
  const [token, setToken] = useState('')
  const [forget, setForget] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const preset = PRESETS.find((p) => p.url === form.base_url.trim().replace(/\/+$/, ''))

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
      // Left out, a saved token is kept.
      const keep = saved && !token.trim() && !forget
      const json = { name: form.name.trim(), base_url: form.base_url.trim(), model: form.model.trim(), ...(keep ? {} : { token: token.trim() }) }
      await api(saved ? `model-apis/${saved.id}` : 'model-apis', { method: saved ? 'PATCH' : 'POST', json })
      done()
    } catch (err) {
      setError(err instanceof Error ? `Couldn't save: ${err.message}` : "Couldn't save.")
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!saved) return
    try {
      await api(`model-apis/${saved.id}`, { method: 'DELETE' })
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
        <h2 className="sheet__title">{saved ? `Edit ${saved.name}` : 'Add model API'}</h2>
      </header>
      <div className="field">
        <span id="api-preset">Server</span>
        <div className="seg seg--mod mod-agents" role="group" aria-labelledby="api-preset">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="seg__btn"
              aria-pressed={preset === p}
              onClick={() => setForm({ ...form, base_url: p.url, name: form.name || p.label })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="agent-hint">{preset ? preset.note : 'Or any server with the same API: type its address below.'}</p>
      </div>
      <label className="field">
        Name
        <input required maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ollama on the desk" />
      </label>
      <label className="field">
        Address
        <input
          required
          className="mono"
          value={form.base_url}
          onChange={(e) => setForm({ ...form, base_url: e.target.value })}
          type={streaming ? 'password' : 'text'}
          autoComplete="off"
          placeholder="http://localhost:11434"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </label>
      <p className="agent-hint">
        As the agent reaches it, from where it runs: <span className="mono">localhost</span> is the machine or VM of the agent&rsquo;s source, not this one. Claude Code
        asks <span className="mono">/v1/messages</span> (Anthropic&rsquo;s API), Codex <span className="mono">/v1/responses</span> (OpenAI&rsquo;s).
      </p>
      <label className="field">
        API token
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="new-password"
          placeholder={saved?.has_token ? 'Saved: leave empty to keep it' : 'None for a local server'}
          spellCheck={false}
          disabled={forget}
        />
      </label>
      {saved?.has_token && (
        <label className="field field--check">
          <input type="checkbox" checked={forget} onChange={(e) => setForget(e.target.checked)} /> Forget the saved token
        </label>
      )}
      <p className="agent-hint">
        Kept on this Marumado and given to the agent&rsquo;s shell in its environment, never typed on screen.
      </p>
      <label className="field">
        Model
        <input
          className="mono"
          maxLength={200}
          value={form.model}
          onChange={(e) => setForm({ ...form, model: e.target.value })}
          placeholder="qwen3-coder:30b"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </label>
      <p className="agent-hint">The name the server lists. Empty: the agent asks for its own default, which a local server won&rsquo;t have.</p>
      {error && <p className="notice signal-text">{error}</p>}
      <div className="sheet__actions" style={{ justifyContent: 'start' }}>
        <button className="btn" type="submit" disabled={saving}>
          {saving ? 'Saving' : saved ? 'Save changes' : 'Add model API'}
        </button>
        <a className="btn btn--quiet" href="#/m/agents/sources">
          Cancel
        </a>
        {saved && (
          <ConfirmButton onConfirm={remove} confirmLabel="Confirm remove">
            Remove
          </ConfirmButton>
        )}
      </div>
      <p className="sheet__lede">Agents already started on it keep using it. Plans that use it go back to their agents&rsquo; own login.</p>
    </form>
  )
}

const filled = (folders: SourceFolder[]) => folders.filter((f) => f.here.trim() || f.there.trim())

/** Where the source sees this machine's folders, so agents start in a project's folder there. One row per shared folder. */
function FoldersField({ folders, onChange }: { folders: SourceFolder[]; onChange: (folders: SourceFolder[]) => void }) {
  const rows = folders.length ? folders : [{ here: '', there: '' }]
  const set = (i: number, f: SourceFolder) => onChange(rows.map((r, j) => (j === i ? f : r)))
  return (
    <fieldset className="field folders">
      <legend>Shared folders</legend>
      <p className="agent-hint">
        When a folder of this machine has another path there, as in a VM: <span className="mono">/home/you/projects</span> on this machine,{' '}
        <span className="mono">/projects</span> there. Agents for a project then start in its folder there. Leave empty when paths are the same.
      </p>
      {rows.map((f, i) => (
        <div className="folders__row" key={i}>
          <label className="sr-only" htmlFor={`here-${i}`}>
            Folder on this machine
          </label>
          <input
            id={`here-${i}`}
            className="mono"
            value={f.here}
            onChange={(e) => set(i, { ...f, here: e.target.value })}
            placeholder="/home/you/projects"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <span aria-hidden="true">→</span>
          <label className="sr-only" htmlFor={`there-${i}`}>
            The same folder there
          </label>
          <input
            id={`there-${i}`}
            className="mono"
            value={f.there}
            onChange={(e) => set(i, { ...f, there: e.target.value })}
            placeholder="/projects"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <button className="btn btn--quiet" type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove this folder">
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
      <button className="btn btn--quiet folders__add" type="button" onClick={() => onChange([...rows, { here: '', there: '' }])}>
        <Icon name="plus" size={16} /> Add a folder
      </button>
    </fieldset>
  )
}

/** The .env source: where Herdr runs is set in .env; its folders here. */
function EnvSourceForm() {
  const { agents, refreshAgents } = useHub()
  const saved = usePoll<{ folders: SourceFolder[] }>('agents/env-source', 60000)
  const [folders, setFolders] = useState<SourceFolder[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const env = sourcesOf(agents).find((s) => s.kind === 'env')
  const shown = folders ?? saved.data?.folders

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api('agents/env-source', { method: 'PATCH', json: { folders: filled(shown ?? []) } })
      await refreshAgents()
      go('#/m/agents/sources')
    } catch (err) {
      setError(err instanceof Error ? `Couldn't save: ${err.message}` : "Couldn't save.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="sheet" onSubmit={submit}>
      <a className="side__back" href="#/m/agents/sources">
        <Icon name="back" size={18} /> All sources
      </a>
      <header className="sheet__head mod-agents">
        <h2 className="sheet__title">{env ? `Edit ${env.name}` : 'Edit the .env source'}</h2>
      </header>
      <p className="sheet__lede">
        Where Herdr runs for this source is set in .env (<span className="mono">MARUMADO_HERDR_*</span>)
        {env ? (
          <>
            : <Redacted text={env.where} />
          </>
        ) : null}
        .
      </p>
      {shown ? (
        <FoldersField folders={shown} onChange={setFolders} />
      ) : (
        <div className="sheet__empty">{saved.error ? `Couldn't load its folders: ${saved.error.message}` : 'Loading…'}</div>
      )}
      {error && <p className="notice signal-text">{error}</p>}
      <div className="sheet__actions" style={{ justifyContent: 'start' }}>
        <button className="btn" type="submit" disabled={saving || !shown}>
          {saving ? 'Saving' : 'Save changes'}
        </button>
        <a className="btn btn--quiet" href="#/m/agents/sources">
          Cancel
        </a>
      </div>
    </form>
  )
}
