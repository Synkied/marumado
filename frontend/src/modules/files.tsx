import { useEffect, useState } from 'react'
import { CodeView } from '../components/CodeView'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { ago, bytes } from '../lib/format'
import { useStreaming } from '../lib/streaming'
import type { Project } from '../lib/types'

type Entry = { name: string; kind: 'dir' | 'file' | 'broken'; link: boolean; size: number | null; mtime: number | null }
type Listing = { path: string; entries: Entry[]; total: number }
type FileRead = { path: string; size: number; mtime: number; binary: boolean; truncated: boolean; text: string }

/** Files that usually hold secrets; their contents stay hidden in streaming mode. */
const SECRET = /(^\.env(\..+)?$|^\.netrc$|^\.npmrc$|^\.pypirc$|^id_[a-z0-9]+$|\.(pem|key|p12|pfx|keystore|jks)$|secret|credential|token)/i

const split = (rel: string) => rel.split('/').filter(Boolean)
const join = (parts: string[]) => parts.map(encodeURIComponent).join('/')

/** A project's folder, browsed read-only: `kind` says whether `rel` (relative to the project) is a folder or a file. */
export function FilesView({ project, kind, rel }: { project: Project; kind: 'files' | 'file'; rel: string }) {
  const parts = split(rel).map(decodeURIComponent)
  const base = `#/m/projects/${project.id}`
  const crumbs = (
    <nav className="crumbs" aria-label="Folder">
      <a href={`${base}/files`}>{project.name}</a>
      {parts.map((part, i) => {
        const last = i === parts.length - 1
        return (
          <span key={i}>
            <span className="crumbs__sep" aria-hidden="true">
              /
            </span>
            {last ? <span aria-current="page">{part}</span> : <a href={`${base}/files/${join(parts.slice(0, i + 1))}`}>{part}</a>}
          </span>
        )
      })}
    </nav>
  )
  const path = [project.path.replace(/\/+$/, ''), ...parts].join('/')
  const up = parts.length ? `${base}/files/${join(parts.slice(0, -1))}` : base

  return (
    <div className={`sheet${kind === 'file' ? ' files--file' : ''}`}>
      <a className="side__back" href={up}>
        <Icon name="back" size={18} /> {parts.length ? 'Up a folder' : project.name}
      </a>
      <header className="sheet__head files__head">
        <div style={{ minWidth: 0 }}>
          <span className="sheet__index">{kind === 'file' ? 'FILE' : 'FILES'}</span>
          {crumbs}
        </div>
        <span className="files__mode">Read-only</span>
      </header>
      {kind === 'file' ? <FileBody path={path} name={parts[parts.length - 1] ?? ''} /> : <FolderBody path={path} base={base} parts={parts} />}
    </div>
  )
}

function useLoad<T>(path: string, endpoint: string) {
  const [state, setState] = useState<{ path: string; data?: T; error?: string }>({ path })
  useEffect(() => {
    let live = true
    api<T>(`${endpoint}?path=${encodeURIComponent(path)}`)
      .then((data) => live && setState({ path, data }))
      .catch((e: Error) => live && setState({ path, error: e.message }))
    return () => {
      live = false
    }
  }, [path, endpoint])
  return state.path === path ? state : { path }
}

function FolderBody({ path, base, parts }: { path: string; base: string; parts: string[] }) {
  const { data, error } = useLoad<Listing>(path, 'files')
  if (error) return <p className="notice signal-text">{error}</p>
  if (!data) return <div className="sheet__empty">Reading the folder…</div>
  if (!data.entries.length) return <p className="sheet__lede">This folder is empty.</p>
  return (
    <>
      <ul className="list files">
        {data.entries.map((e) => {
          const href = `${base}/${e.kind === 'dir' ? 'files' : 'file'}/${join([...parts, e.name])}`
          const dim = e.name.startsWith('.')
          return (
            <li key={e.name}>
              {e.kind === 'broken' ? (
                <span className="row files__row row--muted" title="A link to something that no longer exists">
                  <Icon name="file" size={18} />
                  <span className="row__main">{e.name}</span>
                  <span className="row__meta">broken link</span>
                </span>
              ) : (
                <a className={`row files__row${dim ? ' row--muted' : ''}`} href={href}>
                  <Icon name={e.kind === 'dir' ? 'folder' : 'file'} size={18} className={e.kind === 'dir' ? 'files__dir' : undefined} />
                  <span className="row__main">
                    {e.name}
                    {e.link && <span className="row__sub">link</span>}
                  </span>
                  <span className="row__meta">
                    {e.kind === 'file' && e.size != null ? bytes(e.size) : ''}
                    {e.mtime != null && <span className="files__age">{ago(e.mtime)}</span>}
                  </span>
                </a>
              )}
            </li>
          )
        })}
      </ul>
      {data.total > data.entries.length && <p className="sheet__lede">Showing the first {data.entries.length} of {data.total} entries.</p>}
    </>
  )
}

function FileBody({ path, name }: { path: string; name: string }) {
  const { data, error } = useLoad<FileRead>(path, 'files/read')
  const streaming = useStreaming().on
  if (error) return <p className="notice signal-text">{error}</p>
  if (!data) return <div className="sheet__empty">Opening {name}…</div>
  const meta = `${bytes(data.size)} · changed ${ago(data.mtime)}`
  if (data.binary) return <p className="notice">This is a binary file ({meta}), so it isn’t shown as text.</p>
  if (streaming && SECRET.test(name)) {
    return (
      <p className="notice">
        <strong>Hidden while streaming.</strong> {name} usually holds secrets. Turn off streaming mode (the eye next to the machine picker) to read it.
      </p>
    )
  }
  return (
    <>
      <p className="files__meta">
        {meta}
        {data.truncated && <span className="signal-text"> · showing the first {bytes(data.text.length)} only</span>}
      </p>
      <CodeView text={data.text} filename={name} />
    </>
  )
}
