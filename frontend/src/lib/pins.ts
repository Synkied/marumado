import { useState } from 'react'
import type { ModuleId } from './hub'

const KEY = 'marumado.pins'
export const DEFAULT_PINS: ModuleId[] = ['projects', 'machine', 'agents', 'urls', 'ports', 'docker']

function read(): ModuleId[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (Array.isArray(raw) && raw.length) return raw
  } catch {
    /* fall through to defaults */
  }
  return DEFAULT_PINS
}

/** Which modules sit on the home panel, in order. Per-viewer convenience, so browser storage. */
export function usePins(): [ModuleId[], (next: ModuleId[]) => void] {
  const [pins, setPins] = useState<ModuleId[]>(read)
  const save = (next: ModuleId[]) => {
    setPins(next)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      /* not persisted in private mode */
    }
  }
  return [pins, save]
}
