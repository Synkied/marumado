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
