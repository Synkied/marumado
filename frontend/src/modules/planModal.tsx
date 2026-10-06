import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Icon } from '../components/Icon'
import { agentKey, sourceOf } from '../lib/agents'
import { api } from '../lib/api'
import { useHub } from '../lib/hub'
import type { Agent, Plan } from '../lib/types'
import { usePoll } from '../lib/usePoll'
import { GoButton, NewPlan, PlanNav, PlanPage, PlansList, type PlanPlace } from './plans'

/* The plans, over the Agents page: queue what an agent does next without leaving its terminal, and lay out or follow
   any plan. The plans' own pages (plans.tsx) open in here, through PlanNav, instead of under Tasks. */

type Place = 'agent' | PlanPlace

const ASK_KEY = 'marumado.queue.ask'

function rememberedAsk(): boolean {
  try {
    return localStorage.getItem(ASK_KEY) === 'on'
  } catch {
    return false
  }
}

function rememberAsk(on: boolean) {
  try {
    localStorage.setItem(ASK_KEY, on ? 'on' : 'off')
  } catch {
    // private mode: for this visit only
  }
}

const nameOf = (a: Agent) => a.name || a.kind

export function PlansModal({ agent, onClose }: { agent: Agent | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [place, setPlace] = useState<Place>(agent ? 'agent' : 'list')
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  // A new place starts at its top.
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    body.current?.scrollTo({ top: 0 })
  }, [place])

  const onPlans = place !== 'agent'
  const inPlan = place === 'new' || typeof place === 'object'
  return (
    <dialog
      ref={dialog}
      className="pmodal"
      aria-labelledby="pmodal-title"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => e.target === dialog.current && onClose()}
    >
      <header className="pmodal__head">
        <h2 className="sr-only" id="pmodal-title">
          {agent && !onPlans ? `Queue for ${nameOf(agent)}` : 'Plans'}
        </h2>
        {inPlan && (
          <button className="side__back pmodal__back" type="button" onClick={() => setPlace('list')}>
            <Icon name="back" size={18} /> All plans
          </button>
        )}
        <div className="seg pmodal__tabs" role="group" aria-label="Show">
          {agent && (
            <button type="button" className="seg__btn" aria-pressed={!onPlans} onClick={() => setPlace('agent')}>
              Next for {nameOf(agent)}
            </button>
          )}
          <button type="button" className="seg__btn" aria-pressed={onPlans} onClick={() => setPlace('list')}>
            Plans
          </button>
        </div>
        <button className="tool" type="button" onClick={onClose} aria-label="Close">
          <Icon name="close" size={18} />
        </button>
      </header>
      <div className="pmodal__body" ref={body}>
        <PlanNav.Provider value={setPlace}>
          {place === 'agent' && agent ? (
            <AgentQueue agent={agent} open={(id) => setPlace({ plan: id })} />
          ) : place === 'new' ? (
            <NewPlan />
          ) : typeof place === 'object' ? (
            <PlanPage id={String(place.plan)} key={place.plan} />
          ) : (
            <PlansList />
          )}
        </PlanNav.Provider>
      </div>
    </dialog>
  )
}

