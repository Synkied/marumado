import { useEffect, useRef, useState } from 'react'
import { agentHref, agentKey, sourceLabel } from './agents'
import { inDesktop } from './desktop'
import { useHub } from './hub'
import { go } from './route'
import type { Agent, AgentStatus } from './types'

const KEY = 'marumado.notify'
const BASE_TITLE = document.title

/** Whether this browser can show notifications at all: they need HTTPS or localhost, not plain HTTP over the LAN. */
export const canNotify = () => 'Notification' in window && window.isSecureContext

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on'
  } catch {
    return false
  }
}

const listeners = new Set<(on: boolean) => void>()

/** Notifications for agents, as chosen in this browser: [on, turn on or off]. Turning on asks the browser's permission. */
export function useNotifyPreference(): [boolean, (on: boolean) => Promise<void>] {
  const [on, setOn] = useState(() => stored() && canNotify() && Notification.permission === 'granted')
  useEffect(() => {
    listeners.add(setOn)
    return () => void listeners.delete(setOn)
  }, [])
  const set = async (want: boolean) => {
    if (want && canNotify() && Notification.permission !== 'granted') want = (await Notification.requestPermission()) === 'granted'
    try {
      localStorage.setItem(KEY, want ? 'on' : 'off')
    } catch {
      /* for this visit only */
    }
    listeners.forEach((l) => l(want))
  }
  return [on, set]
}

const label = (a: Agent) => (a.title && a.title !== a.kind ? a.title : a.name || a.kind)

/** Calls you back when you're looking elsewhere: the tab's title counts the agents waiting on you, and (if turned on)
    a notification says when one starts waiting or finishes its turn. Mounted once, under the hub. */
export function useAgentCallbacks() {
  const { agents } = useHub()
  const [on] = useNotifyPreference()
  const last = useRef<Map<string, AgentStatus> | null>(null)

  const live = (agents?.available ? agents.agents : []).filter((a) => a.kind !== 'terminal')
  const waiting = live.filter((a) => a.status === 'blocked').length

  useEffect(() => {
    document.title = waiting ? `(${waiting}) ${BASE_TITLE}` : BASE_TITLE
  }, [waiting])

  useEffect(() => {
    if (!agents) return
    const now = new Map(live.map((a) => [agentKey(a), a.status]))
    const before = last.current
    last.current = now
    // The first listing only sets what is known: nothing changed yet. The desktop app notifies by itself, from the tray.
    if (!before || inDesktop || !on || !canNotify() || Notification.permission !== 'granted') return
    if (document.visibilityState === 'visible' && document.hasFocus()) return
    for (const a of live) {
      const was = before.get(agentKey(a))
      const blocked = a.status === 'blocked' && was !== 'blocked'
      const finished = (a.status === 'done' || a.status === 'idle') && was === 'working'
      if (!blocked && !finished) continue
      const source = sourceLabel(agents, a)
      const where = `${a.project?.name ?? a.cwd.split('/').filter(Boolean).pop() ?? ''}${source ? ` on ${source}` : ''}`
      const n = new Notification(blocked ? `${a.name || a.kind} needs you` : `${a.name || a.kind} finished`, {
        body: `${label(a)}${where ? ` · ${where}` : ''}`,
        tag: `marumado:${agentKey(a)}`,
      })
      n.onclick = () => {
        window.focus()
        go(blocked ? '#/m/agents/inbox' : agentHref(a))
        n.close()
      }
    }
  }, [agents, on])
}
