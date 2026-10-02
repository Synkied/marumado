import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ConfirmButton } from '../components/ConfirmButton'
import { DotChart } from '../components/DotChart'
import { Icon } from '../components/Icon'
import { OpenFolder } from '../components/OpenFolder'
import { api } from '../lib/api'
import { ago, hostOf } from '../lib/format'
import { commits, pace, PACE_LABEL } from '../lib/growth'
import { useHub } from '../lib/hub'
import { go } from '../lib/route'
import type { Project, ScanRoot } from '../lib/types'
import { useView, ViewSwitch } from './growth'
import { Secret } from '../lib/streaming'
import { FilesView } from './files'
import { SheetHead } from './sheetHead'

function lamp(p: Project) {
  const live = p.status.online.latest
  if (p.online_url && live && !live.ok) return 'row__lamp row__lamp--fault'
  return p.running ? 'row__lamp row__lamp--on' : 'row__lamp'
}

function stateLabel(p: Project): string {
  const live = p.status.online.latest
  if (p.online_url && live && !live.ok) return 'Live site down'
  return p.running ? 'Running' : 'Idle'
}

function Links({ p }: { p: Project }) {
  const local = p.local_url || p.suggested_local_url
  return (
    <span className="chips">
      {local && (
        <a className="chip" href={local} target="_blank" rel="noreferrer" >
          Local
        </a>
      )}
      {p.online_url && (
        <a className="chip" href={p.online_url} target="_blank" rel="noreferrer" >
          Live
        </a>
      )}
      {p.repo_url && (
        <a className="chip" href={p.repo_url} target="_blank" rel="noreferrer" >
          Repo
        </a>
      )}
      {p.path && !p.detected.missing && <OpenFolder path={p.path} variant="chip" />}
    </span>
  )
}