/** What the agent does next: a step to queue on it, and what is queued already, in the order it will take them. */
function AgentQueue({ agent, open }: { agent: Agent; open: (plan: number) => void }) {
  const { agents, refreshAgents, refreshTasks } = useHub()
  // The listing is polled: the newest of this agent, for its state and its queue.
  const a = agents?.agents.find((x) => agentKey(x) === agentKey(agent)) ?? agent
  const plans = usePoll<Plan[]>('plans', 4000)
  const own = (plans.data ?? []).find((p) => p.pane_id === a.pane_id && p.pane_source === sourceOf(a))
  const stuck = own?.steps.filter((t) => t.state === 'failed' || t.state === 'blocked') ?? []
  const control = (agents?.terminal ?? 'control') === 'control'
  const [text, setText] = useState('')
  const [ask, setAsk] = useState(rememberedAsk)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const queued = a.queued ?? []
  const gone = !!agents && !agents.agents.some((x) => agentKey(x) === agentKey(agent))

  const queue = async (e?: FormEvent) => {
    e?.preventDefault()
    // All of it is the prompt; its first line names the step.
    if (!text.trim()) return
    setBusy(true)
    setError('')
    try {
      await api(`agents/${encodeURIComponent(a.pane_id)}/queue`, {
        method: 'POST',
        json: { prompt: text.trim(), ask, source: sourceOf(a) },
      })
      setText('')
      refreshAgents()
      refreshTasks()
      plans.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't queue it.")
    } finally {
      setBusy(false)
    }
  }

  const when =
    a.status === 'working'
      ? `${nameOf(a)} is working: it starts once this turn is over`
      : a.status === 'blocked'
        ? `${nameOf(a)} is waiting on you: it starts once you've answered and the turn is over`
        : `${nameOf(a)} is free: it starts right away`

  return (
    <div className="pqueue">
      <form className="pqueue__form" onSubmit={queue}>
        <label className="field">
          What should {nameOf(a)} do next?
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) queue()
            }}
            placeholder={'Write it as you’d tell the agent. Its first line names the step; all of it goes to the agent.'}
            rows={4}
            maxLength={8000}
            autoFocus
            disabled={!control || gone}
          />
        </label>
        <div className="pqueue__bar">
          <label className="field field--check">
            <input
              type="checkbox"
              checked={ask}
              onChange={(e) => {
                setAsk(e.target.checked)
                rememberAsk(e.target.checked)
              }}
            />
            Ask me before it starts
          </label>
          <button className="btn" type="submit" disabled={!text.trim() || busy || !control || gone}>
            <Icon name="plus" size={16} /> Queue it
          </button>
        </div>
        <p className="pqueue__when">
          {!control
            ? 'Giving tasks to agents is turned off here (MARUMADO_HERDR_TERMINAL).'
            : gone
              ? 'This agent was closed.'
              : `${queued.length ? `After the ${queued.length === 1 ? 'step' : `${queued.length} steps`} below. ` : ''}${when}${ask ? ', once you say go' : ''}.`}
        </p>
        {error && <p className="notice signal-text">{error}</p>}
      </form>

      {stuck.map((t) => (
        <p className="notice notice--fault" key={t.id}>
          <strong>“{t.title}” {t.state === 'failed' ? 'failed' : 'is waiting on you'}.</strong>{' '}
          {t.state === 'failed' ? 'What is queued after it waits until you move it back to To do (it runs again) or mark it done.' : 'Answer it in the terminal.'}{' '}
          <a href={`#/m/tasks/${t.id}`}>Open the step</a>.
        </p>
      ))}
      {own && !own.running && own.steps.some((t) => t.state === 'queued' || t.state === 'todo') && (
        <p className="notice">
          This queue is paused: nothing more starts.{' '}
          <button className="agent-head__link" type="button" onClick={() => open(own.id)}>
            Open it to resume
          </button>
          .
        </p>
      )}

      <section aria-labelledby="pqueue-title">
        <h3 className="pqueue__title" id="pqueue-title">
          Queued for {nameOf(a)}
        </h3>
        {queued.length ? (
          <ol className="pqueue__list">
            {queued.map((q, i) => (
              <li className={`pqueue__item${q.asking ? ' is-fault' : ''}`} key={q.id}>
                <span className="pqueue__n" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="pqueue__main">
                  <a className="pqueue__name" href={`#/m/tasks/${q.id}`}>
                    {q.title}
                  </a>
                  <span className={`pqueue__sub${q.asking ? ' signal-text' : ''}`}>
                    {q.asking ? 'its turn has come: waits for your go' : i === 0 ? 'next' : 'after the one above'}
                    {q.plan !== own?.id && (
                      <>
                        {' · '}
                        <button className="agent-head__link" type="button" onClick={() => open(q.plan)}>
                          in a plan
                        </button>
                      </>
                    )}
                  </span>
                </span>
                {q.asking && <GoButton step={q.id} title={q.title} onDone={plans.refresh} />}
              </li>
            ))}
          </ol>
        ) : (
          <p className="pqueue__empty">Nothing queued. What you queue here waits for {nameOf(a)} to finish its turn, then starts on its own, one after the other.</p>
        )}
        {own && (
          <p className="pqueue__more">
            <button className="agent-head__link" type="button" onClick={() => open(own.id)}>
              Open this queue as a plan
            </button>{' '}
            to reorder its steps, run some at the same time on other agents, or pause it.
          </p>
        )}
      </section>
    </div>
  )
}
