import type { Project, Skill, SkillIntent } from './types'

/** How a project is moving, from its last commit. `none`: no git history to judge by. */
export type Pace = 'moving' | 'slowing' | 'stalled' | 'none'

export const MOVING_DAYS = 14
export const STALLED_DAYS = 45
/** A project marked "push" with no commit for longer than this needs you. */
export const PUSH_GRACE_DAYS = 14

export const PACE_LABEL: Record<Pace, string> = { moving: 'Moving', slowing: 'Slowing', stalled: 'Stalled', none: 'No git history' }

export function daysSince(iso?: string): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 86400000))
}

export function pace(p: Project): Pace {
  const days = daysSince(p.detected.last_commit_at)
  if (days == null) return 'none'
  if (days <= MOVING_DAYS) return 'moving'
  return days <= STALLED_DAYS ? 'slowing' : 'stalled'
}

/** Projects Momentum looks at: folders of code that still exist. */
export const tracked = (projects: Project[] | undefined) => (projects ?? []).filter((p) => p.kind === 'project' && !p.detected.missing)

export const commits = (weeks: number[] | undefined) => (weeks ?? []).reduce((a, b) => a + b, 0)

/** How fresh a skill is, from the most recent commit in any project that uses it. `unused`: no project yet. */
export type Use = 'active' | 'cooling' | 'rusty' | 'unused'

export const ACTIVE_DAYS = 30
export const RUSTY_DAYS = 120

export const USE_LABEL: Record<Use, string> = { active: 'Active', cooling: 'Cooling', rusty: 'Rusty', unused: 'No project yet' }

export type SkillRow = {
  name: string
  projects: Project[]
  /** ISO date of the latest commit across its projects */
  lastUsed?: string
  /** commits per week across its projects, oldest first */
  weeks: number[]
  use: Use
  intent: SkillIntent
  /** the owner's saved plan or note, if any */
  record?: Skill
}

const keyOf = (name: string) => name.trim().toLowerCase()

/** Every skill: those found in projects (stacks and libraries) plus those added by hand. */
export function skillMap(projects: Project[] | undefined, saved: Skill[] | undefined): SkillRow[] {
  const rows = new Map<string, SkillRow>()
  const row = (name: string) => {
    const key = keyOf(name)
    let r = rows.get(key)
    if (!r) {
      r = { name, projects: [], weeks: [], use: 'unused', intent: '' }
      rows.set(key, r)
    }
    return r
  }
  for (const p of tracked(projects)) {
    for (const name of new Set([...(p.detected.stacks ?? []), ...(p.detected.libs ?? [])])) {
      const r = row(name)
      r.projects.push(p)
      const at = p.detected.last_commit_at
      if (at && (!r.lastUsed || at > r.lastUsed)) r.lastUsed = at
      ;(p.detected.weekly_commits ?? []).forEach((n, i) => (r.weeks[i] = (r.weeks[i] ?? 0) + n))
    }
  }
  for (const s of saved ?? []) {
    const r = row(s.name)
    r.record = s
    r.intent = s.intent
  }
  for (const r of rows.values()) {
    const days = daysSince(r.lastUsed)
    r.use = !r.projects.length ? 'unused' : days != null && days <= ACTIVE_DAYS ? 'active' : days != null && days <= RUSTY_DAYS ? 'cooling' : 'rusty'
    r.projects.sort((a, b) => (b.detected.last_commit_at ?? '').localeCompare(a.detected.last_commit_at ?? ''))
  }
  return [...rows.values()].sort((a, b) => b.projects.length - a.projects.length || a.name.localeCompare(b.name))
}

export const findSkill = (rows: SkillRow[], name: string) => rows.find((r) => keyOf(r.name) === keyOf(name))
