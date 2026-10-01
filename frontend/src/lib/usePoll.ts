import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from './api'

type PollState<T> = { data: T | undefined; error: ApiError | Error | null; loading: boolean; refresh: () => void }

/** Fetch `path` now and every `ms` while the tab is visible. `path` null pauses polling. */
export function usePoll<T>(path: string | null, ms: number): PollState<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [loading, setLoading] = useState(path !== null)
  const tick = useRef(0)

  const load = useCallback(async () => {
    if (!path) return
    const mine = ++tick.current
    try {
      const next = await api<T>(path)
      if (mine === tick.current) {
        setData(next)
        setError(null)
      }
    } catch (e) {
      if (mine === tick.current) setError(e as Error)
    } finally {
      if (mine === tick.current) setLoading(false)
    }
  }, [path])

  useEffect(() => {
    if (!path) return
    setLoading(true)
    load()
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, ms)
    const onVisible = () => document.visibilityState === 'visible' && load()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [path, ms, load])

  return { data, error, loading, refresh: load }
}
