import { useCallback, useEffect, useMemo, useState } from 'react'
import { Meter } from '../components/Meter'
import { niceMax } from '../lib/chart'
import { api } from '../lib/api'
import { ago, bytes, dollars, tokens } from '../lib/format'
import { TIME_ZONE, useHub } from '../lib/hub'
import { Secret } from '../lib/streaming'
import { dayLabel, shortDay, sumDays, usageDays, type Day, type Sum } from '../lib/usageDays'
import { SheetHead } from './sheetHead'
import type { UsageCheck, UsageRecap, UsageSource } from '../lib/types'
import './usage.css'

const SPANS: [number, string][] = [
  [14, '14 days'],
  [30, '30 days'],
  [90, '90 days'],
  [0, 'All'],
]

/** The page's views, as tabs under its head (`#/m/usage/<id>`); the first is the page itself. */
type Tab = '' | 'projects' | 'models' | 'collector'
const TABS: [Tab, string][] = [
  ['', 'Overview'],
  ['projects', 'Projects'],
  ['models', 'Models'],
  ['collector', 'Collector'],
]

/** "36M tokens · $16.73", for a column's label. */
function amount(s: Sum): string {
  if (!s.calls) return 'nothing'
  return `${tokens(s.total)} tokens${s.cost > 0 ? ` · ${dollars(s.cost)}` : ''}`
}

/** What every agent used each day, from the ledgers kept in ~/.agents where they run (core/daily.py). One reading
    leads: the span's tokens, or the picked day's, with what they were made of; the day strip under it is how you pick;
    then what drove it (models, projects), every day as a row, and where the ledgers are kept. */
