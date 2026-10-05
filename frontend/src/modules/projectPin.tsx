import { useState } from 'react'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { useHub } from '../lib/hub'
import { useRoute } from '../lib/route'
import type { Project } from '../lib/types'
import { runsAnywhere } from '../lib/work'

/** The projects you pinned, by name: the ones you go back to most. */
export function pinnedProjects(projects: Project[] | null | undefined): Project[] {
  return (projects ?? []).filter((p) => p.pinned && p.kind === 'project' && !p.hidden).sort((a, b) => a.name.localeCompare(b.name))
}

/** Pin or unpin a project in one click: pinned ones sit at the top of Projects and in the sidebar. */
export function PinButton({ project: p, labelled }: { project: Project; labelled?: boolean }) {
  const { refreshProjects } = useHub()
  const [busy, setBusy] = useState(false)
  const toggle = async () => {
    setBusy(true)
    try {
      await api(`projects/${p.id}`, { method: 'PATCH', json: { pinned: !p.pinned } })
      refreshProjects()
    } finally {
      setBusy(false)
    }
  }
  const what = p.pinned ? `Unpin ${p.name}` : `Pin ${p.name}: at the top of Projects and in the sidebar`
  return (
    <button
      className={labelled ? 'btn btn--quiet' : `pin${p.pinned ? ' pin--on' : ''}`}
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={p.pinned}
      title={what}
    >
      <Icon name="pin" size={16} />
      {labelled ? (p.pinned ? ' Unpin' : ' Pin') : <span className="sr-only">{what}</span>}
    </button>
  )
}

/** Pinned projects in the sidebar, one click from anywhere: a lamp and the name, or its first letters on the rail. */
export function PinnedProjects() {
  const { projects } = useHub()
  const route = useRoute()
  const pinned = pinnedProjects(projects)
  if (!pinned.length) return null
  const open = route.kind === 'module' && route.id === 'projects' ? route.sub?.split('/')[0] : undefined
  return (
    <nav className="pinned mod-projects" aria-label="Pinned projects">
      <h2 className="pinned__title">Pinned</h2>
      <ul className="pinned__list">
        {pinned.map((p) => (
          <li key={p.id}>
            <a
              className={`pinned__item${open === String(p.id) ? ' is-active' : ''}`}
              href={`#/m/projects/${p.id}`}
              aria-current={open === String(p.id) ? 'page' : undefined}
              title={p.name}
            >
              <span className={`row__lamp${runsAnywhere(p) ? ' row__lamp--on' : ''}`} aria-hidden="true" />
              <span className="pinned__name">{p.name}</span>
              <span className="pinned__short" aria-hidden="true">
                {p.name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2) || '··'}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
