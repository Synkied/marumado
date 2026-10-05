import type { ReactNode } from 'react'
import type { ModuleId } from '../lib/hub'
import { moduleHref, VIEW_OF } from '../lib/route'
import { meta, viewsOf } from './registry'

export function SheetHead({ id, children }: { id: ModuleId; children?: ReactNode }) {
  return (
    <header className={`sheet__head mod-${id}`}>
      <h2 className="sheet__title">{meta(id).label}</h2>
      {children && <div className="sheet__actions">{children}</div>}
    </header>
  )
}

/** The first tab names the page's own view: every project, or the machine at a glance. */
const FIRST: Partial<Record<ModuleId, string>> = { projects: 'All', machine: 'Overview' }

/** A page's views as tabs: Projects (All, Momentum, Skills), Machine (Overview, Processes, Ports, Docker). */
export function ViewTabs({ at }: { at: ModuleId }) {
  const home = VIEW_OF[at] ?? at
  return (
    <nav className={`seg seg--tabs mod-${home}`} aria-label={meta(home).label}>
      {viewsOf(home).map((id) => (
        <a key={id} className="seg__btn" href={moduleHref(id)} aria-current={id === at ? 'page' : undefined}>
          {(id === home && FIRST[id]) || meta(id).label}
        </a>
      ))}
    </nav>
  )
}
