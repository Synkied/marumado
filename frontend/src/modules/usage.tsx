import { useMemo, useState } from 'react'
import { Meter } from '../components/Meter'
import { niceMax } from '../lib/chart'
import { dollars, tokens } from '../lib/format'
import { useHub } from '../lib/hub'
import { Secret } from '../lib/streaming'
import { dayLabel, shortDay, sumDays, usageDays, type Day, type Sum } from '../lib/usageDays'
import { SheetHead } from './sheetHead'
import './usage.css'

const SPANS: [number, string][] = [
  [14, '14 days'],
  [30, '30 days'],
  [90, '90 days'],
  [0, 'All'],
]

/** "36M tokens · $16.73", for a column's label. */
function amount(s: Sum): string {
  if (!s.calls) return 'nothing'
  return `${tokens(s.total)} tokens${s.cost > 0 ? ` · ${dollars(s.cost)}` : ''}`
}

/** What every agent used each day, from the ledgers kept in ~/.agents where they run (core/daily.py). One reading
    leads: the span's tokens, or the picked day's, with what they were made of; the day strip under it is how you pick;
    then what drove it (models, projects), every day as a row, and where the ledgers are kept. */
export function UsageSheet() {
  const { usage } = useHub()
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
      </SheetHead>

      <div className="ledger__lead">
        <section className="ledger__focus" aria-live="polite">
          <div className="ledger__reading">
            <h3 className="ledger__when">
              {day ? dayLabel(day.day) : spanTitle}
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

      {shown.calls > 0 && (
        <div className="ledger__groups">
          <Breakdown title="By model" items={shown.models} total={shown.total} mono />
          <Breakdown title="By project" items={shown.projects} total={shown.total} />
          {shown.sources.size > 1 && <Breakdown title="By source" items={shown.sources} total={shown.total} />}
        </div>
      )}

      {used.length > 0 && (
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

      <section className="sheet__section ledger__kept">
        <h3>Where it is kept</h3>
        <ul className="list">
          {usage.sources.map((s) => (
            <li className="row" key={s.id}>
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
                      {s.behind ? ', reading older records' : ''}
                    </>
                  ) : (
                    <Secret label="Error">{s.error}</Secret>
                  )}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <p className="ledger__note">
          Each source keeps its own ledger in ~/.agents, beside the agents' session records, so it is backed up with your agent setup and outlives the records
          (Claude Code deletes its own after 30 days). Costs are at API prices; on a subscription nothing is billed per token.
        </p>
      </section>
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
function DayChart({ days, picked, onPick }: { days: Day[]; picked: string | null; onPick: (day: string) => void }) {
  const top = niceMax(Math.max(0, ...days.map((d) => d.total)))
  const order = [...days].reverse()
  const ticks = order.length > 45 ? 30 : 7
  return (
    <figure className="ledger__chart" aria-label="Tokens each day">
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
          <li className="ledger__item" key={name}>
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
