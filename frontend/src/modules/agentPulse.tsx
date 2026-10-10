import { Critter } from '../components/Critter'
import { agentActionHref, agentKey, nameOf, sourceLabel, STATE_WORDS } from '../lib/agents'
import { ago, dollars, duration, tokens } from '../lib/format'
import { useHub } from '../lib/hub'
import type { Agent, Pulse, PulseFolder } from '../lib/types'
import { usePoll } from '../lib/usePoll'
import './agentPulse.css'

const SLOTS = 60 // one a minute: the last hour
const MINUTE = 60_000
const POLL_MS = 15_000
const TOP_PETS = 4

const live = (agents: ReturnType<typeof useHub>['agents']) => (agents?.available ? agents.agents : []).filter((a) => a.kind !== 'terminal')
const rank = (a: Agent) => (a.status === 'blocked' ? 0 : a.status === 'working' ? 1 : 2)
const label = (a: Agent) => `${nameOf(a)}, ${a.kind}${a.project ? ` in ${a.project.name}` : ''}: ${STATE_WORDS[a.status]}`

/** The running agents as critters in the top bar, the ones that need you or are at work first, four at most; each
    opens its agent, and the rest are one click away on the Agents page. */
export function TopPets() {
  const { agents } = useHub()
  const all = [...live(agents)].sort((a, b) => rank(a) - rank(b))
  if (!all.length) return null
  const more = all.length - TOP_PETS
  const moreWaiting = all.slice(TOP_PETS).filter((a) => a.status === 'blocked').length
  return (
    <span className="toppets">
      {all.slice(0, TOP_PETS).map((a) => (
        <a key={agentKey(a)} className={`toppets__pet${a.status === 'blocked' ? ' is-fault' : ''}`} href={agentActionHref(a)} title={label(a)}>
          <Critter seed={agentKey(a)} status={a.status} size={42} />
          <span className="sr-only">{label(a)}</span>
        </a>
      ))}
      {more > 0 && (
        <a className={`toppets__more${moreWaiting ? ' signal-text' : ''}`} href="#/m/agents" title={`${more} more agent${more === 1 ? '' : 's'}${moreWaiting ? `, ${moreWaiting} waiting for you` : ''}`}>
          +{more}
        </a>
      )}
    </span>
  )
}

/** What a step was, as the ribbon draws it: looking around, changing files, running commands, or thinking and
    talking. The colours are the recording's (app.css .rstep__key). */
type Act = 'explore' | 'edit' | 'run' | 'think'
const ACTS: Act[] = ['explore', 'edit', 'run', 'think']
const ACT_WORDS: Record<Act, string> = { explore: 'Reading', edit: 'Editing', run: 'Running', think: 'Thinking' }
const actOf = (kind: string): Act | null =>
  kind === 'you' ? null : kind === 'read' || kind === 'search' ? 'explore' : kind === 'edit' ? 'edit' : kind === 'run' ? 'run' : 'think'

/** One minute of the ribbon: how many steps of each act, whether you wrote to the agent, how many steps failed. */
type Minute = Record<Act, number> & { you: boolean; failed: number }

type Lane = {
  key: string
  agents: Agent[]
  folder?: PulseFolder
  /** the last hour, a minute each, oldest first */
  minutes: Minute[]
  hour: number
}

function laneOf(agents: Agent[], folder: PulseFolder | undefined, now: number): Lane {
  const minutes: Minute[] = Array.from({ length: SLOTS }, () => ({ explore: 0, edit: 0, run: 0, think: 0, you: false, failed: 0 }))
  let hour = 0
  for (const [t, kind, ok] of folder?.steps ?? []) {
    const slot = SLOTS - 1 - Math.floor((now - t) / MINUTE)
    if (slot < 0 || slot >= SLOTS) continue
    const m = minutes[slot]
    const act = actOf(kind)
    if (act) {
      m[act] += 1
      hour += 1
    } else m.you = true
    if (ok === false) m.failed += 1
  }
  return { key: agentKey(agents[0]), agents, folder, minutes, hour }
}

/** Home: what each agent has been doing, minute by minute over the last hour (reading, editing, running, thinking,
    and when you wrote to it), what it did last, and how its turn is going: how long it has been at it or waiting,
    the files it changed and the steps that failed since you last wrote. Agents of one kind in one folder share a
    lane, since their records can't be told apart. Every critter, and every lane, opens its agent. */
