import { useMemo, useState, type FormEvent } from 'react'
import { ConfirmButton } from '../components/ConfirmButton'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { ago } from '../lib/format'
import { commits, findSkill, pace, PACE_LABEL, PUSH_GRACE_DAYS, daysSince, skillMap, tracked, USE_LABEL, type SkillRow, type Use } from '../lib/growth'
import { useHub } from '../lib/hub'
import { go } from '../lib/route'
import type { Project, Skill, SkillIntent } from '../lib/types'
import { SheetHead } from './sheetHead'

/** Commits per week as a strip of bars, oldest on the left. */
export function WeekBars({ weeks, label, stretch }: { weeks: number[]; label: string; stretch?: boolean }) {
  const n = 12
  const values = Array.from({ length: n }, (_, i) => weeks[weeks.length - n + i] ?? 0)
  const top = Math.max(1, ...values)
  const total = commits(values)
  return (
    <svg className="weekbars" viewBox={`0 0 ${n * 6} 20`} preserveAspectRatio={stretch ? 'none' : undefined} role="img" aria-label={`${label}: ${total} ${total === 1 ? 'commit' : 'commits'} in the last 12 weeks`}>
      {values.map((v, i) => {
        // Square root keeps one big week from flattening the rest.
        const h = v ? 2 + Math.sqrt(v / top) * 18 : 1
        return <rect key={i} className={v ? 'weekbars__bar' : 'weekbars__none'} x={i * 6} y={20 - h} width={4} height={h} rx={1} />
      })}
    </svg>
  )
}

function paceLine(p: Project): string {
  const total = commits(p.detected.weekly_commits)
  const parts = [p.detected.last_commit_at ? `last commit ${ago(p.detected.last_commit_at)}` : 'no commits']
  if (total) parts.unshift(`${total} ${total === 1 ? 'commit' : 'commits'} in 12 weeks`)
  if (p.detected.dirty_files) parts.push(`${p.detected.dirty_files} uncommitted`)
  return parts.join(' · ')
}

/** A per-viewer choice of view, remembered in this browser when storage allows. */
function useView<T extends string>(key: string, views: readonly T[]): [T, (v: T) => void] {
  const [view, setView] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key) as T | null
      return saved && views.includes(saved) ? saved : views[0]
    } catch {
      return views[0]
    }
  })
  const change = (v: T) => {
    setView(v)
    try {
      localStorage.setItem(key, v)
    } catch {
      // private window or blocked storage: the choice just isn't remembered
    }
  }
  return [view, change]
}

