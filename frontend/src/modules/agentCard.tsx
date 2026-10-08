import { useEffect, useRef, useState } from 'react'
import { agentHref, agentKey, sourceLabel, sourceQuery, STATE_WORDS } from '../lib/agents'
import { api, ApiError } from '../lib/api'
import { desktop, desktopLogIn } from '../lib/desktop'
import { usePoll } from '../lib/usePoll'
import type { Agent, Agents, AgentStatus } from '../lib/types'
import './agentCard.css'

/** The desktop app's agents card (#/card): a small window by the tray icon listing every agent, who needs you first,
    then who is working and for how long, then the rest. Each says what its terminal title says it is doing, where it
    runs, what a plan has queued for it and, while it works or waits on you, the last line of its screen. Choosing one
    opens its page in the app's main window. */

const ORDER: Record<AgentStatus, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 }
const SCREENED: AgentStatus[] = ['working', 'blocked']

const BORDER = /[│┃║╭╮╰╯┌┐└┘├┤─━═╌╍▏▕]/g
// Claude Code's activity line: "✻ Pondering… (12s · ↑ 1.2k tokens · esc to interrupt)".
const ACTIVITY = /esc to interrupt/i
const NOISE = /^(>|\?\s|⏵⏵|bypass permissions|accept edits)|for shortcuts/i

/** The one line of an agent's screen worth showing: its activity line if it has one, else its last line of text. */
export function screenLine(screen: string): string {
  const lines = screen
    .split('\n')
    .map((l) => l.replace(BORDER, '').trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l))
    .reverse()
  const activity = lines.find((l) => ACTIVITY.test(l))
  if (activity) return activity.replace(/\s*[·(]?\s*esc to interrupt\)?/i, ')').replace('())', '').replace(' )', ')').trim()
  return lines.find((l) => !NOISE.test(l)) ?? ''
}

function working(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'working, just now'
  if (m < 60) return `working ${m} min`
  return `working ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

const doing = (a: Agent) => {
  const t = a.title.trim()
  return !t || t.toLowerCase() === a.kind.toLowerCase() || t.toLowerCase() === 'claude code' ? '' : t
}

function summary(agents: Agent[]): string {
  if (!agents.length) return 'No agents running'
  const n = (s: AgentStatus) => agents.filter((a) => a.status === s).length
  return [
    [n('blocked'), 'needs you', 'need you'],
    [n('working'), 'working', 'working'],
    [n('done'), 'finished', 'finished'],
    [n('idle'), 'idle', 'idle'],
  ]
    .filter(([count]) => count)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`)
    .join(' · ')
}

const open = (hash: string) => desktop('open_page', { hash }).catch(() => undefined)

