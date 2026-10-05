import { api } from './api'
import { useEffect, useState } from 'react'
import type { Agent, Agents, AgentSource, Workspace } from './types'

/** An agent is found by its source and its pane id: pane ids repeat from one Herdr to the next. */
export type AgentRef = { source: number; pane: string }

export const sourceOf = (a: { source?: number }) => a.source ?? 0

/** `#/m/agents/<source>/<pane>`. */
export const agentHref = (a: { source?: number; pane_id: string }) => `#/m/agents/${sourceOf(a)}/${a.pane_id}`

export const agentKey = (a: { source?: number; pane_id: string }) => `${sourceOf(a)}/${a.pane_id}`

/** The agent a route names: `<source>/<pane>`, or a bare `<pane>` (older links) in the .env source. */
export function parseAgentRef(sub?: string): AgentRef | null {
  const m = sub?.match(/^(?:(\d+)\/)?(w[0-9A-Za-z]+:p[0-9A-Za-z]+)$/)
  return m ? { source: Number(m[1] ?? 0), pane: m[2] } : null
}

/** The query string that sends an API call to the agent's source. */
export const sourceQuery = (source: number) => `source=${source}`

export const sourcesOf = (agents?: Agents): AgentSource[] => agents?.sources ?? []

/** The source's name, when there is more than one to tell apart; '' otherwise. */
export function sourceLabel(agents: Agents | undefined, a: Pick<Agent, 'source'>): string {
  const all = sourcesOf(agents)
  return all.length > 1 ? (all.find((s) => s.id === sourceOf(a))?.name ?? '') : ''
}

/** The Herdr workspace picked on the Agents page: its source and id. */
export type WorkspaceRef = { source: number; id: string }

const WORKSPACE_KEY = 'marumado.workspace'
const WORKSPACE_EVENT = 'marumado-workspace'

function storedWorkspace(): WorkspaceRef | null {
  try {
    const m = (localStorage.getItem(WORKSPACE_KEY) ?? '').match(/^(\d+)\/(w[0-9A-Za-z]+)$/)
    return m ? { source: Number(m[1]), id: m[2] } : null
  } catch {
    return null
  }
}

/** The workspace picked in this browser (null: all of them), and the way to pick another. */
export function useWorkspace(): [WorkspaceRef | null, (w: WorkspaceRef | null) => void] {
  const [chosen, setChosen] = useState(storedWorkspace)
  useEffect(() => {
    const sync = () => setChosen(storedWorkspace())
    window.addEventListener(WORKSPACE_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(WORKSPACE_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  const set = (w: WorkspaceRef | null) => {
    try {
      if (w) localStorage.setItem(WORKSPACE_KEY, `${w.source}/${w.id}`)
      else localStorage.removeItem(WORKSPACE_KEY)
    } catch {
      // private mode: picked for this page only
    }
    setChosen(w)
    window.dispatchEvent(new Event(WORKSPACE_EVENT))
  }
  return [chosen, set]
}

/** The picked workspace, while its source still lists it. */
export function findWorkspace(agents: Agents | undefined, ref: WorkspaceRef | null): (Workspace & { source: number }) | null {
  if (!ref) return null
  const found = sourcesOf(agents)
    .find((s) => s.id === ref.source)
    ?.workspaces?.find((w) => w.id === ref.id)
  return found ? { ...found, source: ref.source } : null
}

/** The picked workspace, when it is in `source`: new agents there open in it. */
export const workspaceIn = (agents: Agents | undefined, source: number) => {
  const w = findWorkspace(agents, storedWorkspace())
  return w && w.source === source ? w : null
}

/** A workspace's name: its label, or its id when Herdr has none. */
export const workspaceLabel = (w: Pick<Workspace, 'id' | 'label'>) => w.label || w.id

const KIND_KEY = 'marumado.agent-kind'

/** The kind of agent last started from this browser (claude by default). */
export function preferredKind(kinds?: string[]): string {
  let kind = ''
  try {
    kind = localStorage.getItem(KIND_KEY) ?? ''
  } catch {
    /* not remembered */
  }
  const all = kinds ?? ['claude']
  return all.includes(kind) ? kind : all[0] ?? 'claude'
}

/** Start a `kind` agent in the project's folder in `source`, and remember the kind. Resolves once it is open: in a new
    tab of `workspace`, or in a workspace of its own. */
export async function startAgent(project: number | null, kind: string, source: number, workspace?: string): Promise<{ pane_id: string; source: number }> {
  try {
    localStorage.setItem(KIND_KEY, kind)
  } catch {
    /* remembered for this visit only */
  }
  return api('agents/start', { method: 'POST', json: { project, kind, source, ...(workspace ? { workspace } : {}) } })
}