function ViewSwitch<T extends string>({ value, views, onChange }: { value: T; views: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg seg--mod" role="group" aria-label="View">
      {views.map(([v, label]) => (
        <button key={v} type="button" className="seg__btn" aria-pressed={value === v} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

const WEEKS = 12
const WEEK_MS = 7 * 86400000
const lastWeeks = (weeks: number[] | undefined) => Array.from({ length: WEEKS }, (_, i) => weeks?.[(weeks?.length ?? 0) - WEEKS + i] ?? 0)
const shortDate = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
/** 0 for an empty week, else 1–4; square root so one big week doesn't wash out the rest. */
const heatLevel = (v: number, top: number) => (v ? Math.min(4, 1 + Math.floor(Math.sqrt(v / top) * 4)) : 0)

function HeatCells({ weeks, top, starts }: { weeks: number[]; top: number; starts: Date[] }) {
  return weeks.map((v, i) => (
    <span key={i} className="heat__cell" data-level={heatLevel(v, top)} title={`${v} ${v === 1 ? 'commit' : 'commits'} · week of ${shortDate(starts[i])}`} />
  ))
}

type HeatGroup = { title: string; projects: Project[]; dim?: boolean }

/** Every tracked project's last 12 weeks on one screen: a row per project, a cell per week. */
function Heatmap({ groups }: { groups: HeatGroup[] }) {
  const shown = groups.filter((g) => g.projects.length)
  const all = shown.flatMap((g) => g.projects)
  const top = Math.max(1, ...all.flatMap((p) => lastWeeks(p.detected.weekly_commits)))
  const sum = Array.from({ length: WEEKS }, (_, i) => all.reduce((n, p) => n + lastWeeks(p.detected.weekly_commits)[i], 0))
  const now = Date.now()
  const starts = Array.from({ length: WEEKS }, (_, i) => new Date(now - (WEEKS - i) * WEEK_MS))
  return (
    <div className="heat mod-momentum">
      <div className="heat__row heat__row--head" aria-hidden>
        <span className="heat__name">Week of</span>
        {starts.map((d, i) => (
          <span key={i} className="heat__week">
            {i % 3 === 0 ? shortDate(d) : ''}
          </span>
        ))}
        <span className="heat__total">12w</span>
      </div>
      <div className="heat__row heat__row--sum" role="img" aria-label={`All projects: ${commits(sum)} commits in the last 12 weeks`}>
        <span className="heat__name">All projects</span>
        <HeatCells weeks={sum} top={Math.max(1, ...sum)} starts={starts} />
        <span className="heat__total">{commits(sum)}</span>
      </div>
      {shown.map((g) => (
        <section className="heat__group" key={g.title}>
          <h3>
            {g.title} · {g.projects.length}
          </h3>
          {g.projects.map((p) => {
            const weeks = lastWeeks(p.detected.weekly_commits)
            const days = daysSince(p.detected.last_commit_at)
            const slipping = p.focus === 'push' && days != null && days > PUSH_GRACE_DAYS
            const state = pace(p)
            return (
              <a
                key={p.id}
                className={`heat__row${g.dim ? ' heat__row--dim' : ''}`}
                href={`#/m/projects/${p.id}`}
                aria-label={`${p.name}: ${PACE_LABEL[state]}${slipping ? ', marked push but slipping' : ''}, ${commits(weeks)} commits in the last 12 weeks`}
              >
                <span className="heat__name">
                  <span className={slipping ? 'row__lamp row__lamp--fault' : state === 'moving' ? 'row__lamp row__lamp--on' : 'row__lamp'} />
                  <span className="heat__label">{p.name}</span>
                </span>
                <HeatCells weeks={weeks} top={top} starts={starts} />
                <span className="heat__total">{commits(weeks) || '·'}</span>
              </a>
            )
          })}
        </section>
      ))}
      <div className="heat__legend" aria-hidden>
        Less
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className="heat__cell" data-level={l} />
        ))}
        More
      </div>
    </div>
  )
}

function MomentumRow({ p }: { p: Project }) {
  const { refreshProjects } = useHub()
  const [busy, setBusy] = useState(false)
  const save = async (body: Partial<Project>) => {
    setBusy(true)
    try {
      await api(`projects/${p.id}`, { method: 'PATCH', json: body })
      refreshProjects()
    } finally {
      setBusy(false)
    }
  }
  const days = daysSince(p.detected.last_commit_at)
  const slipping = p.focus === 'push' && days != null && days > PUSH_GRACE_DAYS
  const state = pace(p)
  return (
    <li className="row row--wrap">
      <span className={slipping ? 'row__lamp row__lamp--fault' : state === 'moving' ? 'row__lamp row__lamp--on' : 'row__lamp'} role="img" aria-label={PACE_LABEL[state]} />
      <a className="row__main row__link" href={`#/m/projects/${p.id}`}>
        {p.name}
        <span className={`row__sub${slipping ? ' signal-text' : ''}`}>{slipping ? `Marked push, but no commit for ${days} days` : paceLine(p)}</span>
      </a>
      <WeekBars weeks={p.detected.weekly_commits ?? []} label={p.name} />
      <span className="row__actions">
        {p.focus !== 'push' && (
          <button className="chip" type="button" disabled={busy} onClick={() => save({ focus: 'push' })}>
            Push
          </button>
        )}
        {p.focus !== 'park' && (
          <button className="chip" type="button" disabled={busy} onClick={() => save({ focus: 'park' })}>
            Park
          </button>
        )}
        {p.focus && (
          <button className="chip" type="button" disabled={busy} onClick={() => save({ focus: '' })}>
            {p.focus === 'push' ? 'Unpush' : 'Unpark'}
          </button>
        )}
        <ConfirmButton className="chip" confirmLabel="Confirm archive" onConfirm={() => save({ hidden: true })} disabled={busy}>
          Archive
        </ConfirmButton>
      </span>
    </li>
  )
}

function Group({ title, lede, projects }: { title: string; lede?: string; projects: Project[] }) {
  if (!projects.length) return null
  return (
    <section className="sheet__section">
      <h3>
        {title} · {projects.length}
      </h3>
      {lede && <p className="sheet__lede">{lede}</p>}
      <ul className="list">
        {projects.map((p) => (
          <MomentumRow p={p} key={p.id} />
        ))}
      </ul>
    </section>
  )
}

function Untracked({ count }: { count: number }) {
  if (!count) return null
  return (
    <p className="sheet__lede">
      {count} {count === 1 ? 'folder has' : 'folders have'} no git history, so {count === 1 ? 'it is' : 'they are'} left out.
    </p>
  )
}

export function MomentumSheet() {
  const { projects, refreshProjects } = useHub()
  const [scanning, setScanning] = useState(false)
  const [view, setView] = useView('marumado.momentum-view', ['heatmap', 'list'] as const)

  const groups = useMemo(() => {
    const recent = (a: Project, b: Project) => (b.detected.last_commit_at ?? '').localeCompare(a.detected.last_commit_at ?? '')
    const all = tracked(projects).sort(recent)
    const judged = all.filter((p) => pace(p) !== 'none')
    const open = judged.filter((p) => !p.focus)
    return {
      // Slipping pushes first: they are the ones that need you.
      push: judged.filter((p) => p.focus === 'push').sort((a, b) => Number(pace(b) !== 'moving') - Number(pace(a) !== 'moving') || recent(a, b)),
      moving: open.filter((p) => pace(p) === 'moving'),
      slowing: open.filter((p) => pace(p) === 'slowing'),
      stalled: open.filter((p) => pace(p) === 'stalled'),
      parked: judged.filter((p) => p.focus === 'park'),
      untracked: all.length - judged.length,
    }
  }, [projects])

  const scan = async () => {
    setScanning(true)
    try {
      await api('projects/scan', { method: 'POST' })
      refreshProjects()
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="sheet">
      <SheetHead id="momentum">
        <ViewSwitch value={view} views={[['heatmap', 'Heatmap'], ['list', 'List']]} onChange={setView} />
        <button className="btn btn--quiet" type="button" onClick={scan} disabled={scanning}>
          <Icon name="refresh" size={16} /> {scanning ? 'Scanning' : 'Rescan'}
        </button>
      </SheetHead>
      <p className="sheet__lede">
        How each project is moving, from its git history. Push what matters now, park what can wait, archive what is done. Projects marked push are flagged when they go {PUSH_GRACE_DAYS} days without a commit.
      </p>
      {!projects ? (
        <div className="sheet__empty">Loading projects…</div>
      ) : view === 'heatmap' ? (
        <>
          <Heatmap
            groups={[
              { title: 'Pushing', projects: groups.push },
              { title: 'Moving', projects: groups.moving },
              { title: 'Slowing', projects: groups.slowing },
              { title: 'Stalled', projects: groups.stalled },
              { title: 'Parked', projects: groups.parked, dim: true },
            ]}
          />
          <p className="sheet__lede">Open a project from here, or switch to the list to push, park or archive.</p>
          <Untracked count={groups.untracked} />
        </>
      ) : (
        <>
          <Group title="Pushing" projects={groups.push} />
          <Group title="Moving" projects={groups.moving} />
          <Group title="Slowing" projects={groups.slowing} />
          <Group title="Stalled" lede="No commit for over 45 days. Push it, park it, or archive it." projects={groups.stalled} />
          <Group title="Parked" projects={groups.parked} />
          <Untracked count={groups.untracked} />
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- skills

const INTENT_LABEL: Record<SkillIntent, string> = { '': 'No plan', learn: 'Learn', grow: 'Grow', ignore: 'Not a skill' }

/** Save a skill's plan and note; a skill with neither is forgotten. */
async function saveSkill(row: SkillRow, change: { intent?: SkillIntent; note?: string }) {
  const intent = change.intent ?? row.intent
  const note = change.note ?? row.record?.note ?? ''
  if (row.record) {
    if (!intent && !note.trim()) return api(`skills/${row.record.id}`, { method: 'DELETE' })
    return api<Skill>(`skills/${row.record.id}`, { method: 'PATCH', json: { intent, note } })
  }
  if (!intent && !note.trim()) return
  return api<Skill>('skills', { method: 'POST', json: { name: row.name, intent, note } })
}

const skillHref = (name: string) => `#/m/skills/${encodeURIComponent(name)}`

function skillLine(r: SkillRow): string {
  if (!r.projects.length) return 'No project uses it yet'
  const used = `${r.projects.length} ${r.projects.length === 1 ? 'project' : 'projects'} · last used ${ago(r.lastUsed)}`
  if (r.intent === 'learn') return `Started in ${r.projects[0].name} · ${used}`
  return used
}

function SkillCard({ r }: { r: SkillRow }) {
  const n = r.projects.length
  return (
    <li>
      <a className="skillcard" href={skillHref(r.name)}>
        <span className="skillcard__use">
          <span className={r.use === 'active' ? 'row__lamp row__lamp--on' : 'row__lamp'} aria-hidden />
          {USE_LABEL[r.use]}
        </span>
        <span className="skillcard__name">{r.name}</span>
        <span className="skillcard__sub">{n ? `${n} ${n === 1 ? 'project' : 'projects'} · ${ago(r.lastUsed)}` : r.record?.note ? r.record.note : 'No project yet'}</span>
        {n > 0 && <WeekBars weeks={r.weeks} label={r.name} stretch />}
      </a>
    </li>
  )
}

function SkillList({ title, lede, rows, grid }: { title: string; lede?: string; rows: SkillRow[]; grid: boolean }) {
  if (!rows.length) return null
  if (grid)
    return (
      <section className="sheet__section">
        <h3>
          {title} · {rows.length}
        </h3>
        {lede && <p className="sheet__lede">{lede}</p>}
        <ul className="cardgrid mod-skills">
          {rows.map((r) => (
            <SkillCard r={r} key={r.name} />
          ))}
        </ul>
      </section>
    )
  return (
    <section className="sheet__section">
      <h3>
        {title} · {rows.length}
      </h3>
      {lede && <p className="sheet__lede">{lede}</p>}
      <ul className="list">
        {rows.map((r) => (
          <li className="row" key={r.name}>
            <span className={r.use === 'active' ? 'row__lamp row__lamp--on' : 'row__lamp'} role="img" aria-label={USE_LABEL[r.use]} />
            <a className="row__main row__link" href={skillHref(r.name)}>
              {r.name}
              <span className="row__sub">{skillLine(r)}</span>
            </a>
            {r.projects.length > 0 && <WeekBars weeks={r.weeks} label={r.name} />}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function SkillsSheet({ sub }: { sub?: string }) {
  const { projects, skills, refreshSkills } = useHub()
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [showIgnored, setShowIgnored] = useState(false)
  const [view, setView] = useView('marumado.skills-view', ['grid', 'list'] as const)
  const grid = view === 'grid'
  const rows = useMemo(() => skillMap(projects, skills), [projects, skills])

  if (!projects || !skills) return <div className="sheet__empty">Loading skills…</div>
  if (sub) {
    const row = findSkill(rows, decodeURIComponent(sub))
    return row ? <SkillDetail row={row} key={row.name} /> : <div className="sheet__empty">No skill by that name. It may have been removed.</div>
  }

  const byUse = (use: Use) => rows.filter((r) => !r.intent && r.use === use)
  const ignored = rows.filter((r) => r.intent === 'ignore')

  const add = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    const existing = findSkill(rows, name)
    try {
      await saveSkill(existing ?? { name: name.trim(), projects: [], weeks: [], use: 'unused', intent: '' }, { intent: 'learn' })
      refreshSkills()
      setName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add it.")
    }
  }

  return (
    <div className="sheet">
      <SheetHead id="skills">
        <ViewSwitch value={view} views={[['grid', 'Grid'], ['list', 'List']]} onChange={setView} />
      </SheetHead>
      <p className="sheet__lede">
        Built from the stacks and libraries in your projects. Commits keep a skill active: it cools after 30 days without one and turns rusty after 120.
      </p>
      <form className="addline" onSubmit={add}>
        <label className="field">
          Want to learn something?
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rust, Svelte, shaders…" required />
        </label>
        <button className="btn" type="submit" disabled={!name.trim()}>
          <Icon name="plus" size={16} /> Add
        </button>
      </form>
      {error && <p className="notice signal-text">{error}</p>}
      <SkillList grid={grid} title="Learning" rows={rows.filter((r) => r.intent === 'learn')} />
      <SkillList grid={grid} title="Growing" rows={rows.filter((r) => r.intent === 'grow')} />
      <SkillList grid={grid} title="Active" rows={byUse('active')} />
      <SkillList grid={grid} title="Cooling" rows={byUse('cooling')} />
      <SkillList grid={grid} title="Rusty" lede="Used before, but not for months. Keep them, grow them, or mark them as not a skill." rows={byUse('rusty')} />
      {ignored.length > 0 && (
        <section className="sheet__section">
          <h3>
            Not skills · {ignored.length}
          </h3>
          {showIgnored ? (
            <ul className="chips">
              {ignored.map((r) => (
                <li key={r.name}>
                  <a className="chip" href={skillHref(r.name)}>
                    {r.name}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <button className="btn btn--quiet" type="button" onClick={() => setShowIgnored(true)} style={{ justifySelf: 'start' }}>
              Show {ignored.length} hidden
            </button>
          )}
        </section>
      )}
    </div>
  )
}

function SkillDetail({ row }: { row: SkillRow }) {
  const { refreshSkills } = useHub()
  const [note, setNote] = useState(row.record?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (change: { intent?: SkillIntent; note?: string }) => {
    setBusy(true)
    setError('')
    try {
      await saveSkill(row, change)
      refreshSkills()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.")
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    await save({ intent: '', note: '' })
    go('#/m/skills')
  }
  const dirty = note !== (row.record?.note ?? '')

  return (
    <div className="sheet">
      <a className="side__back" href="#/m/skills">
        <Icon name="back" size={18} /> All skills
      </a>
      <header className="sheet__head mod-skills">
        <div style={{ minWidth: 0 }}>
          <span className="sheet__index">{row.intent === 'learn' ? 'LEARNING' : row.intent === 'grow' ? 'GROWING' : USE_LABEL[row.use].toUpperCase()}</span>
          <h2 className="sheet__title" style={{ textTransform: 'none' }}>
            {row.name}
          </h2>
        </div>
        {row.projects.length > 0 && <WeekBars weeks={row.weeks} label={row.name} />}
      </header>

      <section className="sheet__section">
        <h3>Plan</h3>
        <div className="seg seg--mod" role="group" aria-label="Plan for this skill">
          {(['', 'learn', 'grow', 'ignore'] as SkillIntent[]).map((i) => (
            <button key={i} type="button" className="seg__btn" aria-pressed={row.intent === i} disabled={busy} onClick={() => save({ intent: i })}>
              {INTENT_LABEL[i]}
            </button>
          ))}
        </div>
        <label className="field">
          Notes
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it matters, a course to take, a project idea to try it on…" />
        </label>
        {error && <p className="notice signal-text">{error}</p>}
        <div className="sheet__actions" style={{ justifyContent: 'start' }}>
          <button className="btn" type="button" disabled={busy || !dirty} onClick={() => save({ note })}>
            {busy ? 'Saving' : 'Save note'}
          </button>
          {row.record && !row.projects.length && (
            <ConfirmButton onConfirm={remove} confirmLabel="Confirm remove" disabled={busy}>
              Remove skill
            </ConfirmButton>
          )}
        </div>
      </section>

      <section className="sheet__section">
        <h3>Projects using it · {row.projects.length}</h3>
        {row.projects.length ? (
          <ul className="list">
            {row.projects.map((p) => (
              <li className="row" key={p.id}>
                <span className={pace(p) === 'moving' ? 'row__lamp row__lamp--on' : 'row__lamp'} role="img" aria-label={PACE_LABEL[pace(p)]} />
                <a className="row__main row__link" href={`#/m/projects/${p.id}`}>
                  {p.name}
                  <span className="row__sub">{paceLine(p)}</span>
                </a>
                <WeekBars weeks={p.detected.weekly_commits ?? []} label={p.name} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="sheet__lede">No project uses it yet. A small throwaway project is the fastest way to start; it shows up here on the next scan.</p>
        )}
      </section>
    </div>
  )
}
