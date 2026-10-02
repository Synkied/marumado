import { useState } from 'react'
import { DEFAULT_READOUTS, readout, type ReadoutId } from '../modules/readouts'
import type { MachineId } from './api'

const READOUTS_KEY = 'marumado.readouts'
const FOLD_KEY = 'marumado.fold'

function load<T>(key: string): Record<string, T> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  } catch {
    /* fall through */
  }
  return {}
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* not remembered in private mode */
  }
}

export type Readouts = {
  /** The readings shown on a machine's block, in order. */
  of: (machine: MachineId) => ReadoutId[]
  /** Whether a machine's readings were chosen by hand. */
  custom: (machine: MachineId) => boolean
  set: (machine: MachineId, next: ReadoutId[]) => void
  /** Give every machine these readings, so their blocks line up again. */
  setAll: (machines: MachineId[], next: ReadoutId[]) => void
  reset: (machine: MachineId) => void
}

/** Which readings each machine's block shows on home, and in which order. Per viewer, like the pins. */
export function useReadouts(): Readouts {
  const [saved, setSaved] = useState(() => load<ReadoutId[]>(READOUTS_KEY))
  const commit = (next: Record<string, ReadoutId[]>) => {
    setSaved(next)
    store(READOUTS_KEY, next)
  }
  return {
    // A reading that no longer exists (renamed or removed) is dropped.
    of: (m) => saved[String(m)]?.filter((id) => readout(id)) ?? DEFAULT_READOUTS,
    custom: (m) => String(m) in saved,
    set: (m, next) => commit({ ...saved, [String(m)]: next }),
    setAll: (ms, next) => commit({ ...saved, ...Object.fromEntries(ms.map((m) => [String(m), next])) }),
    reset: (m) => {
      const rest = { ...saved }
      delete rest[String(m)]
      commit(rest)
    },
  }
}

/** Machines folded to their header line, or unfolded, by hand. Unset follows the default (see the home view). */
export function useFolds(): [(machine: MachineId) => boolean | undefined, (machine: MachineId, open: boolean) => void] {
  const [folds, setFolds] = useState(() => load<boolean>(FOLD_KEY))
  const set = (m: MachineId, open: boolean) => {
    const next = { ...folds, [String(m)]: open }
    setFolds(next)
    store(FOLD_KEY, next)
  }
  return [(m) => folds[String(m)], set]
}
