import { useState } from 'react'
import { ConfirmButton } from '../components/ConfirmButton'
import { Icon } from '../components/Icon'
import { agentHref, sourceOf, sourceQuery, sourcesOf, workspaceLabel, type WorkspaceRef } from '../lib/agents'
import { api } from '../lib/api'
import { useHub } from '../lib/hub'
import { go } from '../lib/route'
import type { Agents, AgentSource, Workspace } from '../lib/types'
import { folderIn } from '../lib/work'

const refValue = (w: WorkspaceRef) => `${w.source}/${w.id}`

/** The Herdr workspaces, as in Herdr's sidebar: pick one to see only its agents (and open new ones in it), make one,
    or close the one picked. */
export function WorkspaceBar({
  agents,
  chosen,
  onChoose,
  control,
}: {
  agents: Agents
  chosen: (Workspace & { source: number }) | null
  onChoose: (w: WorkspaceRef | null) => void
  control: boolean
}) {
  const { refreshAgents } = useHub()
  const [making, setMaking] = useState(false)
  const [error, setError] = useState('')
  const sources = sourcesOf(agents).filter((s) => s.available && s.workspaces)
  if (!sources.length) return null
  const multi = sources.length > 1
  const count = (s: AgentSource, w: Workspace) => agents.agents.filter((a) => sourceOf(a) === s.id && a.workspace_id === w.id).length
  const option = (s: AgentSource, w: Workspace) => {
    const n = count(s, w)
    return (
      <option key={w.id} value={refValue({ source: s.id, id: w.id })}>
        {w.worktree_of ? '↳ ' : ''}
        {workspaceLabel(w)}
        {n ? ` · ${n}` : ''}
      </option>
    )
  }
  const close = async () => {
    if (!chosen) return
    setError('')
    try {
      await api(`agents/workspaces/${encodeURIComponent(chosen.id)}/close?${sourceQuery(chosen.source)}`, {
        method: 'POST',
        json: { group: chosen.linked > 0 },
      })
      onChoose(null)
      await refreshAgents()
      go('#/m/agents')
    } catch (err) {
      setError(err instanceof Error ? `Couldn't close it: ${err.message}` : "Couldn't close it.")
    }
  }
  const closeTitle = chosen?.linked
    ? `Close ${workspaceLabel(chosen)} and its ${chosen.linked} worktree workspace${chosen.linked === 1 ? '' : 's'} in Herdr, with every terminal and agent in them. The worktrees' folders stay.`
    : 'Close this workspace in Herdr, with every terminal and agent in it'
  return (
    <div className="workspaces">
      <div className="workspaces__bar">
        <label className="sr-only" htmlFor="workspace-pick">
          Workspace
        </label>
        <select
          id="workspace-pick"
          className="workspaces__pick"
          value={chosen ? refValue(chosen) : ''}
          onChange={(e) => {
            const [source, id] = e.target.value.split('/')
            onChoose(id ? { source: Number(source), id } : null)
            go('#/m/agents')
          }}
        >
          <option value="">All workspaces</option>
          {multi
            ? sources.map((s) => (
                <optgroup key={s.id} label={s.name}>
                  {s.workspaces!.map((w) => option(s, w))}
                </optgroup>
              ))
            : sources[0].workspaces!.map((w) => option(sources[0], w))}
        </select>
        {control && (
          <button
            type="button"
            className="tool"
            aria-expanded={making}
            aria-controls="workspace-new"
            onClick={() => setMaking(!making)}
            title="New workspace: a Herdr workspace of its own, for its own agents"
          >
            <Icon name="plus" size={18} />
            <span className="sr-only">New workspace</span>
          </button>
        )}
        {control && chosen && (
          <ConfirmButton className="tool tool--danger" confirmLabel={chosen.linked ? `Close all ${chosen.linked + 1}` : 'Close it'} onConfirm={close} title={closeTitle}>
            <Icon name="close" size={18} />
            <span className="sr-only">Close workspace</span>
          </ConfirmButton>
        )}
      </div>
      {error && <p className="workspaces__error signal-text">{error}</p>}
      {making && (
        <NewWorkspace
          sources={sources}
          initialSource={chosen?.source}
          onDone={(made) => {
            setMaking(false)
            if (made) onChoose(made)
          }}
        />
      )}
    </div>
  )
}

/** A new Herdr workspace: a name, and the project whose folder it opens in (or Herdr's home folder). */
function NewWorkspace({ sources, initialSource, onDone }: { sources: AgentSource[]; initialSource?: number; onDone: (made: WorkspaceRef | null) => void }) {
  const { projects, refreshAgents } = useHub()
  const [label, setLabel] = useState('')
  const [sourceId, setSourceId] = useState(initialSource ?? sources[0].id)
  const [project, setProject] = useState<number | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const source = sources.find((s) => s.id === sourceId) ?? sources[0]
  const folders = (projects ?? [])
    .filter((p) => p.kind === 'project' && !p.hidden && folderIn(p, source))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name))
  const picked = folders.find((p) => p.id === project)
  const make = async () => {
    setBusy(true)
    setError('')
    try {
      const made = await api<{ workspace_id: string; pane_id: string; source: number }>('agents/workspaces', {
        method: 'POST',
        json: { source: source.id, label: label.trim(), ...(picked ? { project: picked.id } : {}) },
      })
      await refreshAgents()
      onDone({ source: made.source, id: made.workspace_id })
      go(agentHref(made))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open the workspace.")
      setBusy(false)
    }
  }
  return (
    <form
      id="workspace-new"
      className="workspaces__new"
      onSubmit={(e) => {
        e.preventDefault()
        make()
      }}
    >
      <label className="field">
        Name
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={60}
          placeholder={picked ? picked.name : 'Named by Herdr'}
          autoComplete="off"
          autoFocus
        />
      </label>
      {sources.length > 1 && (
        <label className="field">
          Where
          <select className="workspaces__pick" value={source.id} onChange={(e) => (setSourceId(Number(e.target.value)), setProject(''))}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        Folder
        <select className="workspaces__pick" value={project} onChange={(e) => setProject(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Herdr&rsquo;s home folder</option>
          {folders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="workspaces__error signal-text">{error}</p>}
      <div className="workspaces__actions">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Opening…' : 'Open workspace'}
        </button>
        <button className="btn btn--quiet" type="button" onClick={() => onDone(null)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}