export function AgentsAtWork() {
  const { agents } = useHub()
  const every = live(agents)
  const { data } = usePoll<Pulse>(every.length ? 'agents/pulse' : null, POLL_MS)
  if (!every.length) return null

  const now = Date.now()
  const folderOf = new Map<string, PulseFolder>()
  for (const f of data?.folders ?? []) for (const p of f.panes) folderOf.set(`${f.source}/${p}`, f)

  // One lane per folder read, holding its agents; an agent with no record has a lane of its own.
  const byFolder = new Map<PulseFolder | string, Agent[]>()
  for (const a of every) {
    const f = folderOf.get(agentKey(a))
    const k = f ?? agentKey(a)
    byFolder.set(k, [...(byFolder.get(k) ?? []), a])
  }
  const lanes = [...byFolder].map(([k, as]) => laneOf(as, typeof k === 'string' ? undefined : k, now))
  lanes.sort((a, b) => Math.min(...a.agents.map(rank)) - Math.min(...b.agents.map(rank)) || b.hour - a.hour)

  // Every lane on one scale, so a busy agent looks busier than a quiet one.
  const peak = Math.max(1, ...lanes.flatMap((l) => l.minutes.map((m) => m.explore + m.edit + m.run + m.think)))
  const working = every.filter((a) => a.status === 'working').length
  const waiting = every.filter((a) => a.status === 'blocked').length

  return (
    <section className={`mblock mblock--agents mod-agents is-open${waiting ? ' is-fault' : ''}`} aria-label="Agents at work">
      <header className="mblock__head">
        <span className={`mblock__lamp mblock__lamp--${waiting ? 'fault' : 'ok'}`} role="img" aria-label={waiting ? `${waiting} waiting for you` : `${working} working`} />
        <a className="mblock__name" href="#/m/agents" title="Open the agents">
          Agents at work
        </a>
        <span className="mblock__context">what each did, minute by minute, the last hour</span>
        <span className={`mblock__status${waiting ? ' signal-text' : ''}`}>
          {working} of {every.length} working{waiting ? ` · ${waiting} waiting for you` : ''}
        </span>
        <span className="mblock__actions" />
      </header>
      <ul className="pulse">
        {lanes.map((l) => (
          <LaneRow key={l.key} lane={l} peak={peak} pending={!data} now={now} />
        ))}
        <li className="lane lane--axis" aria-hidden="true">
          <span />
          <span className="lane__body">
            <span />
            <span className="pulse__axis">
              <span>−60 min</span>
              <span className="pulse__legend">
                {ACTS.map((a) => (
                  <span key={a}>
                    <i className={`pulse__key pulse__key--${a}`} />
                    {ACT_WORDS[a]}
                  </span>
                ))}
                <span>
                  <i className="pulse__key pulse__key--you" />
                  You wrote
                </span>
                <span>
                  <i className="pulse__key pulse__key--failed" />
                  Failed
                </span>
              </span>
              <span>now</span>
            </span>
            <span />
          </span>
        </li>
      </ul>
    </section>
  )
}

