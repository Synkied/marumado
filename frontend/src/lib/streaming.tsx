import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

const KEY = 'marumado.streaming'

type Streaming = { on: boolean; toggle: () => void }

const StreamingContext = createContext<Streaming>({
  on: false,
  toggle: () => {},
})

function initial(): boolean {
  // `?stream` in the address always turns it on, for a page captured by streaming software.
  if (new URLSearchParams(window.location.search).has('stream')) return true
  // On by default: details only show once someone chooses to, in this browser.
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

/** Streaming mode: hides what shouldn't end up on a stream or a screenshot (SSH logins, paths, addresses, logs). */
export function StreamingProvider({ children }: { children: ReactNode }) {
  const [on, setOn] = useState(initial)
  const toggle = useCallback(
    () =>
      setOn((was) => {
        try {
          localStorage.setItem(KEY, was ? 'off' : 'on')
        } catch {
          /* not remembered */
        }
        return !was
      }),
    [],
  )
  useEffect(() => {
    document.documentElement.toggleAttribute('data-streaming', on)
  }, [on])
  return <StreamingContext.Provider value={{ on, toggle }}>{children}</StreamingContext.Provider>
}

export const useStreaming = () => useContext(StreamingContext)

export const HIDDEN = '•••••'

/** `text`, or a placeholder while streaming. */
export function Secret({ children, label }: { children: ReactNode; label?: string }) {
  const { on } = useStreaming()
  if (!on) return <>{children}</>
  return (
    <span className="secret" title={`${label ?? 'Hidden'} while streaming`}>
      {label ? `${label} hidden` : HIDDEN}
    </span>
  )
}

/** `text` with every secret in it masked while streaming (an SSH target inside an error message, say). */
export function useRedact(): (text: string, ...secrets: (string | null | undefined)[]) => string {
  const { on } = useStreaming()
  return useCallback(
    (text, ...secrets) => {
      if (!on) return text
      let out = text
      for (const s of secrets) if (s) out = out.split(s).join(HIDDEN)
      // Logins, paths and IP addresses, wherever they appear.
      return out
        .replace(/\b[\w.-]+@[\w.-]+(?::\d+)?/g, HIDDEN)
        .replace(/(?:~|\/)[\w.@~-]+(?:\/[\w.@~-]+)+/g, HIDDEN)
        .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, HIDDEN)
    },
    [on],
  )
}

/** `text` as plain text, masked while streaming as useRedact does. */
export function Redacted({ text, secrets = [] }: { text: string; secrets?: (string | null | undefined)[] }) {
  return <>{useRedact()(text, ...secrets)}</>
}
