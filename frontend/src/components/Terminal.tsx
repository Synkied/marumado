import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import '@fontsource/ubuntu-mono/400.css'
import '@fontsource/ubuntu-mono/700.css'
import { useEffect, useRef, useState } from 'react'
import { apiPath } from '../lib/api'
import './terminal.css'

type Link = { state: 'connecting' | 'live' | 'closed'; message: string; takeover: boolean }

const THEME = {
  background: '#111110',
  foreground: '#ecece8',
  cursor: '#ecece8',
  cursorAccent: '#111110',
  selectionBackground: '#ecece84d',
  black: '#2b2b29',
  brightBlack: '#6f6f6b',
  white: '#d6d6d1',
  brightWhite: '#ffffff',
  red: '#ff6a3d',
  brightRed: '#ff8a63',
  green: '#48cd8c',
  brightGreen: '#7be0ad',
  yellow: '#d3ac41',
  brightYellow: '#ecc964',
  blue: '#7cafff',
  brightBlue: '#a5c8ff',
  magenta: '#c398ff',
  brightMagenta: '#d9bcff',
  cyan: '#00c9e8',
  brightCyan: '#5fdff2',
}

// Narrower than the app's Fira Code, so a wide pane fits the browser with bigger text.
const FONT = "'Ubuntu Mono'"

