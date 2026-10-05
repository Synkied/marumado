import { useState } from 'react'
import type { MachineId } from './api'
import type { ModuleId } from './hub'
import { PANEL_MODULES } from '../modules/registry'

const KEY = 'marumado.pins'
export const DEFAULT_PINS: ModuleId[] = ['projects', 'tasks', 'agents', 'urls', 'machine', 'machines']

function parse(key: string): ModuleId[] | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null')
    // A layout saved before a module became another's tab (Momentum, Docker…) drops it.
    const pins = Array.isArray(raw) ? raw.filter((id) => PANEL_MODULES.some((m) => m.id === id)) : []
    if (pins.length) return pins
  } catch {
    /* fall through */
  }
  return null
}

/** A machine never arranged starts from the layout saved before pins were per machine, then the defaults. */
function read(machine: MachineId): ModuleId[] {
  return parse(`${KEY}.${machine}`) ?? parse(KEY) ?? DEFAULT_PINS
}

/** Which modules sit on the home panel, in order, for each machine. Per-viewer convenience, so browser storage. */
export function usePins(machine: MachineId): [ModuleId[], (next: ModuleId[]) => void] {
  const [state, setState] = useState(() => ({ machine, pins: read(machine) }))
  const save = (next: ModuleId[]) => {
    setState({ machine, pins: next })
    try {
      localStorage.setItem(`${KEY}.${machine}`, JSON.stringify(next))
    } catch {
      /* not persisted in private mode */
    }
  }
  // Switching machines shows that machine's layout.
  if (state.machine !== machine) {
    const next = { machine, pins: read(machine) }
    setState(next)
    return [next.pins, save]
  }
  return [state.pins, save]
}
