import { useEffect, useState } from 'react'

const QUERY = '(max-width: 860px)'

/** Phone-sized screens, where the layout stacks into one column. */
export function useIsNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia(QUERY).matches)
  useEffect(() => {
    const m = window.matchMedia(QUERY)
    const on = () => setNarrow(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return narrow
}
