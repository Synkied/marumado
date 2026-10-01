import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Icon } from './Icon'

type Opener = { available: boolean; reason: string; url: string }

let opener: Promise<Opener> | null = null

/** How folders open here: a link template (MARUMADO_OPEN_URL), the server's file manager. Asked once; buttons hide when neither works. */
function useOpener() {
  const [o, setO] = useState<Opener | null>(null)
  useEffect(() => {
    opener ??= api<Opener>('open').catch(() => ({ available: false, reason: "Couldn't ask Marumado how to open folders.", url: '' }))
    opener.then(setO)
  }, [])
  return o
}

/** Opens a project or scan folder: through the link template, or in the file manager of the machine Marumado runs on. */
export function OpenFolder({ path, variant = 'icon' }: { path: string; variant?: 'icon' | 'chip' }) {
  const o = useOpener()
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')
  if (!o || (!o.available && !o.url)) return null

  const href = o.url ? o.url.replace('{path}', encodeURI(path)) : ''
  const fault = state === 'error'
  const label = fault ? error : href ? `Open ${path} (${o.url.split(':')[0]})` : `Open ${path} in the file manager`

  const open = async () => {
    setState('busy')
    try {
      await api('open', { method: 'POST', json: { path } })
      setState('done')
      window.setTimeout(() => setState('idle'), 1600)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open the folder.")
      setState('error')
    }
  }

  if (variant === 'chip') {
    return href ? (
      <a className="chip" href={href} title={label} aria-label={label}>Folder</a>
    ) : (
      <button className={`chip${fault ? ' chip--fault' : ''}`} type="button" onClick={open} disabled={state === 'busy'} title={label} aria-label={label}>
        {state === 'done' ? 'Opened' : fault ? "Can't open" : 'Folder'}
      </button>
    )
  }
  const icon = <Icon name={state === 'done' ? 'dot' : 'folder'} size={18} />
  return href ? (
    <a className="go" href={href} title={label} aria-label={label}>{icon}</a>
  ) : (
    <button className={`go${fault ? ' signal-text' : ''}`} type="button" onClick={open} disabled={state === 'busy'} title={label} aria-label={label}>
      {icon}
    </button>
  )
}

