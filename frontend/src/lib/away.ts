/** Marks the page `data-away` while its window is hidden or not focused, so looping animations rest (index.css). */
export function restWhenAway() {
  const root = document.documentElement
  const update = () => {
    if (document.visibilityState === 'visible' && document.hasFocus()) delete root.dataset.away
    else root.dataset.away = ''
  }
  window.addEventListener('focus', update)
  window.addEventListener('blur', update)
  document.addEventListener('visibilitychange', update)
  update()
}

/** How long the loops play, then rest: a critter blinks at least once in each burst (its blink comes every 4.7–6.4s). */
const PLAY = 7000
const REST = 13000

/** Looping animations (critters, pulses) repaint every frame, and the desktop app's webview paints them on the CPU:
    they play in bursts (`data-rest` between them) and hold still while a scroll is under way (`data-scrolling`). */
export function restLoops() {
  const root = document.documentElement
  const play = () => {
    delete root.dataset.rest
    window.setTimeout(rest, PLAY)
  }
  const rest = () => {
    root.dataset.rest = ''
    window.setTimeout(play, REST)
  }
  play()

  let still = 0
  const scrolled = () => {
    root.dataset.scrolling = ''
    window.clearTimeout(still)
    still = window.setTimeout(() => delete root.dataset.scrolling, 250)
  }
  // Every scroller, not only the page: the sheets and the sidebar scroll on their own.
  document.addEventListener('scroll', scrolled, { capture: true, passive: true })
}
