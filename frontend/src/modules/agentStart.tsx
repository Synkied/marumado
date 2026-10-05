import { useState } from 'react'
import { Icon } from '../components/Icon'
import { agentHref, preferredKind, startAgent } from '../lib/agents'
import { useHub } from '../lib/hub'
import { go } from '../lib/route'
import type { Project } from '../lib/types'
import { folderIn, machineOfSource, startPlaces } from '../lib/work'

/** One click to an agent at work on the project: a new Herdr workspace in its folder, the agent started there, and
    its terminal opened to watch it start. Only where agents can be controlled. */
export function StartAgent({ project }: { project: Project }) {
  const { agents, refreshAgents } = useHub()
  const places = startPlaces(project, agents)
  const [kind, setKind] = useState(() => preferredKind(agents?.kinds))
  const [place, setPlace] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!agents?.available || agents.terminal !== 'control' || !places.length) return null
  const chosen = places.find((s) => s.id === place) ?? places[0]
  const start = async () => {
    setBusy(true)
    setError('')
    try {
      const made = await startAgent(project.id, kind, chosen.id)
      await refreshAgents()
      go(agentHref(made))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start it.")
      setBusy(false)
    }
  }
  return (
    <div className="start-agent">
      <button className="btn btn--quiet" type="button" onClick={start} disabled={busy}>
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
                {machineOfSource(s) != null && !folderIn(project, s) ? ' (no folder there)' : ''}
              </option>
            ))}
          </select>
        </>
      )}
      {error && <span className="signal-text start-agent__error">{error}</span>}
    </div>
  )
}
