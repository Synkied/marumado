import { useEffect, useState } from 'react'
import { Icon } from './Icon'

/* Back and forward, as in a browser: the desktop app has no browser bar to give them. The pages are hash routes,
   so the window's own history holds them; each entry is stamped with its position so we know whether there is
   anywhere to go back or forward to. The furthest position is kept for the tab, so a reload still knows. */

const KEY = 'marumado.history.max'

function readMax(): number {
  try {
    return Number(sessionStorage.getItem(KEY)) || 0
  } catch {
    return 0
  }
}

function writeMax(n: number) {
  try {
    sessionStorage.setItem(KEY, String(n))
  } catch {
    // private mode: for this page load only
  }
}

type Place = { pos: number; max: number }

let place: Place = { pos: -1, max: readMax() }

/** Where the current entry sits; a new one (just navigated to) gets the next position, dropping what was ahead. */
function locate(): Place {
  const stamped = (history.state as { marumadoPos?: number } | null)?.marumadoPos
  if (typeof stamped === 'number') {
    place = { pos: stamped, max: Math.max(stamped, place.max) }
  } else {
    const pos = place.pos + 1
    history.replaceState({ ...(history.state ?? {}), marumadoPos: pos }, '')
    place = { pos, max: pos }
  }
  writeMax(place.max)
  return place
}

export function HistoryArrows() {
  const [at, setAt] = useState<Place>(locate)
  useEffect(() => {
    const on = () => setAt(locate())
    window.addEventListener('hashchange', on)
    window.addEventListener('popstate', on)
    return () => {
      window.removeEventListener('hashchange', on)
      window.removeEventListener('popstate', on)
    }
  }, [])
  return (
    <nav className="top__history" aria-label="History">
      <button className="tool" type="button" onClick={() => history.back()} disabled={at.pos <= 0} title="Back" aria-label="Back">
        <Icon name="back" size={18} />
      </button>
      <button className="tool" type="button" onClick={() => history.forward()} disabled={at.pos >= at.max} title="Forward" aria-label="Forward">
        <Icon name="arrow" size={18} />
      </button>
    </nav>
  )
}
