import { useEffect, useState } from 'react'
import type { ModuleId } from './hub'

export type Route =
  | { kind: 'home' }
  | { kind: 'alerts' }
  | { kind: 'module'; id: ModuleId; sub?: string }

const MODULES: ModuleId[] = ['projects', 'machine', 'agents', 'urls', 'ports', 'docker', 'processes', 'momentum', 'skills']

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts[0] === 'alerts') return { kind: 'alerts' }
  if (parts[0] === 'm' && MODULES.includes(parts[1] as ModuleId)) {
    return { kind: 'module', id: parts[1] as ModuleId, sub: parts.slice(2).join('/') || undefined }
  }
  return { kind: 'home' }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash))
  useEffect(() => {
    const on = () => setRoute(parse(window.location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export const go = (href: string) => {
  window.location.hash = href.replace(/^#/, '')
}
