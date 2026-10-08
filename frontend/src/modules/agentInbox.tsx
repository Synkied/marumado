import { useEffect, useRef, useState } from 'react'
import { agentHref, agentKey, sourceLabel, sourceOf, sourceQuery } from '../lib/agents'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { useHub } from '../lib/hub'
import { inDesktop } from '../lib/desktop'
import { canNotify, useNotifyPreference } from '../lib/notify'
import type { Agent } from '../lib/types'
import { usePoll } from '../lib/usePoll'

/** A numbered choice on an agent's screen ("❯ 1. Yes"): the key that picks it, and what it says. */
type Choice = { key: string; text: string; current: boolean }

const CHOICE = /^\s*(?:│\s*)?([❯›>▶→]\s*)?(\d)[.)]\s+(.{1,90}?)\s*(?:│\s*)?$/

/** The choices of the question at the bottom of the screen: the last run of numbered lines, counting up from 1, one of them marked. */
export function choices(screen: string): Choice[] {
  const lines = screen.split('\n').slice(-30)
  let run: Choice[] = []
  let best: Choice[] = []
  for (const line of lines) {
    const m = line.match(CHOICE)
    if (m && Number(m[2]) === run.length + 1) {
      run.push({ key: m[2], text: m[3], current: Boolean(m[1]) })
      // A menu marks the choice it is on; a numbered list in the agent's answer doesn't.
      if (run.length >= 2 && run.some((c) => c.current)) best = run
    } else if (m && m[2] === '1') {
      run = [{ key: '1', text: m[3], current: Boolean(m[1]) }]
    } else if (line.trim() && !m && run.length && !/^\s*(?:│\s*)?\s{2,}\S/.test(line)) {
      // A line that isn't a choice (nor a choice's wrapped tail) ends the run.
      run = []
    }
  }
  return best
}

/** The end of the screen, where the question is: the last lines that say something. */
export const tail = (screen: string, n = 16) => screen.replace(/\s+$/, '').split('\n').slice(-n).join('\n')

const KEYS: [string, string][] = [
  ['enter', 'Enter'],
  ['esc', 'Esc'],
  ['up', '↑'],
  ['down', '↓'],
  ['tab', 'Tab'],
]

/** One agent waiting on you: what its screen asks, and the keys to answer without opening its terminal. `head` false
    leaves out its name and link, for a place that already shows them (the agent dock's card). */
export function Question({ agent: a, control, head = true, onAnswered, focused = false }: { agent: Agent; control: boolean; head?: boolean; onAnswered?: (agent: Agent) => void; focused?: boolean }) {
  const { agents, refreshAgents } = useHub()
  const source = sourceOf(a)
  const out = usePoll<{ output: string }>(`agents/${encodeURIComponent(a.pane_id)}/output?lines=60&${sourceQuery(source)}`, 3000)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState('')
  const article = useRef<HTMLElement>(null)
  useEffect(() => {
    if (focused) {
      article.current?.focus()
    }
  }, [focused])
  const current = agents?.available ? agents.agents.find((other) => agentKey(other) === agentKey(a)) : undefined
  const resumed = Boolean(sent && current && current.status !== 'blocked' && current.status !== 'unknown')
  const receiptTitle = !resumed ? 'Response sent' : current?.status === 'working' ? 'Agent resumed' : current?.status === 'done' ? 'Agent finished its turn' : 'Agent is idle at its prompt'
  const canAnswer = control && !resumed && Boolean(out.data) && !out.error
  const screen = out.data?.output ?? ''
  const picks = choices(screen)
  const press = async (key: string, label: string) => {
    if (busy || !canAnswer) return
    setBusy(true)
    setError('')
    try {
      await api(`agents/${encodeURIComponent(a.pane_id)}/input?${sourceQuery(source)}`, { method: 'POST', json: { keys: [key] } })
      setSent(label)
      onAnswered?.(a)
      await Promise.all([out.refresh(), refreshAgents()])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach the agent.")
    } finally {
      setBusy(false)
    }
  }
  const on = sourceLabel(agents, a)
  return (
    <article ref={article} tabIndex={focused ? -1 : undefined} className={`question${focused ? ' question--focused' : ''}`} aria-labelledby={head ? `q-${agentKey(a)}` : undefined} aria-label={head ? undefined : 'Its question'}>
      {head && <header className="question__head">
        <span className={`row__lamp${resumed ? "" : " row__lamp--fault"}`} aria-hidden="true" />
        <h3 className="question__title" id={`q-${agentKey(a)}`}>
          {a.title && a.title !== a.kind ? a.title : a.name || a.kind}
        </h3>
        <span className="question__where">
          {a.name ? `${a.name} · ` : ''}
          {a.kind}
          {a.project && <> · <a href={`#/m/projects/${a.project.id}`}>{a.project.name}</a></>}
          {on ? ` on ${on}` : ''}
        </span>
        <a className="agent-fit question__open" href={agentHref(a)}>
          Open terminal
        </a>
      </header>}
      <p className="question__guidance">{resumed ? 'Your response was sent. The latest agent state is shown below.' : control ? 'Review the question below, then choose a response. For more context, open the terminal.' : 'This connection is read-only. Answer in the agent’s terminal outside Marumado.'}</p>
      {sent && (
        <p className="question__receipt" role="status">
          <strong>{receiptTitle}</strong>
          <span>{sent}{!resumed ? ' · Waiting for the agent’s next state. If it still needs you, check its screen below.' : ''}</span>
        </p>
      )}
      <pre className="logs question__screen">{out.error ? `Couldn't read its screen: ${out.error.message}` : out.data ? tail(screen) || 'Nothing on its screen.' : 'Reading its screen…'}</pre>
      {control && !resumed && picks.length > 0 && (
        <div className="question__choices" role="group" aria-label="Answer">
          {picks.map((c) => (
            <button key={c.key} className={`btn${c.current ? '' : ' btn--quiet'} question__choice`} type="button" disabled={busy || !canAnswer} onClick={() => press(c.key, c.text)}>
              <kbd>{c.key}</kbd> {c.text}
            </button>
          ))}
        </div>
      )}
      {control && !resumed && (
        <div className="composer__keys" role="group" aria-label="Terminal keys">
          {KEYS.map(([key, text]) => (
            <button key={key} className="composer__key" type="button" disabled={busy || !canAnswer} onClick={() => press(key, `${text} key`)}>
              {text}
            </button>
          ))}
        </div>
      )}
      {busy && <p className="question__guidance" role="status">Sending response…</p>}
      {error && <p role="alert" className="signal-text question__error">{error}</p>}
    </article>
  )
}

/** Whether this browser calls you back when an agent starts waiting on you or finishes. */
export function NotifyToggle() {
  const [on, set] = useNotifyPreference()
  if (inDesktop)
    return <p className="agent-hint">The desktop app notifies you when an agent starts waiting on you or finishes its turn (<em>Notify me</em> in its tray menu).</p>
  if (!canNotify())
    return <p className="agent-hint">Notifications need HTTPS or localhost; the tab&rsquo;s title still counts who needs you.</p>
  const denied = Notification.permission === 'denied'
  return (
    <p className="agent-hint">
      <button type="button" className="agent-fit agent-fit--icon" aria-pressed={on} disabled={denied} onClick={() => set(!on)}>
        <Icon name="bell" size={16} />
        Notify me
      </button>{' '}
      {denied
        ? 'This browser blocks notifications from Marumado: allow them in its site settings.'
        : 'When an agent starts waiting on you or finishes, while you are in another tab or window.'}
    </p>
  )
}
