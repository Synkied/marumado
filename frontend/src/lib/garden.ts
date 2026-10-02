import { useState } from 'react'
import type { MachineId } from './api'
import type { ModuleId } from './hub'

const KEY = 'marumado.garden'

/** Where a stone lies: its centre as fractions of the garden's width and height, and its size if set by hand. */
export type Place = { x: number; y: number; s?: number }
export type Places = Partial<Record<ModuleId, Place>>
type Draft = { pins: ModuleId[]; places: Places }

function read(machine: MachineId): Places {
  try {
    const raw = JSON.parse(localStorage.getItem(`${KEY}.${machine}`) ?? 'null')
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  } catch {
    /* fall through */
  }
  return {}
}

export type Arrangement = {
  /** What the garden shows: the unsaved draft if there is one, else what is saved. */
  pins: ModuleId[]
  places: Places
  /** The draft differs from what is saved. */
  dirty: boolean
  edit: (next: Partial<Draft>) => void
  save: () => void
  discard: () => void
}

/** The garden as you lay it out: which stones lie in it (the pins) and where each was set by hand, per machine.
    Moves, sizes, added and lifted stones are a draft until saved. Per-viewer, like pins. */
export function useArrangement(machine: MachineId, pins: ModuleId[], setPins: (next: ModuleId[]) => void): Arrangement {
  const [state, setState] = useState(() => ({ machine, saved: read(machine), draft: null as Draft | null }))
  // Switching machines shows that machine's saved arrangement.
  const current = state.machine === machine ? state : { machine, saved: read(machine), draft: null }
  if (current !== state) setState(current)
  const { saved, draft } = current
  const shown = draft ?? { pins, places: saved }
  return {
    ...shown,
    dirty: draft !== null && (JSON.stringify(draft.places) !== JSON.stringify(saved) || draft.pins.join() !== pins.join()),
    edit: (next) => setState({ machine, saved, draft: { ...shown, ...next } }),
    save: () => {
      setState({ machine, saved: shown.places, draft: null })
      if (shown.pins.join() !== pins.join()) setPins(shown.pins)
      try {
        localStorage.setItem(`${KEY}.${machine}`, JSON.stringify(shown.places))
      } catch {
        /* not persisted in private mode */
      }
    },
    discard: () => setState({ machine, saved, draft: null }),
  }
}
