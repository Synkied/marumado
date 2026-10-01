import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { setApiMachine, type MachineId } from './api'
import type { Machine } from './types'
import { usePoll } from './usePoll'

const KEY = 'marumado.machine'

type Machines = {
  /** this machine first, then the others; undefined until loaded */
  machines?: Machine[]
  /** the machine every module shows */
  current: MachineId
  currentMachine?: Machine
  select: (id: MachineId) => void
  refresh: () => void
}

const MachinesContext = createContext<Machines | null>(null)

function remembered(): MachineId {
  try {
    const v = localStorage.getItem(KEY)
    return v && /^\d+$/.test(v) ? Number(v) : 'local'
  } catch {
    return 'local'
  }
}

/** The machines this Marumado can show, and which one is showing. Chosen per browser. */
export function MachinesProvider({ children }: { children: (current: MachineId) => ReactNode }) {
  const [current, setCurrent] = useState<MachineId>(() => {
    const id = remembered()
    setApiMachine(id)
    return id
  })
  const { data: machines, refresh } = usePoll<Machine[]>('machines', 5000)

  const select = useCallback((id: MachineId) => {
    setApiMachine(id)
    setCurrent(id)
    try {
      localStorage.setItem(KEY, String(id))
    } catch {
      /* not remembered */
    }
  }, [])

  // A machine removed elsewhere (or in another browser) falls back to this one.
  const gone = !!machines && current !== 'local' && !machines.some((m) => m.id === current)
  useEffect(() => {
    if (gone) select('local')
  }, [gone, select])

  const value: Machines = { machines, current, currentMachine: machines?.find((m) => m.id === current), select, refresh }
  return <MachinesContext.Provider value={value}>{children(current)}</MachinesContext.Provider>
}

export function useMachines(): Machines {
  const ctx = useContext(MachinesContext)
  if (!ctx) throw new Error('useMachines outside MachinesProvider')
  return ctx
}
