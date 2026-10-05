import { api } from './api'
import type { Agent, Agents, AgentSource } from './types'

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

/** Start a `kind` agent in the project's folder in `source`, and remember the kind. Resolves once its workspace is open. */
export async function startAgent(project: number | null, kind: string, source: number): Promise<{ pane_id: string; source: number }> {
  try {
    localStorage.setItem(KIND_KEY, kind)
  } catch {
    /* remembered for this visit only */
  }
  return api('agents/start', { method: 'POST', json: { project, kind, source } })
}