export function AgentCard() {
  const poll = usePoll<Agents>('agents', 3000, true)
  const [since, setSince] = useState<Record<string, number>>({})
  const [screens, setScreens] = useState<Record<string, string>>({})
  const [now, setNow] = useState(Date.now())
  const card = useRef<HTMLElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const { refresh, error } = poll

  const agents = (poll.data?.available ? poll.data.agents : []).filter((a) => a.kind !== 'terminal').sort((a, b) => ORDER[a.status] - ORDER[b.status])
  const screenKeys = agents.filter((a) => SCREENED.includes(a.status)).map(agentKey).join(' ')

  // Shown again from the tray: read at once rather than show what was read when it was last open.
  useEffect(() => {
    const again = () => void refresh()
    window.addEventListener('marumado:card', again)
    const close = (e: KeyboardEvent) => e.key === 'Escape' && desktop('hide_card').catch(() => undefined)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('marumado:card', again)
      window.removeEventListener('keydown', close)
    }
  }, [refresh])

  // The main window may not have logged in yet (the app started with the session).
  useEffect(() => {
    if (error instanceof ApiError && error.status === 403) desktopLogIn().then((ok) => void (ok && refresh()))
  }, [error, refresh])

  // Since when each agent works, as the tray has seen it (it reads Marumado all along); the times move on by the minute.
  useEffect(() => {
    desktop<Record<string, number>>('working_since').then(setSince, () => undefined)
    setNow(Date.now())
  }, [poll.data])
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [])

  // The window is as tall as the card's content (the app caps it, and then the list scrolls).
  useEffect(() => {
    const [main, ul] = [card.current, list.current]
    if (!main || !ul) return
    const fit = () => desktop('fit_card', { height: main.offsetHeight - ul.clientHeight + ul.scrollHeight }).catch(() => undefined)
    const watch = new ResizeObserver(fit)
    watch.observe(main)
    for (const child of ul.children) watch.observe(child)
    fit()
    return () => watch.disconnect()
  })

  // The screens' last lines, every 5 s, for the agents working or waiting on you (keyed by `source/pane`).
  useEffect(() => {
    const keys = screenKeys ? screenKeys.split(' ') : []
    const read = async () => {
      const lines = await Promise.all(
        keys.map(async (k) => {
          const [source, pane] = [Number(k.slice(0, k.indexOf('/'))), k.slice(k.indexOf('/') + 1)]
          try {
            const out = await api<{ output: string }>(`agents/${encodeURIComponent(pane)}/output?lines=40&${sourceQuery(source)}`)
            return [k, screenLine(out.output)] as const
          } catch {
            return [k, ''] as const
          }
        }),
      )
      setScreens(Object.fromEntries(lines))
    }
    void read()
    const id = window.setInterval(read, 5000)
    return () => window.clearInterval(id)
  }, [screenKeys])

  const down = poll.error && !poll.data
  const fault = down ? (poll.error instanceof ApiError && poll.error.status === 403 ? 'This window isn’t logged in to Marumado.' : poll.error?.message) : poll.data && !poll.data.available ? poll.data.error || 'Herdr is not running.' : ''

  return (
    <main className="acard" ref={card}>
      <header className="acard__head">
        <h1 className={`acard__title${fault ? ' signal-text' : ''}`}>{fault ? 'Marumado can’t be read' : poll.data ? summary(agents) : 'Reading Marumado…'}</h1>
        <button type="button" className="acard__link" onClick={() => open('#/m/agents')}>
          Agents page
        </button>
      </header>
      {fault && <p className="acard__fault">{fault}</p>}
      <ul className="acard__list" ref={list}>
        {agents.map((a) => {
          const k = agentKey(a)
          const where = [a.project?.name, sourceLabel(poll.data, a)].filter(Boolean).join(' · ')
          const folder = a.cwd.replace(/\/+$/, '').split('/').pop() ?? ''
          const place = [where, folder && folder !== a.project?.name ? folder : ''].filter(Boolean).join(' · ') || 'no project'
          const next = a.queued?.[0]
          const state = a.status === 'working' ? (since[k] ? working(now - since[k]) : 'working') : STATE_WORDS[a.status]
          const lamp = a.status === 'blocked' ? ' row__lamp--fault' : a.status === 'working' ? ' acard__lamp--working' : a.status === 'done' ? ' row__lamp--done' : ''
          return (
            <li key={k}>
              <button type="button" className={`acard__agent${a.status === 'blocked' ? ' is-blocked' : ''}`} onClick={() => open(agentHref(a))}>
                <span className="acard__top">
                  <span className={`row__lamp${lamp}`} aria-hidden="true" />
                  <span className="acard__name">{a.name || a.kind}</span>
                  <span className="acard__kind">{a.kind}</span>
                  <span className="acard__state">{state}</span>
                </span>
                {(doing(a) || a.status === 'working') && <span className="acard__doing">{doing(a) || 'working'}</span>}
                <span className="acard__where">{place}</span>
                {next && (
                  <span className="acard__where">
                    next: {next.title}
                    {next.asking ? ' (waits for your go)' : ''}
                    {a.queued!.length > 1 ? ` (+${a.queued!.length - 1} queued)` : ''}
                  </span>
                )}
                {SCREENED.includes(a.status) && screens[k] && <span className="acard__screen">{screens[k]}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      <footer className="acard__foot">
        <button type="button" className="acard__link" onClick={() => open('#/')}>
          Open Marumado
        </button>
      </footer>
    </main>
  )
}