function LaneRow({ lane: l, peak, pending, now }: { lane: Lane; peak: number; pending: boolean; now: number }) {
  const { agents } = useHub()
  const first = l.agents[0]
  const fault = l.agents.some((a) => a.status === 'blocked')
  const busy = l.agents.some((a) => a.status === 'working')
  const status = fault ? 'blocked' : busy ? 'working' : first.status
  const on = sourceLabel(agents, first)
  const where = [first.project?.name ?? l.folder?.cwd.split('/').filter(Boolean).pop(), first.kind, on && `on ${on}`].filter(Boolean).join(' · ')
  const f = l.folder
  const readable = first.kind === 'claude' || first.kind === 'codex'
  const doing = f?.now
    ? `${f.now.title} · ${ago(f.now.t / 1000)}`
    : f?.error
      ? f.error
      : !readable
        ? `Marumado can’t read ${first.kind}’s record`
        : pending
          ? 'reading its record…'
          : 'nothing done in the last day'
  const names = l.agents.map(nameOf).join(', ')

  // The turn: at it since you last wrote while it works; otherwise, how long since its last step.
  const turn = f?.turn
  const usage = f?.usage
  const last = f?.now?.t
  const since = (t: number) => duration(Math.max(60, (now - t) / 1000))
  const headline = busy ? (turn ? `at it ${since(turn.since)}` : 'working') : last ? `${fault ? 'waiting' : 'quiet'} ${since(last)}` : '—'
  const tally = turn ? `${turn.files} file${turn.files === 1 ? '' : 's'} · ${turn.steps} step${turn.steps === 1 ? '' : 's'}` : ''
  return (
    <li className={`lane${fault ? ' is-fault' : ''}`}>
      <span className="lane__pets">
        {l.agents.slice(0, 3).map((a) => (
          <a key={agentKey(a)} className="lane__pet" href={agentActionHref(a)} title={label(a)}>
            <Critter seed={agentKey(a)} status={a.status} size={50} />
            <span className="sr-only">{label(a)}</span>
          </a>
        ))}
      </span>
      <a
        className="lane__body"
        href={agentActionHref(first)}
        aria-label={`${names}: ${STATE_WORDS[status]}, ${headline}.${turn ? ` Since you last wrote: ${tally}, ${turn.failed} failed.` : ''} ${doing}`}
      >
        <span className="lane__who">
          <span className="lane__name">{names}</span>
          <span className="lane__where">
            <span className={fault ? 'signal-text' : undefined}>{STATE_WORDS[status]}</span> · {where}
          </span>
          <span className="lane__now">{doing}</span>
        </span>
        <Ribbon minutes={l.minutes} peak={peak} busy={busy} />
        <span className="lane__turn" title="Since you last wrote to it: the files it changed, its steps, and the ones that failed">
          <span className={`lane__headline${fault ? ' signal-text' : ''}`}>{headline}</span>
          {turn && (
            <span className="lane__tally">
              {tally}
              {turn.failed > 0 && (
                <>
                  {' '}
                  <span className="signal-text">· {turn.failed} failed</span>
                </>
              )}
            </span>
          )}
          {usage && usage.calls > 0 && (
            <span className="lane__tally lane__usage" title="The last day: its tokens and what they cost at API prices, and how full its context is">
              <span>{tokens(usage.total)} tokens</span>
              {usage.priced && (
                <>
                  {' '}
                  <span>· {dollars(usage.cost)}</span>
                </>
              )}
              {usage.context && usage.context.tokens > 0 && (
                <>
                  {' '}
                  <span>· context {tokens(usage.context.tokens)}</span>
                </>
              )}
            </span>
          )}
        </span>
      </a>
    </li>
  )
}

// The ribbon's geometry, in its own units: a slot per minute, the bars standing on a baseline above the failure row.
const SW = 10
const SH = 44
const BASE = 38

/** An hour of work on ruled paper: a bar per minute, as tall as the steps taken (on a square-root scale, so a burst
    doesn't flatten every other minute), split by what they were; an ink rule where you wrote to the agent, a mark
    under the baseline where a step failed, and the pen at "now" on the right. Empty paper is time it sat still. */
function Ribbon({ minutes, peak, busy }: { minutes: Minute[]; peak: number; busy: boolean }) {
  const room = BASE - 3
  return (
    <span className={`ribbon${busy ? ' is-busy' : ''}`} aria-hidden="true">
      <svg viewBox={`0 0 ${SLOTS * SW} ${SH}`} preserveAspectRatio="none">
        {[1, 2, 3, 4, 5].map((i) => (
          <path key={i} className="ribbon__rule" d={`M${i * 10 * SW} 0V${BASE}`} />
        ))}
        <path className="ribbon__base" d={`M0 ${BASE}H${SLOTS * SW}`} />
        {minutes.map((m, i) => {
          const total = m.explore + m.edit + m.run + m.think
          const x = i * SW
          const bars = []
          if (total) {
            const height = Math.max(3, Math.sqrt(total / peak) * room)
            let y = BASE
            for (const a of ACTS) {
              if (!m[a]) continue
              const h = (m[a] / total) * height
              y -= h
              bars.push(<rect key={a} className={`ribbon__act ribbon__act--${a}`} x={x + 1.5} y={y} width={SW - 3} height={h} />)
            }
          }
          return (
            <g key={i}>
              {m.you && <path className="ribbon__you" d={`M${x + SW / 2} 0V${BASE}`} />}
              {bars}
              {m.failed > 0 && <rect className="ribbon__failed" x={x + 1.5} y={BASE + 2} width={SW - 3} height={SH - BASE - 2} />}
            </g>
          )
        })}
      </svg>
      <span className="ribbon__tip" style={{ top: `${(BASE / SH) * 100}%` }} />
    </span>
  )
}