function decode(b64: string): Uint8Array {
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** A Herdr pane's live terminal, streamed over a WebSocket. `control` lets the keyboard type into it.
 * On a computer it shows the pane at Herdr's size (resizing it would squeeze the Herdr TUI), with the text scaled to fit.
 * With `fit` (always on a phone that controls the pane), the pane takes the browser's size while it watches and the
 * server gives it back on leaving; a phone that only watches shows it at a readable size that scrolls both ways. */
export function Terminal({ paneId, control, phone = false, fit: fitWanted = false }: { paneId: string; control: boolean; phone?: boolean; fit?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const [attempt, setAttempt] = useState({ n: 0, takeover: false })
  const [link, setLink] = useState<Link>({ state: 'connecting', message: '', takeover: false })
  // Flipping `fit` reconnects while the old stream is still letting go: take over from it.
  const lastFit = useRef(fitWanted)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const refit = lastFit.current !== fitWanted
    lastFit.current = fitWanted
    const fit = control && (phone || fitWanted)
    const pan = phone && !control
    const scaled = !fit && !pan
    const css = getComputedStyle(document.documentElement)
    const term = new XTerm({
      theme: THEME,
      fontFamily: css.getPropertyValue('--f-mono').trim() || 'monospace',
      fontSize: phone ? 12 : fit ? 15 : 13,
      lineHeight: 1.15,
      scrollback: 0,
      cursorBlink: control,
      disableStdin: !control,
      allowProposedApi: false,
    })
    term.open(el)
    // Switch to the terminal font once it has loaded, so xterm measures the real glyphs.
    let gone = false
    Promise.all([document.fonts.load(`16px ${FONT}`), document.fonts.load(`bold 16px ${FONT}`)]).then(() => {
      if (gone) return
      term.options.fontFamily = `${FONT}, ${term.options.fontFamily}`
      if (fit) follow()
      else fitFont()
    }, () => {})
    if (control && !phone) term.focus()
    setLink({ state: 'connecting', message: '', takeover: false })

    // Scale the font so the pane's columns and rows fill the box; a second pass corrects the rounding.
    // xterm rounds cells to whole pixels, so whatever still overflows is shrunk with a transform.
    let raf = 0
    const ratio = () => {
      const box = term.element
      if (!box?.offsetWidth || !el.clientWidth) return 0
      return Math.min(el.clientWidth / box.offsetWidth, el.clientHeight / box.offsetHeight)
    }
    const squeeze = () => {
      if (!term.element) return
      term.element.style.transform = ''
      const k = ratio()
      if (k && k < 1) term.element.style.transform = `scale(${k})`
    }
    const fitFont = (again = true) => {
      if (!scaled) return
      cancelAnimationFrame(raf)
      if (term.element) term.element.style.transform = ''
      const k = ratio()
      if (!k) return
      const size = term.options.fontSize ?? 13
      const next = Math.max(6, Math.min(24, Math.floor(size * k * 2) / 2))
      if (next !== size) term.options.fontSize = next
      raf = requestAnimationFrame(() => (again ? fitFont(false) : squeeze()))
    }

    // Fitting a phone: how many columns and rows of the current font fit the box.
    const grid = () => {
      const screen = el.querySelector<HTMLElement>('.xterm-screen')
      if (!screen?.offsetWidth || !el.clientWidth) return null
      const cw = screen.offsetWidth / term.cols
      const ch = screen.offsetHeight / term.rows
      return { cols: Math.max(20, Math.floor(el.clientWidth / cw)), rows: Math.max(8, Math.floor(el.clientHeight / ch)) }
    }
    let sent = ''

    let ws: WebSocket | null = null
    let ended = false
    const send = (msg: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg))
    const connect = () => {
      const q = new URLSearchParams()
      if (attempt.takeover || refit) q.set('takeover', '1')
      const g = fit ? grid() : null
      if (g) {
        q.set('cols', String(g.cols))
        q.set('rows', String(g.rows))
        sent = `${g.cols}x${g.rows}`
      }
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${scheme}://${window.location.host}/api/${apiPath(`agents/${encodeURIComponent(paneId)}/terminal`)}?${q}`)
      ws.onmessage = onMessage
      ws.onclose = () => {
        if (!ended) setLink({ state: 'closed', message: 'Lost the connection to Marumado.', takeover: false })
      }
    }

    const onMessage = (e: MessageEvent) => {
      const m = JSON.parse(e.data)
      if (m.type === 'terminal.frame') {
        if (m.width !== term.cols || m.height !== term.rows) {
          term.resize(m.width, m.height)
          fitFont()
          // Panning: start on the bottom-left, where the agent's prompt is.
          if (pan) requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, left: 0 }))
        }
        term.write(decode(m.bytes))
        setLink((l) => (l.state === 'live' ? l : { state: 'live', message: '', takeover: false }))
      } else if (m.type === 'terminal.closed' || m.type === 'error') {
        ended = true
        const reason: string = m.reason ?? m.message ?? ''
        const busy = reason.includes('--takeover')
        setLink({
          state: 'closed',
          takeover: busy || reason === 'detached',
          message: busy ? 'Another window is attached to this terminal.' : reason === 'detached' ? 'Another window took this terminal over.' : reason || 'The terminal closed.',
        })
      }
    }
    const typed = control ? term.onData((text) => send({ type: 'terminal.input', text })) : null
    const binary = control ? term.onBinary((text) => send({ type: 'terminal.input', text })) : null
    // Full-screen apps that track the mouse get the wheel as input; otherwise it scrolls Herdr's history.
    term.attachCustomWheelEventHandler((ev) => {
      if (!control || term.modes.mouseTrackingMode !== 'none') return true
      send({ type: 'terminal.scroll', direction: ev.deltaY < 0 ? 'up' : 'down', lines: 3 })
      ev.preventDefault()
      return false
    })

    // A phone asks the pane to follow its size (rotation, the keyboard opening), once it settles.
    let settle = 0
    const follow = () => {
      window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        const g = grid()
        if (g && `${g.cols}x${g.rows}` !== sent) {
          sent = `${g.cols}x${g.rows}`
          send({ type: 'terminal.resize', ...g })
        }
      }, 250)
    }
    const observer = new ResizeObserver(() => (fit ? follow() : fitFont()))
    observer.observe(el)
    // xterm resizes itself a frame or two after a font change: check the fit again whenever it does.
    const settled = new ResizeObserver(() => scaled && squeeze())
    if (term.element) settled.observe(term.element)
    // Measure once the terminal has laid out, so a phone can ask for its size when attaching.
    const opening = requestAnimationFrame(connect)

    return () => {
      gone = true
      cancelAnimationFrame(raf)
      cancelAnimationFrame(opening)
      window.clearTimeout(settle)
      observer.disconnect()
      settled.disconnect()
      typed?.dispose()
      binary?.dispose()
      if (ws) {
        ws.onclose = null
        ws.close()
      }
      term.dispose()
    }
  }, [paneId, control, phone, fitWanted, attempt])

  return (
    <div className={`term term--${link.state}${control && (phone || fitWanted) ? ' term--fit' : phone ? ' term--pan' : ''}`}>
      <div className="term__screen" ref={host} />
      {link.state !== 'live' && (
        <div className="term__veil" role="status">
          <span>{link.state === 'connecting' ? 'Connecting to the terminal…' : link.message}</span>
          {link.state === 'closed' && (
            <button className="btn btn--light" type="button" onClick={() => setAttempt((a) => ({ n: a.n + 1, takeover: link.takeover }))}>
              {link.takeover ? 'Take over' : 'Reconnect'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
