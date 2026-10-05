import { useEffect, useState } from 'react'
import type { ModuleId } from './hub'

export type Route =
  | { kind: 'home' }
  | { kind: 'alerts' }
  | { kind: 'module'; id: ModuleId; sub?: string }

const MODULES: ModuleId[] = ['projects', 'machine', 'agents', 'tasks', 'urls', 'machines']

/** Modules read as a tab of another module's page rather than as a page of their own. */
export const VIEW_OF: Partial<Record<ModuleId, ModuleId>> = { momentum: 'projects', skills: 'projects', processes: 'machine', ports: 'machine', docker: 'machine' }

/** Where a module opens: its own page, or its tab on the page it lives under. */
export const moduleHref = (id: ModuleId) => {
  const under = VIEW_OF[id]
  return under ? `#/m/${under}/${id}` : `#/m/${id}`
}

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts[0] === 'alerts') return { kind: 'alerts' }
  // A view's old address (#/m/docker) still lands on its tab (#/m/machine/docker).
  const under = parts[0] === 'm' ? VIEW_OF[parts[1] as ModuleId] : undefined
  if (under) return { kind: 'module', id: under, sub: parts.slice(1).join('/') }
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