export function UsageSheet({ sub }: { sub?: string }) {
  const { usage } = useHub()
  const tab: Tab = TABS.some(([id]) => id === sub) ? (sub as Tab) : ''
  const [span, setSpan] = useState(30)
  const [picked, setPicked] = useState<string | null>(null)
  const all = useMemo(() => usageDays(usage, 14), [usage])

  if (!usage) return <div className="sheet__empty">Reading what your agents used…</div>

  const days = span ? all.slice(0, span) : all
  const whole = sumDays(days)
  const day = picked ? days.find((d) => d.day === picked) : undefined
  const shown = day ?? whole
  const spanTitle = span ? `Last ${span} days` : `Since ${dayLabel(all[all.length - 1].day)}`
  const used = days.filter((d) => d.calls)
  const busiest = used.reduce<Day | undefined>((a, d) => (!a || d.total > a.total ? d : a), undefined)
  const behind = usage.sources.some((s) => s.behind)
  const pick = (d: string | null) => setPicked(d === picked ? null : d)

  return (
    <div className="sheet mod-usage">
      <SheetHead id="usage">
        {tab !== 'collector' && (
          <div className="seg" role="group" aria-label="How far back">
            {SPANS.map(([n, label]) => (
              <button
                key={n}
                type="button"
                className="seg__btn"
                aria-pressed={span === n}
                onClick={() => {
                  setSpan(n)
                  setPicked(null)
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </SheetHead>
      <nav className="seg seg--tabs mod-usage" aria-label="Usage">
        {TABS.map(([id, label]) => (
          <a key={id} className="seg__btn" href={id ? `#/m/usage/${id}` : '#/m/usage'} aria-current={id === tab ? 'page' : undefined}>
            {label}
            {id === 'projects' && shown.projects.size > 0 && <span className="ledger__tab-count">{shown.projects.size}</span>}
            {id === 'models' && shown.models.size > 0 && <span className="ledger__tab-count">{shown.models.size}</span>}
            {id === 'collector' && usage.sources.some((x) => !x.ok) && (
              <span className="row__lamp row__lamp--fault ledger__tab-lamp" role="img" aria-label="a source can't be read" />
            )}
          </a>
        ))}
      </nav>

      {tab === '' && (
        <div className="ledger__lead">
          <section className="ledger__focus" aria-live="polite">
            <div className="ledger__reading">
              <h3 className="ledger__when">
                {day ? dayLabel(day.day) : spanTitle}
                {!day && (
                  <span className="ledger__range">
                    {shortDay(days[days.length - 1].day)} – {shortDay(days[0].day)}
                  </span>
                )}
                {day && (
                  <button className="chip" type="button" onClick={() => setPicked(null)}>
                    Back to {span ? `${span} days` : 'every day'}
                  </button>
                )}
              </h3>
              <p className="ledger__figure">
                <span className="ledger__value">{tokens(shown.total)}</span> tokens
              </p>
              <p className="ledger__context">
                {shown.cost > 0 ? (
                  <>
                    <span className="mono">{dollars(shown.cost)}</span> at API prices
                  </>
                ) : (
                  'No priced model'
                )}
                {' · '}
                <span className="mono">{shown.calls.toLocaleString()}</span> {shown.calls === 1 ? 'call' : 'calls'}
              </p>
              <p className="ledger__compare">
                {day ? (
                  whole.total > 0 && (
                    <>
                      <span className="mono">{share(day.total, whole.total)}</span> of {spanTitle.toLowerCase()}
                    </>
                  )
                ) : busiest ? (
                  <>
                    Busiest day: {busiest.day === all[0].day ? 'today' : dayLabel(busiest.day)}, <span className="mono">{tokens(busiest.total)}</span> · agents
                    worked on {used.length} of {days.length} days
                  </>
                ) : (
                  'Nothing yet. Days fill in as your agents work.'
                )}
              </p>
              {behind && <p className="ledger__compare">Older records are still being read, so earlier days may grow.</p>}
            </div>
            {shown.total > 0 && <TokenMix sum={shown} />}
          </section>

          <DayChart days={days} picked={picked} onPick={pick} />
        </div>
      )}

      {(tab === 'projects' || tab === 'models') && (
        <section className="ledger__scope" aria-live="polite">
          <div className="ledger__scope-line">
            <h3 className="ledger__when">
              {day ? dayLabel(day.day) : spanTitle}
              {!day && (
                <span className="ledger__range">
                  {shortDay(days[days.length - 1].day)} – {shortDay(days[0].day)}
                </span>
              )}
              {day && (
                <button className="chip" type="button" onClick={() => setPicked(null)}>
                  Back to {span ? `${span} days` : 'every day'}
                </button>
              )}
            </h3>
            <p className="ledger__scope-sum">
              <span className="mono">{tokens(shown.total)}</span> tokens
              {shown.cost > 0 && (
                <>
                  {' · '}
                  <span className="mono">{dollars(shown.cost)}</span> at API prices
                </>
              )}
              {' · '}
              <span className="mono">{shown.calls.toLocaleString()}</span> {shown.calls === 1 ? 'call' : 'calls'}
            </p>
          </div>
          <DayChart days={days} picked={picked} onPick={pick} compact />
        </section>
      )}

      {(tab === 'projects' || tab === 'models') && shown.calls === 0 && (
        <p className="sheet__empty">
          No agent work {day ? `on ${dayLabel(day.day).toLowerCase() === 'today' ? 'today' : dayLabel(day.day)}` : `in the ${spanTitle.toLowerCase()}`}. Pick a
          day with a column to see it.
        </p>
      )}

      {tab === 'projects' && shown.calls > 0 && (
        <ProjectWork
          key={day ? day.day : `${days[days.length - 1].day}/${days[0].day}`}
          items={shown.projects}
          total={shown.total}
          from={day ? day.day : days[days.length - 1].day}
          to={day ? day.day : days[0].day}
          when={day ? dayLabel(day.day).toLowerCase() : spanTitle.toLowerCase()}
        />
      )}

      {tab === 'models' && shown.calls > 0 && (
        <div className="ledger__groups">
          <Breakdown title="By model" items={shown.models} total={shown.total} mono />
          {shown.sources.size > 1 && <Breakdown title="By source" items={shown.sources} total={shown.total} />}
        </div>
      )}

      {tab === '' && used.length > 0 && (
        <section className="sheet__section">
          <h3>Every day</h3>
          <ul className="list ledger__days">
            {used.map((d) => (
              <li key={d.day}>
                <button
                  type="button"
                  className={`row row--button ledger__day${picked === d.day ? ' is-picked' : ''}`}
                  aria-pressed={picked === d.day}
                  onClick={() => {
                    pick(d.day)
                    document.querySelector('.ledger__focus')?.scrollIntoView({
                      block: 'nearest',
                      behavior: 'smooth',
                    })
                  }}
                >
                  <span className="row__main">
                    {dayLabel(d.day)}
                    <span className="row__sub">
                      {[...d.models.keys()].slice(0, 3).join(', ')}
                      {d.models.size > 3 ? ` +${d.models.size - 3}` : ''}
                    </span>
                  </span>
                  <span className="ledger__num">{tokens(d.total)}</span>
                  <span className="ledger__num ledger__cost">{d.cost > 0 ? dollars(d.cost) : '—'}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === 'collector' && <Collector sources={usage.sources} day={day?.day ?? all[0].day} />}
    </div>
  )
}

/** "4%", "<1%". */
function share(n: number, of: number): string {
  const p = (n / of) * 100
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
}

/** One column per day, oldest at the left, on ruled space: the height is the day's tokens, on a square-root scale so
    a light day still shows beside a heavy one. A column is a button that picks the day. */
function DayChart({ days, picked, onPick, compact = false }: { days: Day[]; picked: string | null; onPick: (day: string) => void; compact?: boolean }) {
  const top = niceMax(Math.max(0, ...days.map((d) => d.total)))
  const order = [...days].reverse()
  const ticks = order.length > 45 ? 30 : 7
  return (
    <figure className={`ledger__chart${compact ? ' ledger__chart--compact' : ''}`} aria-label="Tokens each day">
      <div className="ledger__plot">
        <span className="ledger__axis ledger__axis--top">{tokens(top)}</span>
        <span className="ledger__axis ledger__axis--mid">{tokens(top / 4)}</span>
        <div
          className="ledger__cols"
          style={{
            gridTemplateColumns: `repeat(${order.length}, minmax(0, 1fr))`,
          }}
        >
          {order.map((d, i) => (
            <button
              key={d.day}
              type="button"
              className={`ledger__col${picked === d.day ? ' is-picked' : ''}${i === order.length - 1 ? ' is-today' : ''}`}
              aria-pressed={picked === d.day}
              aria-label={`${dayLabel(d.day)}: ${amount(d)}`}
              title={`${dayLabel(d.day)}: ${amount(d)}`}
              onClick={() => onPick(d.day)}
            >
              <span
                className="ledger__fill"
                style={{
                  height: d.total ? `max(2px, ${Math.sqrt(d.total / top) * 100}%)` : 0,
                }}
              />
            </button>
          ))}
        </div>
      </div>
      <figcaption
        className="ledger__foot"
        style={{
          gridTemplateColumns: `repeat(${order.length}, minmax(0, 1fr))`,
        }}
      >
        {order.map((d, i) =>
          (order.length - 1 - i) % ticks === 0 ? (
            <span key={d.day} style={{ gridColumn: i + 1 }}>
              {i === order.length - 1 ? 'today' : shortDay(d.day)}
            </span>
          ) : null,
        )}
      </figcaption>
    </figure>
  )
}

/** What the tokens were made of, as one bar split by kind with its key: an agent's tokens are mostly the cache read
    back on every call, and that share is the thing to see. */
function TokenMix({ sum }: { sum: Sum }) {
  const t = sum.tokens
  const parts: [string, string, number][] = [
    ['read', 'Cache read', t.cache_read],
    ['write', 'Cache write', t.cache_write],
    ['input', 'Input', t.input],
    ['output', 'Output', t.output],
  ]
  return (
    <figure className="ledger__mix" aria-label="Tokens by kind">
      <div className="ledger__mix-bar" aria-hidden="true">
        {parts.map(([k, , n]) => (n ? <span key={k} className={`ledger__mix-${k}`} style={{ flexGrow: n }} /> : null))}
      </div>
      <dl className="ledger__mix-key">
        {parts.map(([k, label, n]) => (
          <div key={k}>
            <dt>
              <span className={`ledger__swatch ledger__mix-${k}`} aria-hidden="true" />
              {label}
            </dt>
            <dd>
              <span className="ledger__num">{tokens(n)}</span>
              <span className="ledger__share">{share(n, sum.total)}</span>
            </dd>
          </div>
        ))}
      </dl>
    </figure>
  )
}

/** A breakdown's rows, largest first: the name, its share of the whole with a meter, tokens and cost. Past six rows
    the rest fold into one. */
function Breakdown({ title, items, total, mono = false }: { title: string; items: Map<string, Sum>; total: number; mono?: boolean }) {
  const [open, setOpen] = useState(false)
  const rows = [...items].sort((a, b) => b[1].total - a[1].total)
  const shown = open || rows.length <= 7 ? rows : rows.slice(0, 6)
  return (
    <section className="ledger__group">
      <h3>{title}</h3>
      <ul className="list">
        {shown.map(([name, s]) => (
          <li className="ledger__item ledger__item--wide" key={name}>
            <span className={`ledger__name${mono ? ' mono' : ''}`} title={name}>
              {name === '?' ? 'unknown model' : name}
            </span>
            <span className="ledger__share">{share(s.total, total)}</span>
            <span className="ledger__num">{tokens(s.total)}</span>
            <span className="ledger__num ledger__cost">{s.cost > 0 ? dollars(s.cost) : '—'}</span>
            <span className="ledger__item-bar">
              <Meter percent={(s.total / (total || 1)) * 100} label={`${name}: ${share(s.total, total)} of the tokens`} />
            </span>
          </li>
        ))}
      </ul>
      {shown.length < rows.length && (
        <button className="chip ledger__more" type="button" onClick={() => setOpen(true)}>
          {rows.length - shown.length} more
        </button>
      )}
    </section>
  )
}

/** A line of a summary: `code` in mono, **bold** as plain words. */
function inline(line: string) {
  return line
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .split(/(`[^`]+`)/)
    .map((part, i) =>
      part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
        <span key={i} className="mono">
          {part.slice(1, -1)}
        </span>
      ) : (
        part
      ),
    )
}

/** A summary's bullets ("- …"), as a list; anything else as paragraphs. */
function RecapText({ text }: { text: string }) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const bullets = lines.filter((l) => /^[-*•]\s/.test(l))
  if (bullets.length && bullets.length >= lines.length - 1)
    return (
      <ul className="recap__list">
        {bullets.map((l, i) => (
          <li key={i}>{inline(l.replace(/^[-*•]\s+/, ''))}</li>
        ))}
      </ul>
    )
  return (
    <div className="recap__list">
      {lines.map((l, i) => (
        <p key={i}>{l}</p>
      ))}
    </div>
  )
}

/** "12 prompts, 5 commits and 2 tasks": what a summary was written from. */
function basis(c: UsageRecap['counts']): string {
  const parts = [
    c.prompts && `${c.prompts} ${c.prompts === 1 ? 'prompt' : 'prompts'}`,
    c.commits && `${c.commits} ${c.commits === 1 ? 'commit' : 'commits'}`,
    c.tasks && `${c.tasks} finished ${c.tasks === 1 ? 'task' : 'tasks'}`,
  ].filter(Boolean) as string[]
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '')
}

type Writing = { busy: Set<string>; errors: Map<string, string> }

/** What was done on each project over the days shown: the projects by tokens (their share, tokens, cost), each with a
    summary Claude writes from what its agents were told, its commits and its finished tasks (core/recap.py). Written
    on demand, one project or all of them, and kept, so they come back with the same days. */
function ProjectWork({ items, total, from, to, when }: { items: Map<string, Sum>; total: number; from: string; to: string; when: string }) {
  const [recaps, setRecaps] = useState<Map<string, UsageRecap>>(new Map())
  const [writing, setWriting] = useState<Writing>({
    busy: new Set(),
    errors: new Map(),
  })
  const [queue, setQueue] = useState<{ done: number; of: number } | null>(null)
  const [open, setOpen] = useState(false)
  const rows = [...items].sort((a, b) => b[1].total - a[1].total)
  const shown = open || rows.length <= 7 ? rows : rows.slice(0, 6)

  useEffect(() => {
    let live = true
    api<{ recaps: UsageRecap[] }>(`usage/recap?from=${from}&to=${to}`)
      .then((r) => live && setRecaps(new Map(r.recaps.map((x) => [x.project, x]))))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [from, to])

  const write = useCallback(
    async (project: string) => {
      setWriting((w) => {
        const errors = new Map(w.errors)
        errors.delete(project)
        return { busy: new Set(w.busy).add(project), errors }
      })
      try {
        const r = await api<UsageRecap>('usage/recap', {
          method: 'POST',
          json: { project, from, to, tz: TIME_ZONE },
        })
        setRecaps((m) => new Map(m).set(project, r))
      } catch (e) {
        setWriting((w) => ({
          ...w,
          errors: new Map(w.errors).set(project, e instanceof Error ? e.message : String(e)),
        }))
      } finally {
        setWriting((w) => {
          const busy = new Set(w.busy)
          busy.delete(project)
          return { ...w, busy }
        })
      }
    },
    [from, to],
  )

  const missing = rows.map(([name]) => name).filter((name) => !recaps.has(name))
  const writeAll = async () => {
    setQueue({ done: 0, of: missing.length })
    for (const [i, name] of missing.entries()) {
      await write(name)
      setQueue({ done: i + 1, of: missing.length })
    }
    setQueue(null)
  }

  return (
    <section className="sheet__section recap" aria-labelledby="recap-title">
      <div className="recap__head">
        <div>
          <h3 id="recap-title">What was done</h3>
          <p className="recap__lede">
            Each project's share of {when}. A summary is written by Claude from what its agents were asked, its commits and its finished tasks.
          </p>
        </div>
        {missing.length > 1 && (
          <button className="chip" type="button" onClick={writeAll} disabled={!!queue}>
            {queue ? `Summarizing ${Math.min(queue.done + 1, queue.of)} of ${queue.of}…` : `Summarize all ${missing.length}`}
          </button>
        )}
      </div>
      <ul className="list">
        {shown.map(([name, s]) => {
          const recap = recaps.get(name)
          const busy = writing.busy.has(name)
          const error = writing.errors.get(name)
          return (
            <li className="recap__item" key={name}>
              <div className="ledger__item recap__row">
                <span className="ledger__name" title={name}>
                  {name}
                </span>
                <span className="ledger__share">{share(s.total, total)}</span>
                <span className="ledger__num">{tokens(s.total)}</span>
                <span className="ledger__num ledger__cost">{s.cost > 0 ? dollars(s.cost) : '—'}</span>
                <span className="recap__action">
                  {!recap && (
                    <button className="chip" type="button" onClick={() => write(name)} disabled={busy} aria-label={`Summarize what was done on ${name}`}>
                      {busy ? 'Writing…' : 'Summarize'}
                    </button>
                  )}
                </span>
                <span className="ledger__item-bar">
                  <Meter percent={(s.total / (total || 1)) * 100} label={`${name}: ${share(s.total, total)} of the tokens`} />
                </span>
              </div>
              {(recap || busy || error) && (
                <div className="recap__body" aria-live="polite" aria-busy={busy}>
                  {busy && !recap && <p className="recap__meta">Reading {name}'s sessions and commits, then asking Claude. This takes up to a minute.</p>}
                  {error && <p className="recap__meta recap__error">Couldn't summarize it: {error}</p>}
                  {recap && (
                    <>
                      {recap.text ? (
                        <RecapText text={recap.text} />
                      ) : (
                        <p className="recap__empty">Nothing to go on: no prompts, commits or finished tasks in these days. Agents' records go after 30 days.</p>
                      )}
                      <p className="recap__meta">
                        {recap.text && <>From {basis(recap.counts)} · </>}
                        written {ago(recap.at)}
                        {recap.errors.length > 0 && <> · {recap.errors.length === 1 ? 'one source' : `${recap.errors.length} sources`} couldn't be read</>}
                        {' · '}
                        <button className="recap__again" type="button" onClick={() => write(name)} disabled={busy}>
                          {busy ? 'Writing…' : 'Write again'}
                        </button>
                      </p>
                    </>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {shown.length < rows.length && (
        <button className="chip ledger__more" type="button" onClick={() => setOpen(true)}>
          {rows.length - shown.length} more
        </button>
      )}
    </section>
  )
}

/** The collector at work: each source's ledger, how much of its records it has read, its last runs (every 10 minutes,
    more often while catching up, and whenever this page asks), and a check of where a day's tokens come from. */
function Collector({ sources, day }: { sources: UsageSource[]; day: string }) {
  const { refreshUsage } = useHub()
  const [reading, setReading] = useState(false)
  const [check, setCheck] = useState<{
    day: string
    data?: UsageCheck
    error?: string
  } | null>(null)

  const readNow = async () => {
    setReading(true)
    try {
      await api(`usage?tz=${encodeURIComponent(TIME_ZONE)}&fresh=1`)
      await refreshUsage()
    } finally {
      setReading(false)
    }
  }
  const runCheck = async () => {
    setCheck({ day })
    try {
      setCheck({
        day,
        data: await api<UsageCheck>(`usage/check?day=${day}&tz=${encodeURIComponent(TIME_ZONE)}`),
      })
    } catch (e) {
      setCheck({ day, error: String(e) })
    }
  }

  return (
    <section className="sheet__section ledger__kept">
      <div className="ledger__kept-head">
        <h3>Collector</h3>
        <button className="chip" type="button" onClick={readNow} disabled={reading}>
          {reading ? 'Reading…' : 'Read now'}
        </button>
        <button className="chip" type="button" onClick={runCheck} disabled={!!check && !check.data && !check.error}>
          Check {dayLabel(day).toLowerCase() === 'today' ? 'today' : dayLabel(day)}
        </button>
      </div>
      <ul className="list">
        {sources.map((s) => {
          const last = s.runs?.[0]
          return (
            <li className="row ledger__source" key={s.id}>
              <span
                className={`row__lamp${s.ok ? (s.behind ? '' : ' row__lamp--on') : ' row__lamp--fault'}`}
                role="img"
                aria-label={s.ok ? (s.behind ? 'catching up' : 'up to date') : 'unreadable'}
              />
              <span className="row__main">
                {s.name}
                <span className="row__sub">
                  {s.ok ? (
                    <>
                      <Secret label="Path">
                        <span className="mono">{s.stored}</span>
                      </Secret>{' '}
                      {s.where}
                    </>
                  ) : (
                    <Secret label="Error">{s.error}</Secret>
                  )}
                </span>
                {s.ok && s.size ? (
                  <span className="ledger__progress">
                    <Meter percent={((s.done ?? 0) / s.size) * 100} label={`${s.name}: ${bytes(s.done)} of ${bytes(s.size)} read`} />
                    <span className="mono">
                      {s.tracked} records · {bytes(s.done)} of {bytes(s.size)} read{s.behind ? ', catching up' : ''}
                    </span>
                  </span>
                ) : null}
                {last && (
                  <span className="ledger__runs mono">
                    {s.runs!.slice(0, 4).map((r) => (
                      <span key={r.at}>
                        {ago(r.at)}: {r.records ? `${r.records} records, ${bytes(r.read)}, +${r.calls.toLocaleString()} calls` : 'nothing new'} in {r.took}s
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {check && <CheckResult check={check} />}
      <p className="ledger__note">
        Each source keeps its own ledger in ~/.agents, beside the agents' session records, so it is backed up with your agent setup and outlives the records
        (Claude Code deletes its own after 30 days). Costs are at API prices; on a subscription nothing is billed per token.
      </p>
    </section>
  )
}

/** A day's check: per source, the records that used most, the ledger's count against reading the record again. */
function CheckResult({ check }: { check: { day: string; data?: UsageCheck; error?: string } }) {
  if (check.error) return <p className="ledger__note">The check failed: {check.error}</p>
  if (!check.data) return <p className="ledger__note">Reading the records of {dayLabel(check.day)} again…</p>
  return (
    <div className="ledger__check" aria-live="polite">
      {check.data.sources.map((s) => (
        <div key={s.id} className="ledger__check-source">
          <p className="ledger__compare">
            <strong>{s.name}</strong>
            {s.error ? (
              <> · {s.error}</>
            ) : (
              <>
                {' '}
                · {dayLabel(check.day)}: <span className="mono">{tokens(s.tokens ?? 0)}</span> tokens in{' '}
                <span className="mono">{(s.calls ?? 0).toLocaleString()}</span> calls from {s.count ?? 0} records
              </>
            )}
          </p>
          {s.records.length > 0 && (
            <table className="ledger__table">
              <thead>
                <tr>
                  <th scope="col">Record</th>
                  <th scope="col">In the ledger</th>
                  <th scope="col">Read again</th>
                  <th scope="col">In another record too</th>
                </tr>
              </thead>
              <tbody>
                {s.records.map((r) => {
                  const off = r.again && (r.again[0] !== r.ledger[0] || r.again[1] !== r.ledger[1])
                  return (
                    <tr key={r.path} className={off || r.shared ? 'is-off' : ''}>
                      <td className="ledger__path">
                        <Secret label="Path">
                          <span className="mono" title={r.path}>
                            {r.path.split('/').slice(-2).join('/')}
                          </span>
                        </Secret>
                        {r.listed === false && <span className="ledger__share"> not listed now</span>}
                      </td>
                      <td className="mono">
                        {r.ledger[0].toLocaleString()} · {tokens(r.ledger[1])}
                      </td>
                      <td className="mono">{r.again ? `${r.again[0].toLocaleString()} · ${tokens(r.again[1])}` : '—'}</td>
                      <td className="mono">{r.again ? (r.shared ? `${r.shared} calls` : 'none') : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  )
}
