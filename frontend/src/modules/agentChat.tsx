import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Markdown } from '../components/Markdown'
import { sourceOf, sourceQuery } from '../lib/agents'
import { api } from '../lib/api'
import { Icon } from '../components/Icon'
import { bare, meterOf, readFooter, readLive, readQuestion } from '../lib/liveScreen'
import { Secret } from '../lib/streaming'
import type { Agent, AgentTrace, TraceStep } from '../lib/types'
import { choices, tail } from './agentInbox'
import { span } from './trace'
import './agentChat.css'

/** An agent's session as a chat, beside its live terminal, the way Claude Code reads on the web: what you and it
    wrote, set as text, every tool it called in the flow (a command with its output, an edit with its diff, its todo
    list), the screenshots and pictures where they came, and a chat box to write to it.

    The steps come from its session record (GET agents/<pane>/trace), which it writes a block at a time. What it is
    doing right now comes from its screen (GET agents/<pane>/output): the status line, the reply it is still writing,
    and, when it waits on you, the question with its choices as buttons. */

const FIRST = 400 // steps read at first: the end of a long session

type Loaded = { trace: AgentTrace | null; steps: TraceStep[]; error: string }

function useConversation(paneId: string, source: number, every: number) {
  const [state, setState] = useState<Loaded>({ trace: null, steps: [], error: '' })
  const have = useRef<{ path: string; steps: TraceStep[] }>({ path: '', steps: [] })
  const base = `agents/${encodeURIComponent(paneId)}/trace?${sourceQuery(source)}`
  const load = useCallback(
    async (earlier = false): Promise<void> => {
      const mine = have.current
      const from = earlier ? Math.max(0, (mine.steps[0]?.i ?? 0) - FIRST) : mine.steps.length ? mine.steps[mine.steps.length - 1].i + 1 : -FIRST
      try {
        const t = await api<AgentTrace>(`${base}&from=${from}`)
        if (t.found) {
          if (mine.path && t.path !== mine.path) {
            // Another session (cleared, or a new agent in the pane): start again from its end.
            have.current = { path: '', steps: [] }
            return load()
          }
          // The steps that may still change (a tool still running) come again: those replace ours. Nothing new keeps
          // the same list, so the conversation isn't set again on every poll.
          const kept = mine.steps.filter((x) => x.i < t.from)
          have.current = { path: t.path, steps: t.steps.length || kept.length < mine.steps.length ? [...kept, ...t.steps] : mine.steps }
        }
        setState({ trace: t, steps: have.current.steps, error: '' })
      } catch (err) {
        setState((s) => ({ ...s, error: err instanceof Error ? err.message : "Couldn't read the agent's record." }))
      }
    },
    [base],
  )
  useEffect(() => {
    load()
    const id = window.setInterval(() => document.visibilityState === 'visible' && load(), every)
    return () => window.clearInterval(id)
  }, [load, every])
  return { ...state, refresh: () => load(), earlier: () => load(true) }
}

/** How the conversation is set, remembered per browser. */
type Display = { size: 's' | 'm' | 'l'; width: 'narrow' | 'wide' | 'full'; density: 'compact' | 'roomy'; tools: 'open' | 'folded'; thinking: 'shown' | 'hidden' }
const DISPLAY: Display = { size: 'm', width: 'wide', density: 'compact', tools: 'folded', thinking: 'shown' }
const DISPLAY_KEY = 'marumado.chat-display'

function useDisplay(): [Display, (d: Display) => void] {
  const [display, setDisplay] = useState<Display>(() => {
    try {
      return { ...DISPLAY, ...JSON.parse(localStorage.getItem(DISPLAY_KEY) || '{}') }
    } catch {
      return DISPLAY
    }
  })
  const set = (d: Display) => {
    setDisplay(d)
    try {
      localStorage.setItem(DISPLAY_KEY, JSON.stringify(d))
    } catch {
      // private mode: for this visit only
    }
  }
  return [display, set]
}

