import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { sourceOf, sourceQuery } from '../lib/agents'
import type { Agent } from '../lib/types'
import { usePoll } from '../lib/usePoll'
import './agentChanges.css'

type ChangedFile = { path: string; status: string; original: string | null }
type Changes = { repository: string | null; files: ChangedFile[] }
type Diff = { path: string; diff: string; truncated: boolean }
type Folder = { folders: Map<string, Folder>; files: ChangedFile[] }

function treeOf(files: ChangedFile[]): Folder {
  const root: Folder = { folders: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] })
      node = node.folders.get(part)!
    }
    node.files.push(file)
  }
  return root
}

function statusOf(file: ChangedFile): string {
  if (file.status === '??') return 'New'
  if (file.status.includes('U') || ['AA', 'DD'].includes(file.status)) return 'Conflict'
  if (file.status.includes('R')) return 'Renamed'
  if (file.status.includes('D')) return 'Deleted'
  if (file.status.includes('A')) return 'Added'
  return 'Modified'
}

function FileTree({ node, selected, select }: { node: Folder; selected: string; select: (path: string) => void }) {
  return (
    <ul className="changes__tree">
      {[...node.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, folder]) => (
        <li key={name}>
          <details open>
            <summary><Icon name="folder" size={16} /> <span>{name}</span></summary>
            <FileTree node={folder} selected={selected} select={select} />
          </details>
        </li>
      ))}
      {[...node.files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => (
        <li key={file.path}>
          <button type="button" className="changes__file" aria-pressed={selected === file.path} onClick={() => select(file.path)} title={file.path}>
            <Icon name="file" size={16} />
            <span className="changes__filename">{file.path.split('/').at(-1)}</span>
            <span className="changes__status">{statusOf(file)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function AgentChangesModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const endpoint = `agents/${encodeURIComponent(agent.pane_id)}/changes?${sourceQuery(sourceOf(agent))}`
  const listing = usePoll<Changes>(endpoint, 5000)
  const [picked, setPicked] = useState('')
  const files = listing.data?.files ?? []
  const selected = files.some((f) => f.path === picked) ? picked : files[0]?.path ?? ''
  const file = files.find((f) => f.path === selected)
  const diff = usePoll<Diff>(selected ? `${endpoint}&path=${encodeURIComponent(selected)}` : null, 5000)
  const content = diff.data?.path === selected ? diff.data : undefined
  useEffect(() => { dialog.current?.showModal() }, [])
  return (
    <dialog ref={dialog} className="pmodal changes" aria-labelledby="changes-title" onCancel={(e) => { e.preventDefault(); onClose() }} onClick={(e) => e.target === dialog.current && onClose()}>
      <header className="pmodal__head">
        <div className="changes__heading">
          <h2 id="changes-title">Files changed{listing.data && ` · ${files.length}`}</h2>
          <p>{listing.data?.repository ?? agent.cwd}</p>
        </div>
        <div className="changes__tools">
          <button type="button" className="tool" aria-label="Refresh changes" onClick={() => { void listing.refresh(); void diff.refresh() }}><Icon name="refresh" size={18} /></button>
          <button type="button" className="tool" aria-label="Close" onClick={onClose}><Icon name="close" size={18} /></button>
        </div>
      </header>
      <p className="changes__caption">Current uncommitted changes in this agent’s repository, including staged and new files.</p>
      {listing.error && <p className="notice signal-text">Couldn’t read changes: {listing.error.message}</p>}
      {!listing.data ? (!listing.error && <p className="notice" role="status">Loading changes…</p>) : !listing.data.repository ? (
        <p className="notice">This agent’s working folder is not in a Git repository.</p>
      ) : !files.length ? (
        <p className="notice">No uncommitted changes. The working tree is clean.</p>
      ) : (
        <div className="changes__layout">
          <nav className="changes__nav" aria-label="Changed files"><FileTree node={treeOf(files)} selected={selected} select={setPicked} /></nav>
          <section className="changes__detail" aria-label="File changes">
            <header className="changes__detail-head"><strong>{selected}</strong><span>{file && statusOf(file)}</span></header>
            {file?.original && <p className="changes__caption">Renamed from {file.original}</p>}
            {diff.error ? <p className="notice signal-text">Couldn’t read this diff: {diff.error.message}</p> : !content ? <p className="notice" role="status">Loading diff…</p> : (
              <>
                {content.truncated && <p className="notice">Showing the first 256 KB of this diff.</p>}
                {content.diff ? <pre className="changes__diff" tabIndex={0} aria-label={`Diff for ${selected}`}><code>{content.diff.split('\n').map((line, index) => (
                  <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'changes__added' : line.startsWith('-') && !line.startsWith('---') ? 'changes__removed' : line.startsWith('@@') ? 'changes__hunk' : undefined}>{line}{'\n'}</span>
                ))}</code></pre> : <p className="notice">No text diff available. This may be an empty file, a rename, or a file mode change.</p>}
              </>
            )}
          </section>
        </div>
      )}
    </dialog>
  )
}
