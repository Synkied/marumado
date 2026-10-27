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

/** "36M tokens", and its cost when there is one. */
function amount(s: Sum): string {
  if (!s.calls) return 'nothing'
  return `${tokens(s.total)} tokens${s.cost > 0 ? ` · ${dollars(s.cost)}` : ''}`
}

/** What every agent used each day, from the ledgers kept in ~/.agents where they run (core/daily.py): the days as a
    chart, then the chosen day's (or the whole span's) models and projects, then every day as a row. */
export function UsageSheet() {
  const { usage } = useHub()
  const [span, setSpan] = useState(30)
  const [picked, setPicked] = useState<string | null>(null)
  const all = useMemo(() => usageDays(usage, 14), [usage])

  if (!usage) return <div className="sheet__empty">Reading what your agents used…</div>

  const days = span ? all.slice(0, span) : all
  const whole = sumDays(days)
  const today = all[0]
  const day = picked ? days.find((d) => d.day === picked) : undefined
  const shown = day ?? whole
  const spanLabel = span ? `the last ${span} days` : `since ${dayLabel(all[all.length - 1].day)}`
  const used = days.filter((d) => d.calls)
  const behind = usage.sources.some((s) => s.behind)
  const unpriced = !whole.priced

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
      <p className="sheet__lede">
        Today, <strong>{amount(today)}</strong>; over {spanLabel}, <strong>{amount(whole)}</strong>
        {whole.cost > 0 ? ' at API prices' : ''}.{behind ? ' Older records are still being read, so earlier days may grow.' : ''}
      </p>

      <DayChart days={days} picked={picked} onPick={(d) => setPicked(d === picked ? null : d)} />

      <section className="sheet__section ledger__detail" aria-live="polite">
        <div className="ledger__detail-head">
          <h3>{day ? dayLabel(day.day) : `Over ${spanLabel}`}</h3>
          {day && (
            <button className="chip" type="button" onClick={() => setPicked(null)}>
              Back to {span ? `${span} days` : 'every day'}
            </button>
          )}
        </div>
        {shown.calls ? (
          <>
            <TokenSplit sum={shown} />
            <div className="ledger__groups">
              <Breakdown title="By model" items={shown.models} mono />
              <Breakdown title="By project" items={shown.projects} />
              {shown.sources.size > 1 && <Breakdown title="By source" items={shown.sources} />}
            </div>
          </>
        ) : (
          <p className="ledger__none">No agent used a token {day ? 'that day' : 'in that time'}.</p>
        )}
      </section>

      <section className="sheet__section">
        <h3>Every day</h3>
        {used.length ? (
          <ul className="list ledger__days">
            {used.map((d) => (
              <li key={d.day}>
                <button
                  type="button"
                  className={`row row--button ledger__day${picked === d.day ? ' is-picked' : ''}`}
                  aria-pressed={picked === d.day}
                  onClick={() => {
                    setPicked(picked === d.day ? null : d.day)
                    document.querySelector('.ledger__chart')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
                  }}
                >
                  <span className="row__main">
                    {dayLabel(d.day)}
                    <span className="row__sub">{[...d.models.keys()].slice(0, 3).join(', ')}{d.models.size > 3 ? ` +${d.models.size - 3}` : ''}</span>
                  </span>
                  <span className="ledger__bar">
                    <Meter percent={(d.total / Math.max(...used.map((x) => x.total))) * 100} label={`${dayLabel(d.day)}: ${tokens(d.total)} tokens`} />
                  </span>
                  <span className="ledger__num">{tokens(d.total)}</span>
                  <span className="ledger__num ledger__cost">{d.cost > 0 ? dollars(d.cost) : '—'}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ledger__none">Nothing yet in {spanLabel}. Days fill in as your agents work.</p>
        )}
      </section>

      <section className="sheet__section">
        <h3>Where it is kept</h3>
        <ul className="list">
          {usage.sources.map((s) => (
            <li className="row" key={s.id}>
              <span className={`row__lamp${s.ok ? (s.behind ? '' : ' row__lamp--on') : ' row__lamp--fault'}`} role="img" aria-label={s.ok ? (s.behind ? 'catching up' : 'up to date') : 'unreadable'} />
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
          Every source keeps its own ledger in ~/.agents, beside the agents' session records, so it is backed up with the rest of your agent setup and outlives
          the records themselves (Claude Code deletes its own after 30 days). Costs are at Anthropic's API prices: with a subscription nothing is billed per
          token.{unpriced ? ' Models without a known price (Codex, others) count in tokens only.' : ''}
        </p>
      </section>
    </div>
  )
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
        <div className="ledger__cols" style={{ gridTemplateColumns: `repeat(${order.length}, minmax(0, 1fr))` }}>
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
              <span className="ledger__fill" style={{ height: d.total ? `max(2px, ${Math.sqrt(d.total / top) * 100}%)` : 0 }} />
            </button>
          ))}
        </div>
      </div>
      <figcaption className="ledger__foot" style={{ gridTemplateColumns: `repeat(${order.length}, minmax(0, 1fr))` }}>
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

/** The tokens by kind: what was new input, written to the cache, read from it, and written out. */
function TokenSplit({ sum }: { sum: Sum }) {
  const t = sum.tokens
  const parts: [string, number][] = [
    ['Input', t.input],
    ['Cache write', t.cache_write],
    ['Cache read', t.cache_read],
    ['Output', t.output],
  ]
  return (
    <dl className="ledger__split">
      {parts.map(([label, n]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{tokens(n)}</dd>
        </div>
      ))}
      <div>
        <dt>Calls</dt>
        <dd>{sum.calls.toLocaleString()}</dd>
      </div>
      <div>
        <dt>At API prices</dt>
        <dd>{sum.cost > 0 ? dollars(sum.cost) : '—'}</dd>
      </div>
    </dl>
  )
}

function Breakdown({ title, items, mono = false }: { title: string; items: Map<string, Sum>; mono?: boolean }) {
  const rows = [...items].sort((a, b) => b[1].total - a[1].total)
  const top = rows[0]?.[1].total || 1
  return (
    <div className="ledger__group">
      <h4>{title}</h4>
      <ul className="list">
        {rows.map(([name, s]) => (
          <li className="ledger__item" key={name}>
            <span className={`ledger__name${mono ? ' mono' : ''}`}>{name === '?' ? 'unknown model' : name}</span>
            <span className="ledger__num">{tokens(s.total)}</span>
            <span className="ledger__num ledger__cost">{s.cost > 0 ? dollars(s.cost) : '—'}</span>
            <span className="ledger__item-bar">
              <Meter percent={(s.total / top) * 100} label={`${name}: ${tokens(s.total)} tokens`} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
