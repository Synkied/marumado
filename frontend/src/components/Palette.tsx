import { useEffect, useMemo, useRef, useState } from 'react'
import { agentHref, agentKey, preferredKind, sourceLabel, startAgent, workspaceIn, workspaceLabel } from '../lib/agents'
import { api } from '../lib/api'
import { useHub } from '../lib/hub'
import { go, moduleHref } from '../lib/route'
import type { Proc } from '../lib/types'
import { startPlaces } from '../lib/work'
import { MODULES } from '../modules/registry'
import { Icon, type IconName } from './Icon'
import './palette.css'

/** `run` may answer with a promise: the box stays open until it settles, and says why if it fails. */
type Item = { key: string; icon: IconName; label: string; sub: string; run: () => void | Promise<void> }

/** The module whose colour an icon carries, if any. */
const iconModule = (icon: IconName) => MODULES.find((m) => m.icon === icon)?.id

/** `/` or ⌘K: one box over modules, projects, ports, containers and processes. */
export function Palette({ onClose }: { onClose: () => void }) {
  const { projects, ports, docker, agents, refreshAgents } = useHub()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [procs, setProcs] = useState<Proc[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    dialog.current?.showModal()
    input.current?.focus()
  }, [])

  useEffect(() => {
    const needle = q.trim()
    if (needle.length < 2) return setProcs([])
    const t = window.setTimeout(() => {
      api<{ processes: Proc[] }>(`processes?q=${encodeURIComponent(needle)}&limit=6`)
        .then((r) => setProcs(r.processes))
        .catch(() => setProcs([]))
    }, 180)
    return () => window.clearTimeout(t)
  }, [q])

  const items = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase()
    const hit = (...s: (string | undefined)[]) => !needle || s.join(' ').toLowerCase().includes(needle)
    const open = (url: string) => () => {
      window.open(url, '_blank', 'noreferrer')
    }
    const out: Item[] = []
    for (const m of MODULES) if (hit(m.label, m.blurb)) out.push({ key: `m:${m.id}`, icon: m.icon, label: m.label, sub: m.blurb, run: () => go(moduleHref(m.id)) })
    // Pinned projects first: the ones you go back to most.
    for (const p of [...(projects ?? [])].sort((a, b) => Number(b.pinned) - Number(a.pinned))) {
      if (!hit(p.name, p.description, ...p.tags, ...(p.detected.stacks ?? []))) continue
      if (p.kind === 'link') {
        // A link's whole point is its URL: Enter opens it.
        const url = p.online_url || p.local_url
        out.push({ key: `p:${p.id}`, icon: 'globe', label: p.name, sub: url ? `Link · ${url}` : 'Link', run: url ? open(url) : () => go(`#/m/projects/${p.id}`) })
        continue
      }
      out.push({ key: `p:${p.id}`, icon: p.pinned ? 'pin' : 'folder', label: p.name, sub: `${p.pinned ? 'Pinned project' : 'Project'}${p.running ? ' · running' : ''}`, run: () => go(`#/m/projects/${p.id}`) })
      const local = p.local_url || p.suggested_local_url
      if (needle && local) out.push({ key: `pl:${p.id}`, icon: 'terminal', label: `Open ${p.name} locally`, sub: local, run: open(local) })
      if (needle && p.online_url) out.push({ key: `po:${p.id}`, icon: 'globe', label: `Open ${p.name} live`, sub: p.online_url, run: open(p.online_url) })
      if (needle && p.repo_url) out.push({ key: `pr:${p.id}`, icon: 'repo', label: `Open ${p.name} repository`, sub: p.repo_url, run: open(p.repo_url) })
      const where = agents?.terminal === 'control' ? startPlaces(p, agents)[0] : undefined
      if (needle && where) {
        const kind = preferredKind(agents?.kinds)
        const on = (agents?.sources?.length ?? 0) > 1 ? ` on ${where.name}` : ''
        // Opens it once Agents lists it, so the page doesn't show another agent meanwhile.
        const workspace = workspaceIn(agents, where.id)
        const start = async () => {
          const made = await startAgent(p.id, kind, where.id, workspace?.id)
          await refreshAgents()
          go(agentHref(made))
        }
        const inside = workspace ? `, in the workspace ${workspaceLabel(workspace)}` : ''
        out.push({ key: `pa:${p.id}`, icon: 'agent', label: `Start ${kind} in ${p.name}`, sub: `New agent in its folder${on}${inside}`, run: start })
      }
    }
    if (needle) {
      for (const p of ports ?? []) {
        if (hit(`:${p.port}`, String(p.port), p.process, p.project?.name))
          out.push({ key: `port:${p.port}:${p.pid}`, icon: 'ports', label: `:${p.port}`, sub: p.project?.name || p.process || 'Listening port', run: open(`http://${window.location.hostname}:${p.port}`) })
      }
      for (const c of docker?.containers ?? []) {
        if (hit(c.name, c.image)) out.push({ key: `c:${c.id}`, icon: 'container', label: c.name, sub: `Container · ${c.status}`, run: () => go(moduleHref('docker')) })
      }
      for (const a of agents?.agents ?? []) {
        const on = sourceLabel(agents, a)
        if (hit(a.name, a.kind, a.title, a.cwd, on))
          out.push({ key: `agent:${agentKey(a)}`, icon: 'agent', label: a.title || a.kind, sub: `${a.kind}${on ? ` on ${on}` : ''} · ${a.status}`, run: () => go(agentHref(a)) })
      }
      for (const p of procs) out.push({ key: `proc:${p.pid}`, icon: 'processes', label: p.name, sub: `Process ${p.pid} · ${p.cpu}% CPU`, run: () => go(moduleHref('processes')) })
      if (hit('add project new')) out.push({ key: 'a:add', icon: 'plus', label: 'Add a project', sub: 'Name, local and live URLs', run: () => go('#/m/projects/new') })
      if (hit('add url link website new')) out.push({ key: 'a:url', icon: 'plus', label: 'Add a URL', sub: 'Any site or service to link and watch', run: () => go('#/m/urls/new') })
      if (hit('scan folders directories roots')) out.push({ key: 'a:folders', icon: 'folder', label: 'Scan folders', sub: 'Choose where projects are found', run: () => go('#/m/projects/folders') })
    }
    // Nothing typed yet: the pinned projects open the list, one Enter away.
    if (!needle) {
      const pinned = new Set((projects ?? []).filter((p) => p.pinned && p.kind === 'project').map((p) => `p:${p.id}`))
      out.sort((a, b) => Number(pinned.has(b.key)) - Number(pinned.has(a.key)))
    }
    return out.slice(0, 40)
  }, [q, projects, ports, docker, agents, procs, refreshAgents])

  useEffect(() => {
    setSel(0)
    setError('')
  }, [q])

  const choose = async (i: number) => {
    const it = items[i]
    if (!it || busy) return
    const running = it.run()
    if (!(running instanceof Promise)) return onClose()
    setBusy(it.key)
    setError('')
    try {
      await running
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.")
    } finally {
      setBusy('')
    }
  }

  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label="Search"
      onClose={onClose}
      onClick={(e) => e.target === dialog.current && onClose()}
    >
      <div className="palette__box">
        <label className="palette__field">
          <Icon name="search" size={22} />
          <span className="sr-only">Search Marumado</span>
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search projects, processes, ports"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[sel] ? `pi-${sel}` : undefined}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(items.length - 1, s + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(0, s - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(sel)
              }
            }}
          />
          <kbd className="palette__esc">esc</kbd>
        </label>
        {error && (
          <p className="palette__error signal-text" role="alert">
            {error}
          </p>
        )}
        <ul className="palette__list" id="palette-list" role="listbox">
          {items.length === 0 && <li className="palette__empty">Nothing matches “{q}”.</li>}
          {items.map((it, i) => (
            <li
              key={it.key}
              id={`pi-${i}`}
              role="option"
              aria-selected={i === sel}
              className={`palette__item${i === sel ? ' is-sel' : ''}`}
              onMouseMove={() => setSel(i)}
              onClick={() => choose(i)}
            >
              <Icon name={it.icon} size={20} className={`palette__icon${iconModule(it.icon) ? ` mod-${iconModule(it.icon)}` : ''}`} />
              <span className="palette__label">{it.label}</span>
              <span className="palette__sub">{busy === it.key ? 'Starting…' : it.sub}</span>
            </li>
          ))}
        </ul>
      </div>
    </dialog>
  )
}
