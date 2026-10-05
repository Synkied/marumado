import { useState } from 'react'
import { Icon } from '../components/Icon'
import { agentHref, preferredKind, sourcesOf, startAgent, useWorkspace, workspaceIn, workspaceLabel } from '../lib/agents'
import { api } from '../lib/api'
import { useHub } from '../lib/hub'
import { go } from '../lib/route'
import type { Project } from '../lib/types'
import { defaultSource, folderIn, machineOfSource, startPlaces } from '../lib/work'

/** One click to an agent at work on the project: a new Herdr workspace in its folder (or a new tab in the workspace
    picked on the Agents page), the agent started there, and its terminal opened to watch it start. Only where agents
    can be controlled. With several places, the one picked can be made the project's default: tasks, plans and ⌘K
    then start its agents there too. Without one of its own, the project follows its scan folder's (Projects → Folders). */
export function StartAgent({ project }: { project: Project }) {
  const { agents, refreshAgents, refreshProjects } = useHub()
  const places = startPlaces(project, agents)
  const [kind, setKind] = useState(() => preferredKind(agents?.kinds))
  const [place, setPlace] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useWorkspace() // follows the pick on the Agents page
  if (!agents?.available || agents.terminal !== 'control' || !places.length) return null
  const chosen = places.find((s) => s.id === place) ?? places[0]
  const workspace = workspaceIn(agents, chosen.id)
  const preferred = defaultSource(project)
  const isDefault = chosen.id === project.agent_source
  // Only the scan folder's default applies here: the project has none of its own.
  const fromFolder = project.agent_source == null && chosen.id === project.folder_source
  // The default is a source that doesn't answer right now: say so, rather than quietly starting elsewhere.
  const away = preferred != null && !places.some((s) => s.id === preferred) ? sourcesOf(agents).find((s) => s.id === preferred) : undefined
  const setDefault = async () => {
    setError('')
    try {
      await api(`projects/${project.id}`, { method: 'PATCH', json: { agent_source: isDefault ? null : chosen.id } })
      refreshProjects()
    } catch (err) {
      setError(err instanceof Error ? `Couldn't change the default: ${err.message}` : "Couldn't change the default.")
    }
  }
  const start = async () => {
    setBusy(true)
    setError('')
    try {
      const made = await startAgent(project.id, kind, chosen.id, workspace?.id)
      await refreshAgents()
      go(agentHref(made))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start it.")
      setBusy(false)
    }
  }
  return (
    <div className="start-agent">
      <button
        className="btn btn--quiet"
        type="button"
        onClick={start}
        disabled={busy}
        title={workspace ? `In a new tab of the workspace ${workspaceLabel(workspace)}, picked on the Agents page` : 'In a new Herdr workspace'}
      >
        <Icon name="agent" size={16} /> {busy ? 'Starting…' : `Start ${kind}`}
      </button>
      <label className="sr-only" htmlFor={`kind-${project.id}`}>
        Kind of agent
      </label>
      <select id={`kind-${project.id}`} className="start-agent__pick" value={kind} onChange={(e) => setKind(e.target.value)} disabled={busy}>
        {(agents.kinds ?? ['claude']).map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      {places.length > 1 && (
        <>
          <label className="sr-only" htmlFor={`where-${project.id}`}>
            Where
          </label>
          <select id={`where-${project.id}`} className="start-agent__pick" value={chosen.id} onChange={(e) => setPlace(Number(e.target.value))} disabled={busy}>
            {places.map((s) => (
              <option key={s.id} value={s.id}>
                on {s.name}
                {s.id === project.agent_source ? ' (default)' : s.id === preferred ? ' (folder default)' : ''}
                {machineOfSource(s) != null && !folderIn(project, s) ? ' (no folder there)' : ''}
              </option>
            ))}
          </select>
          {fromFolder ? (
            <a className="start-agent__note-inline" href="#/m/projects/folders" title="Set for every project in its scan folder, in Projects → Folders">
              Folder default
            </a>
          ) : (
          <button
            className="btn btn--quiet start-agent__default"
            type="button"
            aria-pressed={isDefault}
            onClick={setDefault}
            disabled={busy}
            title={isDefault ? `${project.name}'s agents start on ${chosen.name} by default. Press to stop preferring it.` : `Start ${project.name}'s agents on ${chosen.name} by default, from tasks, plans and ⌘K too`}
          >
            {isDefault ? 'Default' : 'Make default'}
          </button>
          )}
        </>
      )}
      {away && (
        <span className="start-agent__note">
          {away.name}, its default, isn&rsquo;t answering: starts on {chosen.name} meanwhile.
        </span>
      )}
      {error && <span className="signal-text start-agent__error">{error}</span>}
    </div>
  )
}