export function ProjectsSheet({ sub }: { sub?: string }) {
  const { projects, refreshProjects } = useHub()
  const [q, setQ] = useState('')
  const [scanning, setScanning] = useState(false)
  const [view, setView] = useView('marumado.projects-view', ['grid', 'list'] as const)

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (projects ?? [])
      .filter((p) => p.kind === 'project')
      .filter((p) => !needle || [p.name, p.description, ...p.tags, ...(p.detected.stacks ?? [])].join(' ').toLowerCase().includes(needle))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.running) - Number(a.running) || a.name.localeCompare(b.name))
  }, [projects, q])

  if (sub === 'folders') return <FoldersSheet />
  if (sub === 'new') return <ProjectForm onDone={(id) => go(id ? `#/m/projects/${id}` : '#/m/projects')} />
  if (sub) {
    const [id, mode, ...rest] = sub.split('/')
    const project = projects?.find((p) => String(p.id) === id)
    if (!projects) return <div className="sheet__empty">Loading…</div>
    if (!project) return <div className="sheet__empty">That project no longer exists.</div>
    if ((mode === 'files' || mode === 'file') && project.path) return <FilesView project={project} kind={mode} rel={rest.join('/')} key={sub} />
    if (mode === 'edit') return <ProjectForm project={project} onDone={() => go(`#/m/projects/${project.id}`)} />
    return <ProjectDetail p={project} />
  }

  const scan = async () => {
    setScanning(true)
    try {
      await api('projects/scan', { method: 'POST' })
      refreshProjects()
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="sheet">
      <SheetHead id="projects">
        <ViewSwitch value={view} views={[['grid', 'Grid'], ['list', 'List']]} onChange={setView} />
        <a className="btn btn--quiet" href="#/m/projects/folders">
          <Icon name="folder" size={16} /> Folders
        </a>
        <button className="btn btn--quiet" type="button" onClick={scan} disabled={scanning}>
          <Icon name="refresh" size={16} /> {scanning ? 'Scanning' : 'Rescan'}
        </button>
        <a className="btn" href="#/m/projects/new">
          <Icon name="plus" size={16} /> Add
        </a>
      </SheetHead>
      <label className="filter">
        <Icon name="search" size={18} />
        <span className="sr-only">Filter projects</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, stack or tag" />
      </label>
      {!projects ? (
        <div className="sheet__empty">Loading projects…</div>
      ) : list.length === 0 ? (
        <div className="sheet__empty">{q ? `Nothing matches “${q}”.` : 'No projects yet. Rescan your folders or add one by hand.'}</div>
      ) : view === 'grid' ? (
        <ul className="cardgrid cardgrid--wide">
          {list.map((p) => (
            <li className="itemcard" key={p.id}>
              <span className="itemcard__state">
                <span className={lamp(p)} aria-hidden />
                {stateLabel(p)}
              </span>
              <a className="itemcard__name" href={`#/m/projects/${p.id}`}>
                {p.name}
              </a>
              <span className="itemcard__sub">{(p.detected.stacks ?? []).join(' · ') || (p.source === 'manual' ? 'Added by hand' : 'Folder')}</span>
              {p.detected.last_commit_at && <span className="itemcard__sub">Last commit {ago(p.detected.last_commit_at)}</span>}
              <Links p={p} />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="list">
          {list.map((p) => (
            <li className="row" key={p.id}>
              <span className={lamp(p)} role="img" aria-label={p.running ? 'running' : 'idle'} />
              <a className="row__main row__link" href={`#/m/projects/${p.id}`}>
                {p.name}
                <span className="row__sub">{(p.detected.stacks ?? []).join(' · ') || (p.source === 'manual' ? 'Added by hand' : 'Folder')}</span>
              </a>
              <Links p={p} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ProjectDetail({ p }: { p: Project }) {
  const { refreshProjects } = useHub()
  const [checking, setChecking] = useState(false)
  const local = p.local_url || p.suggested_local_url
  const check = async () => {
    setChecking(true)
    try {
      await api(`projects/${p.id}/check`, { method: 'POST' })
      refreshProjects()
    } finally {
      setChecking(false)
    }
  }
  const isLink = p.kind === 'link'
  const home = isLink ? '#/m/urls' : '#/m/projects'
  const remove = async () => {
    await api(`projects/${p.id}`, { method: 'DELETE' })
    refreshProjects()
    go(home)
  }
  const copyPath = () => navigator.clipboard?.writeText(p.path).catch(() => {})

  return (
    <div className="sheet">
      <a className="side__back" href={home}>
        <Icon name="back" size={18} /> {isLink ? 'All URLs' : 'All projects'}
      </a>
      <header className="sheet__head">
        <div style={{ minWidth: 0 }}>
          <span className="sheet__index">{isLink ? 'LINK' : p.running ? 'RUNNING' : p.detected.missing ? 'FOLDER MISSING' : 'IDLE'}</span>
          <h2 className="sheet__title" style={{ textTransform: 'none' }}>
            {p.name}
          </h2>
        </div>
        <div className="sheet__actions">
          {p.path && !p.detected.missing && (
            <a className="btn btn--quiet" href={`#/m/projects/${p.id}/files`}>
              <Icon name="file" size={16} /> Files
            </a>
          )}
          <a className="btn btn--quiet" href={`#/m/projects/${p.id}/edit`}>
            <Icon name="edit" size={16} /> Edit
          </a>
        </div>
      </header>
      {p.description && <p className="sheet__lede">{p.description}</p>}

      <ul className="list">
        {local && (
          <li className="row">
            <Icon name="terminal" size={20} />
            <span className="row__main">
              {hostOf(local)}
              <span className="row__sub">{p.local_url ? 'Local' : 'Local · detected from a listening port'}</span>
            </span>
            <a className="go" href={local} target="_blank" rel="noreferrer" aria-label="Open local URL">
              <Icon name="arrow" size={20} />
            </a>
          </li>
        )}
        {p.online_url && (
          <li className="row">
            <Icon name="globe" size={20} />
            <span className="row__main">
              {hostOf(p.online_url)}
              <span className="row__sub">Live</span>
            </span>
            <a className="go" href={p.online_url} target="_blank" rel="noreferrer" aria-label="Open live site">
              <Icon name="arrow" size={20} />
            </a>
          </li>
        )}
        {p.repo_url && (
          <li className="row">
            <Icon name="repo" size={20} />
            <span className="row__main">
              {hostOf(p.repo_url)}
              <span className="row__sub">Repository</span>
            </span>
            <a className="go" href={p.repo_url} target="_blank" rel="noreferrer" aria-label="Open repository">
              <Icon name="arrow" size={20} />
            </a>
          </li>
        )}
        {p.path && (
          <li className="row">
            <Icon name="folder" size={20} />
            <span className="row__main">
              <Secret label="Path">{p.path}</Secret>
              <span className="row__sub">Folder on this machine</span>
            </span>
            {!p.detected.missing && <OpenFolder path={p.path} />}
            <button className="go" type="button" onClick={copyPath} aria-label="Copy folder path">
              <Icon name="copy" size={18} />
            </button>
          </li>
        )}
        {!local && !p.online_url && !p.repo_url && !p.path && (
          <li className="sheet__empty">No links yet. Edit the project to add its URLs.</li>
        )}
      </ul>

      {(['online', 'local'] as const).map((t) =>
        p.status[t].latency.length && p.status[t].uptime_percent ? (
          <section className="sheet__section" key={t}>
            <h3>
              {t === 'online' ? 'Live' : 'Local'} response time · {p.status[t].uptime_percent}% up
            </h3>
            <DotChart values={p.status[t].latency} tone={p.status[t].latest?.ok === false ? 'signal' : 'ink'} label={`${t} latency`} unit=" ms" span={`${p.status[t].latency.length} min`} />
          </section>
        ) : null,
      )}

      {!isLink && (
        <section className="sheet__section">
          <h3>Details</h3>
          <dl className="facts">
            {p.detected.stacks?.length ? (
              <>
                <dt>Stack</dt>
                <dd>{p.detected.stacks.join(' · ')}</dd>
              </>
            ) : null}
            {p.detected.branch && (
              <>
                <dt>Branch</dt>
                <dd>
                  {p.detected.branch}
                  {p.detected.dirty_files ? ` · ${p.detected.dirty_files} changed files` : ' · clean'}
                </dd>
              </>
            )}
            {p.detected.last_commit && (
              <>
                <dt>Last commit</dt>
                <dd>
                  {p.detected.last_commit} · {ago(p.detected.last_commit_at)}
                </dd>
              </>
            )}
            {p.detected.last_commit_at && (
              <>
                <dt>Momentum</dt>
                <dd>
                  <a className="row__link" href="#/m/momentum">
                    {PACE_LABEL[pace(p)]}
                  </a>
                  {` · ${commits(p.detected.weekly_commits)} commits in 12 weeks`}
                  {p.focus === 'push' ? ' · marked push' : p.focus === 'park' ? ' · parked' : ''}
                </dd>
              </>
            )}
            {p.runtime.ports.length > 0 && (
              <>
                <dt>Ports</dt>
                <dd>{p.runtime.ports.map((x) => `:${x.port} (${x.process || 'pid ' + x.pid})`).join(', ')}</dd>
              </>
            )}
            {p.runtime.containers.length > 0 && (
              <>
                <dt>Containers</dt>
                <dd>{p.runtime.containers.map((c) => `${c.name} · ${c.status}`).join(', ')}</dd>
              </>
            )}
            {p.tags.length > 0 && (
              <>
                <dt>Tags</dt>
                <dd>{p.tags.join(', ')}</dd>
              </>
            )}
          </dl>
        </section>
      )}

      <div className="sheet__actions" style={{ justifyContent: 'start' }}>
        {(p.local_url || p.online_url) && (
          <button className="btn btn--quiet" type="button" onClick={check} disabled={checking}>
            <Icon name="refresh" size={16} /> {checking ? 'Checking' : 'Check URLs now'}
          </button>
        )}
        <ConfirmButton onConfirm={remove} confirmLabel={p.source === 'scan' ? 'Confirm hide' : 'Confirm delete'}>
          {p.source === 'scan' ? 'Hide project' : isLink ? 'Delete URL' : 'Delete project'}
        </ConfirmButton>
      </div>
    </div>
  )
}

export function ProjectForm({ project, kind = project?.kind ?? 'project', onDone }: { project?: Project; kind?: Project['kind']; onDone: (id?: number) => void }) {
  const { refreshProjects } = useHub()
  const isLink = kind === 'link'
  const [form, setForm] = useState({
    name: project?.name ?? '',
    description: project?.description ?? '',
    local_url: project?.local_url ?? project?.suggested_local_url ?? '',
    online_url: project?.online_url ?? '',
    repo_url: project?.repo_url ?? '',
    tags: (project?.tags ?? []).join(', '),
    pinned: project?.pinned ?? false,
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const set = (k: keyof typeof form) => (e: { target: { value: string; checked?: boolean; type?: string } }) =>
    setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    const body = { ...form, kind, tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean) }
    try {
      const saved = await api<Project>(project ? `projects/${project.id}` : 'projects', { method: project ? 'PATCH' : 'POST', json: body })
      refreshProjects()
      onDone(saved.id)
    } catch (err) {
      setError(err instanceof Error ? `Couldn't save: ${err.message}. Check the URLs start with http:// or https://.` : "Couldn't save.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="sheet" onSubmit={submit}>
      <header className="sheet__head">
        <h2 className="sheet__title">{isLink ? (project ? 'Edit URL' : 'Add URL') : project ? 'Edit project' : 'Add project'}</h2>
      </header>
      {project?.source === 'scan' && (
        <p className="sheet__lede">Fields you change here are kept the next time folders are rescanned.</p>
      )}
      {isLink && !project && <p className="sheet__lede">Any site or service you want one click away. It is checked every minute and flagged when it goes down.</p>}
      <label className="field">
        Name
        <input required value={form.name} onChange={set('name')} placeholder={isLink ? 'Router admin' : undefined} />
      </label>
      {isLink && (
        <label className="field">
          URL
          <input required type="url" placeholder="https://example.com" value={form.online_url} onChange={set('online_url')} />
        </label>
      )}
      <label className="field">
        Description
        <textarea rows={2} value={form.description} onChange={set('description')} />
      </label>
      {!isLink && (
        <>
          <label className="field">
            Local URL
            <input type="url" placeholder="http://localhost:5173" value={form.local_url} onChange={set('local_url')} />
          </label>
          <label className="field">
            Live URL
            <input type="url" placeholder="https://example.com" value={form.online_url} onChange={set('online_url')} />
          </label>
          <label className="field">
            Repository URL
            <input type="url" placeholder="https://github.com/you/project" value={form.repo_url} onChange={set('repo_url')} />
          </label>
        </>
      )}
      <label className="field">
        Tags, comma separated
        <input value={form.tags} onChange={set('tags')} />
      </label>
      <label className="field field--check">
        <input type="checkbox" checked={form.pinned} onChange={set('pinned')} /> Keep at the top of the list
      </label>
      {error && <p className="notice signal-text">{error}</p>}
      <div className="sheet__actions" style={{ justifyContent: 'start' }}>
        <button className="btn" type="submit" disabled={saving}>
          {saving ? 'Saving' : project ? 'Save changes' : isLink ? 'Add URL' : 'Add project'}
        </button>
        <button className="btn btn--quiet" type="button" onClick={() => onDone(project?.id)}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function FoldersSheet() {
  const { refreshProjects } = useHub()
  const [roots, setRoots] = useState<ScanRoot[] | null>(null)
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<{ roots: ScanRoot[] }>('roots')
      .then((d) => setRoots(d.roots))
      .catch((err) => setError(`Couldn't load folders: ${err.message}`))
  }, [])

  const change = async (req: Promise<{ roots: ScanRoot[] }>) => {
    setBusy(true)
    setError('')
    try {
      setRoots((await req).roots)
      refreshProjects()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the folders.")
      return false
    } finally {
      setBusy(false)
    }
  }
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (await change(api('roots', { method: 'POST', json: { path } }))) setPath('')
  }

  return (
    <form className="sheet" onSubmit={add}>
      <a className="side__back" href="#/m/projects">
        <Icon name="back" size={18} /> All projects
      </a>
      <header className="sheet__head">
        <h2 className="sheet__title">Scan folders</h2>
      </header>
      <p className="sheet__lede">Every folder inside these is a project. Adding or removing one rescans right away.</p>
      {!roots ? (
        !error && <div className="sheet__empty">Loading…</div>
      ) : (
        <ul className="list">
          {roots.map((r) => (
            <li className="row" key={r.path}>
              <Icon name="folder" size={20} />
              <span className="row__main mono">
                <Secret label="Path">{r.path}</Secret>
                <span className={`row__sub${r.found ? '' : ' signal-text'}`}>
                  {r.found ? `${r.projects} ${r.projects === 1 ? 'project' : 'projects'}` : 'Not found on this machine'}
                  {r.source === 'env' && ' · set in .env'}
                </span>
              </span>
              {r.found && <OpenFolder path={r.path} />}
              {r.id != null && (
                <ConfirmButton onConfirm={() => change(api(`roots/${r.id}`, { method: 'DELETE' })).then(() => {})} confirmLabel="Confirm remove" disabled={busy}>
                  Remove
                </ConfirmButton>
              )}
            </li>
          ))}
        </ul>
      )}
      <label className="field">
        Add a folder
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/me/code" spellCheck={false} autoCapitalize="off" autoCorrect="off" required />
      </label>
      {error && <p className="notice signal-text">{error}</p>}
      <div className="sheet__actions" style={{ justifyContent: 'start' }}>
        <button className="btn" type="submit" disabled={busy || !path.trim()}>
          {busy ? 'Scanning' : 'Add and scan'}
        </button>
      </div>
      <p className="sheet__lede">
        Removing a folder drops its projects, except ones you edited or pinned. Running in Docker? Marumado only sees folders mounted into it: list them in <span className="mono">MARUMADO_PROJECT_DIRS</span> or <span className="mono">MARUMADO_MOUNTS</span> in .env, then <span className="mono">make up</span>.
      </p>
    </form>
  )
}