const CHOICES: { key: keyof Display; label: string; options: [string, string][] }[] = [
  { key: 'size', label: 'Text', options: [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']] },
  { key: 'width', label: 'Width', options: [['narrow', 'Narrow'], ['wide', 'Wide'], ['full', 'Full']] },
  { key: 'density', label: 'Spacing', options: [['compact', 'Compact'], ['roomy', 'Roomy']] },
  { key: 'tools', label: 'Commands and edits', options: [['open', 'Shown'], ['folded', 'Folded']] },
  { key: 'thinking', label: 'Thinking', options: [['shown', 'Shown'], ['hidden', 'Hidden']] },
]

/** The Display menu: how big, how wide, how dense, and what is folded. Not modal: Escape or a click elsewhere closes it. */
function DisplayMenu({ display, onChange }: { display: Display; onChange: (d: Display) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  return (
    <div className="chat__display" ref={ref}>
      <button type="button" className="btn btn--quiet chat__display-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="sliders" size={16} /> Display
      </button>
      {open && (
        <div className="chat__display-menu" role="group" aria-label="Display">
          {CHOICES.map((c) => (
            <div className="chat__display-row" key={c.key}>
              <span className="chat__display-label">{c.label}</span>
              <div className="seg" role="group" aria-label={c.label}>
                {c.options.map(([value, label]) => (
                  <button key={value} type="button" className="seg__btn" aria-pressed={display[c.key] === value} onClick={() => onChange({ ...display, [c.key]: value })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <button type="button" className="btn btn--quiet" onClick={() => onChange(DISPLAY)}>
            Back to the defaults
          </button>
        </div>
      )}
    </div>
  )
}

/** The agent's screen: often while it works or waits on you, now and then otherwise (for its status line). */
function useScreen(paneId: string, source: number, every: number | null) {
  const [screen, setScreen] = useState('')
  const url = `agents/${encodeURIComponent(paneId)}/output?lines=80&${sourceQuery(source)}`
  const read = useCallback(async () => {
    try {
      setScreen((await api<{ output: string }>(url)).output)
    } catch {
      // the record still shows what it did; the live line just goes quiet
    }
  }, [url])
  useEffect(() => {
    if (every === null) {
      setScreen('')
      return
    }
    read()
    const id = window.setInterval(() => document.visibilityState === 'visible' && read(), every)
    return () => window.clearInterval(id)
  }, [read, every])
  return { screen, read }
}

/** The session in the order it happened: messages, and every step between, a run of three or more looks
    (reading, searching) folded into one line. */
type Item = { kind: 'you' | 'say' | 'compact'; step: TraceStep } | { kind: 'step'; step: TraceStep } | { kind: 'looks'; steps: TraceStep[] }

const looks = (s: TraceStep) => (s.kind === 'read' || s.kind === 'search') && s.ok !== false && !s.images?.length

function itemsOf(steps: TraceStep[]): Item[] {
  const out: Item[] = []
  let run: TraceStep[] = []
  const flush = () => {
    if (run.length >= 3) out.push({ kind: 'looks', steps: run })
    else out.push(...run.map((step): Item => ({ kind: 'step', step })))
    run = []
  }
  for (const s of steps) {
    if (looks(s)) {
      run.push(s)
      continue
    }
    flush()
    out.push(s.kind === 'you' || s.kind === 'say' || s.kind === 'compact' ? { kind: s.kind, step: s } : { kind: 'step', step: s })
  }
  flush()
  return out
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

type Shown = { src: string; caption: string }
/** A / command the agent takes (GET agents/<pane>/commands): its own, or one its owner added. */
type Command = { name: string; description: string; kind: 'built-in' | 'custom' | 'skill' }

function useCommands(paneId: string, source: number, kind: string) {
  const [commands, setCommands] = useState<Command[]>([])
  useEffect(() => {
    let on = true
    api<{ commands: Command[] }>(`agents/${encodeURIComponent(paneId)}/commands?${sourceQuery(source)}`)
      .then((r) => on && setCommands(r.commands || []))
      .catch(() => on && setCommands([])) // no suggestions: a / command still goes as typed
    return () => {
      on = false
    }
  }, [paneId, source, kind])
  return commands
}
type Pending = { text: string; at: number }

export function AgentConversation({ agent, control }: { agent: Agent; control: boolean }) {
  const source = sourceOf(agent)
  const paneId = agent.pane_id
  const working = agent.status === 'working'
  const asking = agent.status === 'blocked'
  const { trace, steps, error, earlier, refresh } = useConversation(paneId, source, working ? 1500 : 4000)
  const { screen, read } = useScreen(paneId, source, working ? 1200 : asking ? 2000 : 6000)
  const [display, setDisplay] = useDisplay()
  const commands = useCommands(paneId, source, agent.kind)
  const shownSteps = useMemo(() => (display.thinking === 'hidden' ? steps.filter((s) => s.kind !== 'think' || /^Updated its plan|^Wrote a plan/.test(s.title)) : steps), [steps, display.thinking])
  const items = useMemo(() => itemsOf(shownSteps), [shownSteps])
  const footer = readFooter(screen, agent.kind)
  const picks = asking ? choices(screen) : []
  const scroller = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [shown, setShown] = useState<Shown | null>(null)
  const [pending, setPending] = useState<Pending[]>([])

  // What you sent shows at once, until the record has it.
  const lastYou = [...steps].reverse().find((s) => s.kind === 'you')
  const waiting = pending.filter((p) => !(lastYou && lastYou.t >= p.at - 30000 && bare(lastYou.detail).startsWith(bare(p.text).slice(0, 40))) && Date.now() - p.at < 120000)
  // The reply it is still writing, unless the record has it already.
  const live = working ? readLive(screen, agent.kind) : { status: '', text: '' }
  const sinceYou = lastYou ? steps.filter((s) => s.i > lastYou.i && s.kind === 'say') : steps.filter((s) => s.kind === 'say').slice(-3)
  const liveText = live.text && !sinceYou.some((s) => bare(s.detail).includes(bare(live.text).slice(0, 60))) ? live.text : ''

  const toEnd = useCallback(() => {
    const el = scroller.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  }, [])
  useLayoutEffect(toEnd, [steps, liveText, live.status, waiting.length, asking, toEnd])
  const onScroll = () => {
    const el = scroller.current
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  const send = async (json: { text?: string; keys?: string[] }) => {
    await api(`agents/${encodeURIComponent(paneId)}/input?${sourceQuery(source)}`, { method: 'POST', json })
    if (json.text) {
      follow.current = true
      setPending((p) => [...p, { text: json.text!, at: Date.now() }])
    }
    window.setTimeout(() => {
      refresh()
      read()
    }, 400)
  }

  const path = trace?.found ? trace.path : ''
  const image = (id: string) => `/api/agents/${encodeURIComponent(paneId)}/image?${sourceQuery(source)}&path=${encodeURIComponent(path)}&id=${encodeURIComponent(id)}`
  const pictures = (s: TraceStep, caption = s.title) =>
    s.images?.length ? <Pictures ids={s.images} caption={caption} url={image} onOpen={setShown} onLoad={toEnd} /> : null

  let body: ReactNode
  if (!trace) body = <p className="sheet__empty">{error || 'Reading the agent’s record…'}</p>
  else if (!trace.found && !steps.length) body = <p className="sheet__empty">{error || trace.reason}</p>
  else
    body = (
      <>
        {steps.length > 0 && steps[0].i > 0 && (
          <button type="button" className="btn btn--quiet chat__earlier" onClick={earlier}>
            Show the {plural(Math.min(steps[0].i, FIRST), 'step')} before
          </button>
        )}
        {!steps.length && !waiting.length && <p className="sheet__empty">Nothing in this session yet. Write to it below.</p>}
        <ol className="chat__list">
          {items.map((it) =>
            it.kind === 'you' ? (
              <li key={it.step.i} className="chat__msg chat__msg--you">
                <Secret label="Message">
                  <p className="chat__text">{it.step.detail || it.step.title}</p>
                </Secret>
                {pictures(it.step, 'You sent')}
                <time className="chat__at">{clock(it.step.t)}</time>
              </li>
            ) : it.kind === 'say' ? (
              <li key={it.step.i} className="chat__msg chat__msg--say">
                <Secret label="Message">
                  <Markdown text={it.step.detail || it.step.title} />
                </Secret>
                {pictures(it.step)}
              </li>
            ) : it.kind === 'compact' ? (
              <li key={it.step.i} className="chat__compact">
                <details>
                  <summary>
                    <span>{it.step.title}</span>
                    <time>{clock(it.step.t)}</time>
                  </summary>
                  <Secret label="Summary">
                    <Markdown text={it.step.detail || 'No summary written.'} />
                  </Secret>
                </details>
              </li>
            ) : it.kind === 'looks' ? (
              <Looks key={`l${it.steps[0].i}`} steps={it.steps} />
            ) : (
              <li key={it.step.i} className="chat__tool-item">
                <ToolCall s={it.step} live={working} open={display.tools === 'open'} />
                {pictures(it.step)}
              </li>
            ),
          )}
          {waiting.map((p) => (
            <li key={p.at} className="chat__msg chat__msg--you chat__msg--sending">
              <p className="chat__text">{p.text}</p>
              <span className="chat__at">Sent</span>
            </li>
          ))}
          {liveText && (
            <li className="chat__msg chat__msg--say chat__msg--live">
              <Secret label="Message">
                <p className="chat__text">{liveText}</p>
              </Secret>
            </li>
          )}
          {working && (
            <li>
              <Working status={live.status} />
            </li>
          )}
        </ol>
      </>
    )

  return (
    <div className="chat" data-size={display.size} data-width={display.width} data-density={display.density}>
      <div className="chat__bar">
        {trace?.found && trace.sure === false && (
          <p className="chat__note">
            {trace.shared} {trace.kind} agents work in this folder and this one’s session can’t be told apart yet: this may be another one’s.
          </p>
        )}
        <DisplayMenu display={display} onChange={setDisplay} />
      </div>
      {error && trace && <p className="notice signal-text">{error}</p>}
      <div className="chat__scroll" ref={scroller} onScroll={onScroll}>
        {body}
      </div>
      {asking && <Prompt screen={screen} control={control} send={send} />}
      {!control && <StatusLine footer={footer} control={false} send={send} />}
      {control ? (
        <ChatBox key={paneId} draftKey={`marumado.chat-draft.${source}.${paneId}`} working={working} asking={asking} locked={asking && picks.length > 0} commands={commands} send={send} footer={<StatusLine footer={footer} control={control} send={send} />} />
      ) : (
        <p className="chat__note">Watching only (MARUMADO_HERDR_TERMINAL=observe): write to it in its terminal.</p>
      )}
      {shown && <Lightbox shown={shown} onClose={() => setShown(null)} />}
    </div>
  )
}

/** What it is doing right now, from its status line ("Herding… (1m 57s · ↓ 10.1k tokens)"). */
function Working({ status }: { status: string }) {
  const m = status.match(/^(.*?…)\s*\((.*)\)$/)
  return (
    <p className="chat__working" role="status">
      <span className="chat__pulse" aria-hidden="true" />
      <span>{m ? m[1] : status || 'Working…'}</span>
      {m && <span className="chat__working-meta">{m[2]}</span>}
    </p>
  )
}

/** What a question says, cut the way Claude Code lays one out: what it is about ("Bash command"), what it would do
    (the command, the edit), then what it asks ("Do you want to proceed?"). Whatever doesn't fit is the body. */
function partsOf(asked: string): { topic: string; body: string; ask: string } {
  const lines = asked.split('\n')
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  const ask = lines.length > 1 && /\?\s*$/.test(lines[lines.length - 1]) ? lines.pop()!.trim() : ''
  const topic = lines.length > 2 && /^\S/.test(lines[0]) && (!lines[1].trim() || /^\s/.test(lines[1])) ? lines.shift()!.trim() : ''
  const rest = lines.join('\n').replace(/^\n+|\s+$/g, '')
  const indent = Math.min(...rest.split('\n').filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length))
  const body = rest.split('\n').map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n')
  return { topic, body, ask }
}

const editable = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

/** When it waits on you: what it asks, set out (what it is about, what it would do, the question), and its choices
    as a menu you click or pick by number, as in the terminal. Docked over the chat box, so it stays in sight. */
function Prompt({ screen, control, send }: { screen: string; control: boolean; send: (json: { keys: string[] }) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const picks = choices(screen)
  const asked = picks.length ? readQuestion(screen) : ''
  const { topic, body, ask } = partsOf(asked)
  // What you picked, until the question changes or goes: one answer per question, no double sends.
  const [sent, setSent] = useState<{ for: string; label: string } | null>(null)
  const shape = `${asked}|${picks.map((c) => c.text).join('|')}`
  const answered = sent && sent.for === shape ? sent.label : ''
  const press = useCallback(
    async (key: string, label: string) => {
      setBusy(true)
      setError('')
      try {
        await send({ keys: [key] })
        setSent({ for: shape, label })
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't reach the agent.")
      } finally {
        setBusy(false)
      }
    },
    [send, shape],
  )
  // 1–9 pick a choice, as in its terminal, unless you are typing somewhere.
  useEffect(() => {
    if (!control || !picks.length || answered) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || editable(e.target) || busy) return
      const c = picks.find((p) => p.key === e.key)
      if (!c) return
      e.preventDefault()
      press(c.key, c.text)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [control, picks, answered, busy, press])
  const label = (text: string) => text.replace(/\s*\((?:esc|tab|shift\+tab)\)\s*$/i, '')
  return (
    <section className="chat__ask" aria-label="It waits on you" aria-live="polite">
      <header className="chat__ask-head">
        <span className="row__lamp row__lamp--fault" aria-hidden="true" />
        <span className="chat__ask-topic">{topic || 'It waits on you'}</span>
        {control && picks.length > 1 && !answered && <span className="chat__ask-keys">Press 1–{picks.length}</span>}
      </header>
      {picks.length ? (
        <Secret label="Question">
          {body && <pre className="chat__ask-body">{body}</pre>}
          {ask && <p className="chat__ask-q">{ask}</p>}
        </Secret>
      ) : (
        <Secret label="Its screen">
          <pre className="chat__ask-body">{screen ? tail(screen, 10) : 'Reading its screen…'}</pre>
        </Secret>
      )}
      {answered ? (
        <p className="chat__ask-sent" role="status">
          Sent <strong>{label(answered)}</strong>. Waiting for it to go on…
        </p>
      ) : (
        control && (
          <div className="chat__ask-choices" role="group" aria-label="Answer">
            {picks.map((c) => (
              <button key={c.key} type="button" className={`chat__ask-choice${c.current ? ' is-current' : ''}`} disabled={busy} onClick={() => press(c.key, c.text)}>
                <kbd>{c.key}</kbd>
                <span>{label(c.text)}</span>
              </button>
            ))}
            {!picks.length && (
              <button type="button" className="chat__ask-choice is-current" disabled={busy} onClick={() => press('enter', 'Enter')}>
                <kbd>↵</kbd>
                <span>Enter</span>
              </button>
            )}
            <button type="button" className="chat__ask-cancel" disabled={busy} onClick={() => press('esc', 'Esc')} title="Cancel, as Esc does in its terminal">
              Esc to cancel
            </button>
          </div>
        )
      )}
      {!control && <p className="chat__note">Watching only: answer in its terminal.</p>}
      {error && <p className="signal-text">{error}</p>}
    </section>
  )
}

/** Claude Code's status line, from under its input box: the model, its usage as small meters, tokens and cost, and
    its mode, which a click moves on (Shift+Tab, as in the terminal). */
function StatusLine({ footer, control, send }: { footer: { parts: string[]; mode: string }; control: boolean; send: (json: { keys: string[] }) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  if (!footer.parts.length && !footer.mode) return <span className="chat__status" />
  const cycle = async () => {
    setBusy(true)
    try {
      await send({ keys: ['shift+tab'] })
    } catch {
      // the next read of its screen says which mode it is in
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="chat__status" aria-label="Status line">
      {footer.mode &&
        (control ? (
          <button type="button" className="chat__mode" disabled={busy} onClick={cycle} title="Switch its mode (Shift+Tab)">
            {footer.mode}
          </button>
        ) : (
          <span className="chat__mode">{footer.mode}</span>
        ))}
      {footer.parts.map((p, i) => {
        const m = meterOf(p)
        return (
          <span key={i} className="chat__stat">
            {m ? (
              <>
                {m.label}
                <span className="chat__meter" role="img" aria-label={`${m.share}% used`}>
                  <span style={{ width: `${m.share}%` }} />
                </span>
                {m.text}
                {m.rest && <span className="chat__stat-rest">{m.rest}</span>}
              </>
            ) : (
              p
            )}
          </span>
        )
      })}
    </span>
  )
}

/** Write to it: Enter sends, Shift+Enter starts a new line. While it works, Stop interrupts it (Esc). */
/** The / commands that fit what is typed (`/` and no space yet), those starting with it first. */
function suggest(commands: Command[], text: string): Command[] {
  if (!/^\/\S*$/.test(text)) return []
  const typed = text.slice(1).toLowerCase()
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(typed))
  const within = commands.filter((c) => !c.name.toLowerCase().startsWith(typed) && c.name.toLowerCase().includes(typed))
  return [...starts, ...within].slice(0, 8)
}

function ChatBox({ draftKey, working, asking, locked, commands, send, footer }: { draftKey: string; working: boolean; asking: boolean; locked: boolean; commands: Command[]; send: (json: { text?: string; keys?: string[] }) => Promise<void>; footer: ReactNode }) {
  // What you were writing stays, per agent, when you leave the page and come back (until it is sent).
  const [text, setTextState] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? ''
    } catch {
      return ''
    }
  })
  const setText = (value: string) => {
    setTextState(value)
    try {
      if (value) localStorage.setItem(draftKey, value)
      else localStorage.removeItem(draftKey)
    } catch {
      // private mode: the draft lasts as long as the page
    }
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])
  const go = async (json: { text?: string; keys?: string[] }) => {
    setBusy(true)
    setError('')
    try {
      await send(json)
      if (json.text) setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach the agent.")
    } finally {
      setBusy(false)
      box.current?.focus()
    }
  }
  // While a menu is up, what you type would go into it (a digit picks a choice): answer it first.
  const submit = (value = text) => value.trim() && !busy && !locked && go({ text: value })
  // The / commands as you type one: Enter runs the one picked (as the agent's own menu does), Tab or a click puts
  // it in the box to add what it takes, Escape puts the menu away.
  const [pick, setPick] = useState(0)
  const [dismissed, setDismissed] = useState('')
  const matches = text === dismissed ? [] : suggest(commands, text)
  const picked = matches[Math.min(pick, matches.length - 1)]
  useEffect(() => setPick(0), [text])
  const complete = (c: Command) => {
    setText(`/${c.name} `)
    box.current?.focus()
  }
  return (
    <form
      className="chat__box"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <label className="sr-only" htmlFor="chat-text">
        Write to the agent
      </label>
      {matches.length > 0 && (
        <ul id="chat-commands" className="chat__commands" role="listbox" aria-label="Commands">
          {matches.map((c) => (
            <li
              key={c.name}
              id={`chat-command-${c.name}`}
              role="option"
              aria-selected={c === picked}
              className="chat__command"
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setPick(matches.indexOf(c))}
              onClick={() => complete(c)}
            >
              <span className="chat__command-name">/{c.name}</span>
              {c.kind !== 'built-in' && <span className="chat__command-kind">{c.kind === 'skill' ? 'skill' : 'yours'}</span>}
              <span className="chat__command-about">{c.description}</span>
            </li>
          ))}
          <li className="chat__commands-keys" aria-hidden="true">
            Enter runs it · Tab to add arguments · Esc
          </li>
        </ul>
      )}
      <textarea
        id="chat-text"
        ref={box}
        className="chat__input"
        rows={1}
        value={text}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={matches.length > 0}
        aria-controls="chat-commands"
        aria-activedescendant={picked ? `chat-command-${picked.name}` : undefined}
        placeholder={locked ? 'Answer its question above first; you can write here meanwhile' : asking ? 'It waits on you: answer above, or write here' : working ? 'Write to it: it reads this once it is done' : 'Write to the agent… (Enter sends, Shift+Enter for a new line)'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (picked && !e.nativeEvent.isComposing) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setPick((pick + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
              return
            }
            if (e.key === 'Tab') {
              e.preventDefault()
              complete(picked)
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation() // the menu, not the sheet around it
              setDismissed(text)
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit(`/${picked.name}`)
              return
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="chat__box-actions">
        {footer}
        {working && (
          <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => go({ keys: ['esc'] })} title="Interrupt it (Esc)">
            Stop
          </button>
        )}
        <button type="submit" className="btn" disabled={busy || locked || !text.trim()}>
          Send
        </button>
      </div>
      {error && <p className="signal-text chat__error">{error}</p>}
    </form>
  )
}

/** A run of looking around, folded: "Read 6 files, searched twice". */
function Looks({ steps }: { steps: TraceStep[] }) {
  const reads = steps.filter((s) => s.kind === 'read').length
  const searches = steps.length - reads
  const title = [reads && `Read ${plural(reads, 'file')}`, searches && `searched ${plural(searches, 'time')}`].filter(Boolean).join(', ')
  return (
    <li className="chat__tool-item">
      <details className="tool-call">
        <summary className="tool-call__line">
          <span className="tool-call__mark tool-call__mark--read" aria-hidden="true" />
          <span className="tool-call__title">{title.replace(/^s/, 'S')}</span>
        </summary>
        <ul className="tool-call__list">
          {steps.map((s) => (
            <li key={s.i}>
              <Secret label="Path">{s.title}</Secret>
            </li>
          ))}
        </ul>
      </details>
    </li>
  )
}

const MARK: Record<string, string> = { read: 'read', search: 'read', edit: 'edit', run: 'run', agent: 'run', tool: 'run', think: 'think', ask: 'ask', you: 'run', say: 'think' }

/** One tool call, as Claude Code shows it: a line saying what it did, and what came back under it. */
function ToolCall({ s, live, open }: { s: TraceStep; live: boolean; open: boolean }) {
  const running = s.end === null && live
  const took = s.end !== null && s.end - s.t >= 1000 ? span(s.end - s.t) : ''
  const state = (
    <span className="tool-call__state">
      {running ? <span className="chat__pulse" aria-label="running" /> : s.ok === false ? <span className="rstep__failed">failed</span> : null}
      {took}
    </span>
  )
  const mark = <span className={`tool-call__mark tool-call__mark--${MARK[s.kind]}`} aria-hidden="true" />

  if (s.kind === 'run') {
    const cut = s.cut ?? s.detail.length
    const command = s.detail.slice(0, cut).replace(/^\$ /, '').trim()
    const out = s.detail.slice(cut).trim()
    return (
      <details className={`tool-call tool-call--card${s.ok === false ? ' is-failed' : ''}`} open={open}>
        <summary className="tool-call__line">
          {mark}
          <span className={`tool-call__title${s.sub ? '' : ' tool-call__title--mono'}`}>
            {s.sub ? s.title : <Secret label="Command">{command.split('\n')[0]}</Secret>}
          </span>
          {state}
        </summary>
        <Secret label="Command">
          <Clipped text={`$ ${command}`} lines={6} className="tool-call__command" />
          {out && <Clipped text={out} lines={8} className="tool-call__out" />}
        </Secret>
      </details>
    )
  }
  if (s.kind === 'edit') {
    const changed = s.files?.filter((f) => f.add !== undefined) ?? []
    return (
      <details className={`tool-call tool-call--card${s.ok === false ? ' is-failed' : ''}`} open={open && Boolean(s.detail)}>
        <summary className="tool-call__line">
          {mark}
          <span className="tool-call__title">
            <Secret label="Path">{s.title}</Secret>
          </span>
          {changed.length > 0 && (
            <span className="tool-call__diffstat">
              <span className="diff-add">+{changed.reduce((n, f) => n + (f.add ?? 0), 0)}</span> <span className="diff-del">−{changed.reduce((n, f) => n + (f.del ?? 0), 0)}</span>
            </span>
          )}
          {state}
        </summary>
        {s.detail && (
          <Secret label="Diff">
            <Clipped text={s.detail} lines={14} className="tool-call__diff" diff />
          </Secret>
        )}
      </details>
    )
  }
  if (s.kind === 'think' && /^Updated its plan/.test(s.title)) {
    return (
      <div className="tool-call tool-call--card">
        <div className="tool-call__line">
          {mark}
          <span className="tool-call__title">{s.title.replace('Updated its plan', 'Todo list')}</span>
        </div>
        <ul className="tool-call__todos">
          {s.detail
            .split('\n')
            .filter((l) => /^\[[ x>]\]/.test(l))
            .map((l, n) => (
              <li key={n} className={`todo todo--${l[1] === 'x' ? 'done' : l[1] === '>' ? 'now' : 'next'}`}>
                <span className="todo__box" role="img" aria-label={l[1] === 'x' ? 'done' : l[1] === '>' ? 'in progress' : 'to do'} />
                <Secret label="Todo">{l.slice(4)}</Secret>
              </li>
            ))}
        </ul>
      </div>
    )
  }
  if (s.kind === 'think' && s.title === 'Wrote a plan') {
    return (
      <details className="tool-call tool-call--card" open={open}>
        <summary className="tool-call__line">
          {mark}
          <span className="tool-call__title">Plan</span>
        </summary>
        <div className="tool-call__plan">
          <Secret label="Plan">
            <Markdown text={s.detail} />
          </Secret>
        </div>
      </details>
    )
  }
  if (s.kind === 'ask') {
    return (
      <div className="tool-call tool-call--card tool-call--ask">
        <div className="tool-call__line">
          {mark}
          <span className="tool-call__title">Asked you</span>
          {state}
        </div>
        <Secret label="Question">
          <p className="chat__text tool-call__asked">{s.detail || s.title}</p>
        </Secret>
      </div>
    )
  }
  // Thinking, a sub-agent, a search, any other tool: one line, what it says folded under it.
  const title = s.kind === 'think' ? (s.end !== null && s.end - s.t >= 1000 ? `Thought for ${span(s.end - s.t)}` : 'Thought') : s.title
  const more = s.kind === 'think' ? s.detail : s.detail && s.detail !== s.title ? s.detail : ''
  const line = (
    <>
      {mark}
      <span className="tool-call__title">
        <Secret label="Step">{title}</Secret>
      </span>
      {s.kind !== 'think' && state}
    </>
  )
  if (!more)
    return (
      <div className={`tool-call${s.ok === false ? ' is-failed' : ''}`}>
        <div className="tool-call__line">{line}</div>
      </div>
    )
  return (
    <details className={`tool-call${s.ok === false ? ' is-failed' : ''}`}>
      <summary className="tool-call__line">{line}</summary>
      <Secret label="Step">
        {s.kind === 'think' || s.kind === 'agent' ? (
          <div className="tool-call__thought">
            <Markdown text={more} />
          </div>
        ) : (
          <pre className="tool-call__out">{more}</pre>
        )}
      </Secret>
    </details>
  )
}

/** A long output or diff, its first lines and a button for the rest. */
function Clipped({ text, lines, className, diff = false }: { text: string; lines: number; className: string; diff?: boolean }) {
  const [all, setAll] = useState(false)
  const rows = text.split('\n')
  const shown = all ? rows : rows.slice(0, lines)
  return (
    <>
      <pre className={className}>
        {diff
          ? shown.map((l, i) => (
              <span key={i} className={l.startsWith('@@') ? 'diff-hunk' : l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-del' : undefined}>
                {l}
                {'\n'}
              </span>
            ))
          : shown.join('\n')}
      </pre>
      {rows.length > lines && (
        <button type="button" className="tool-call__more" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${rows.length} lines`}
        </button>
      )}
    </>
  )
}

function Pictures({ ids, caption, url, onOpen, onLoad }: { ids: string[]; caption: string; url: (id: string) => string; onOpen: (s: Shown) => void; onLoad: () => void }) {
  return (
    <Secret label="Image">
      <div className="chat__pics">
        {ids.map((id) => (
          <figure className="chat__pic" key={id}>
            <button type="button" className="chat__pic-open" onClick={() => onOpen({ src: url(id), caption })} title="Open it full size">
              <img src={url(id)} alt={caption} loading="lazy" onLoad={onLoad} />
            </button>
          </figure>
        ))}
      </div>
    </Secret>
  )
}

function Lightbox({ shown, onClose }: { shown: Shown; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog className="chat__lightbox" ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && ref.current.close()} aria-label={shown.caption}>
      <img src={shown.src} alt={shown.caption} />
      <p className="chat__lightbox-foot">
        <span>{shown.caption}</span>
        <a className="btn btn--quiet" href={shown.src} target="_blank" rel="noreferrer">
          Open in a tab
        </a>
        <button type="button" className="btn btn--quiet" onClick={() => ref.current?.close()}>
          Close
        </button>
      </p>
    </dialog>
  )
}
