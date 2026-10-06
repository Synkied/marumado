import { useState } from 'react'
import { ConfirmButton } from '../components/ConfirmButton'
import { Icon } from '../components/Icon'
import { UsageLine } from '../components/UsageLine'
import { api } from '../lib/api'
import { useHub } from '../lib/hub'
import type { TaskDetail, TaskWork } from '../lib/types'
import { usePoll } from '../lib/usePoll'
import './agentChanges.css'
import './taskWork.css'

type Diff = { path: string; diff: string; truncated: boolean }

const STATUS_WORD: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', '?': 'New' }
const STATUS_DATA: Record<string, string> = { A: 'added', D: 'deleted', R: 'renamed', '?': 'new' }

const CHECK_WORDS: Record<string, string> = {
  running: 'Its plan’s check is running.',
  passed: 'Its plan’s check passed.',
  failed: 'Its plan’s check failed: the steps under it wait.',
  fixing: 'Its plan’s check failed: the agent is fixing what it reported.',
  skipped: 'It finished before its plan had a check: not checked.',
}

/** The agent's work on a task, to review and land: its commits and changed files with their diffs, and what can be done
    with it (merge its branch, open a pull request, send it back with what to change, or discard it). */
export function TaskWorkView({ task, refresh }: { task: TaskDetail; refresh: () => void }) {
  const { agents, refreshTasks } = useHub()
  const work = usePoll<TaskWork>(`tasks/${task.id}/work`, 10_000)
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [said, setSaid] = useState('')
  const [cleanUp, setCleanUp] = useState(true)
  const [note, setNote] = useState('')
  const control = (agents?.terminal ?? 'control') === 'control'

  const w = work.data
  const files = w?.files ?? []
  const selected = files.some((f) => f.path === picked) ? picked : (files[0]?.path ?? '')
  const file = files.find((f) => f.path === selected)
  const diff = usePoll<Diff>(selected ? `tasks/${task.id}/work?path=${encodeURIComponent(selected)}` : null, 30_000)
  const content = diff.data?.path === selected ? diff.data : undefined

  const act = async (path: string, json: object = {}, failed = "Couldn't do that.") => {
    setBusy(true)
    setError('')
    setSaid('')
    try {
      const done = await api<{ said?: string }>(`tasks/${task.id}/${path}`, { method: 'POST', json })
      if (done?.said) setSaid(done.said)
      refresh()
      refreshTasks()
      void work.refresh()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : failed)
      return false
    } finally {
      setBusy(false)
    }
  }
  const sendBack = async () => {
    if (await act('feedback', { text: note }, "Couldn't send it.")) setNote('')
  }

  const finished = task.state === 'review' || task.state === 'done' || task.state === 'failed'
  const branch = w?.kind === 'branch'
  const landable = branch && w.exists && !task.landed && finished && control

  return (
    <div className="taskwork">
      {task.check_state && CHECK_WORDS[task.check_state] && (
        <p className={`notice${task.check_state === 'failed' ? ' notice--fault' : ''}`}>
          {CHECK_WORDS[task.check_state]}
          {task.check_tries > 0 && ` Sent back ${task.check_tries} time${task.check_tries === 1 ? '' : 's'}.`} Its output is in History.{' '}
          {task.check_state === 'failed' && (
            <button className="btn btn--quiet" type="button" disabled={busy || !control} onClick={() => act('check', {}, "Couldn't run it.")}>
              Run the check again
            </button>
          )}
        </p>
      )}
      {said && <p className="notice">{said}</p>}
      {error && <p className="notice signal-text taskwork__error">{error}</p>}

      <section className="sheet__section">
        <h3>The work</h3>
        {work.error && !w && <p className="notice signal-text">Couldn’t read it: {work.error.message}</p>}
        {!w ? (
          !work.error && <p className="sheet__lede">Reading the repository…</p>
        ) : w.reason ? (
          <p className="sheet__lede">{w.reason}</p>
        ) : (
          <>
            <p className="sheet__lede taskwork__summary">
              {branch ? (
                <>
                  On its own branch <code>{w.branch}</code>
                  {task.landed === 'merged' ? <>, merged into <code>{w.into || 'the project'}</code>.</> : (
                    <>
                      : {w.ahead} commit{w.ahead === 1 ? '' : 's'} to go into <code>{w.into || 'the project’s branch'}</code>
                      {w.behind > 0 && <>, which has moved on by {w.behind} since</>}.
                    </>
                  )}
                </>
              ) : (
                <>In the project’s folder{w.into && <> on <code>{w.into}</code></>}: what changed there since it got the task, committed or not.</>
              )}
            </p>
            {w.commits.length > 0 && (
              <ul className="tlog__files taskwork__commits">
                {w.commits.map((c) => (
                  <li key={c.sha}>
                    <span className="tlog__sha">{c.sha}</span> {c.subject}
                  </li>
                ))}
              </ul>
            )}
            {task.usage && task.usage.calls > 0 && <UsageLine usage={task.usage} className="taskwork__usage" />}
          </>
        )}
      </section>

      {branch && w?.exists && !task.landed && (
        <section className="sheet__section">
          <h3>Land it</h3>
          {!finished && <p className="sheet__lede">Its agent is still at work: this waits for it to finish its turn.</p>}
          <div className="sheet__actions taskwork__actions">
            <button className="btn" type="button" disabled={busy || !landable || w.ahead === 0} onClick={() => act('merge', { clean_up: cleanUp }, "Couldn't merge it.")}>
              <Icon name="join" size={16} /> Merge into {w.into || 'the project'}
            </button>
            {task.pr_url ? (
              <a className="btn btn--quiet" href={task.pr_url} target="_blank" rel="noreferrer">
                Open its pull request
              </a>
            ) : (
              <button className="btn btn--quiet" type="button" disabled={busy || !landable || w.ahead === 0} onClick={() => act('pr', {}, "Couldn't open a pull request.")} title="Pushes the branch and opens a pull request with the GitHub CLI, where the agent runs">
                Open a pull request
              </button>
            )}
            <ConfirmButton onConfirm={() => void act('discard', {}, "Couldn't discard it.")} confirmLabel="Delete its branch and worktree" disabled={busy || !landable}
              title="Deletes its branch and worktree and closes its agent; the task goes back to To do">
              <Icon name="trash" size={16} /> Discard
            </ConfirmButton>
          </div>
          <label className="field field--check">
            <input type="checkbox" checked={cleanUp} onChange={(e) => setCleanUp(e.target.checked)} disabled={busy} />
            Once merged, remove its worktree and branch (and close its agent)
          </label>
        </section>
      )}

      {w && !w.reason && (files.length ? (
        <section className="taskwork__files" aria-label="Files changed">
          <div className="changes__layout taskwork__layout">
            <nav className="changes__nav" aria-label="Changed files">
              <ul className="changes__tree">
                {files.map((f) => (
                  <li key={f.path}>
                    <button type="button" className="changes__file" data-status={STATUS_DATA[f.status] ?? 'modified'} aria-pressed={selected === f.path} onClick={() => setPicked(f.path)} title={f.path}>
                      <span className="changes__filename">{f.path}</span>
                      <span className="taskwork__counts" aria-label={`${f.add} lines added, ${f.del} removed`}>
                        {f.add > 0 && <span className="changes__added">+{f.add}</span>}
                        {f.del > 0 && <span className="changes__removed">−{f.del}</span>}
                      </span>
                    </button>
                  </li>
                ))}
                {(w.file_count ?? 0) > files.length && <li className="taskwork__more">and {(w.file_count ?? 0) - files.length} more</li>}
              </ul>
            </nav>
            <section className="changes__detail" aria-label="File changes">
              <header className="changes__detail-head">
                <strong>{selected}</strong>
                <span>{file && (STATUS_WORD[file.status] ?? file.status)}</span>
                {file?.original && <span>from {file.original}</span>}
              </header>
              {diff.error ? (
                <p className="notice signal-text">Couldn’t read this diff: {diff.error.message}</p>
              ) : !content ? (
                <p className="notice" role="status">Loading diff…</p>
              ) : content.diff ? (
                <>
                  {content.truncated && <p className="notice">Showing the first 256 KB of this diff.</p>}
                  <pre className="changes__diff" tabIndex={0} aria-label={`Diff for ${selected}`}>
                    <code>
                      {content.diff.split('\n').map((line, i) => (
                        <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'changes__added' : line.startsWith('-') && !line.startsWith('---') ? 'changes__removed' : line.startsWith('@@') ? 'changes__hunk' : undefined}>
                          {line}
                          {'\n'}
                        </span>
                      ))}
                    </code>
                  </pre>
                </>
              ) : (
                <p className="notice">No text diff: a binary file, an empty one, or only its mode changed.</p>
              )}
            </section>
          </div>
        </section>
      ) : (
        <p className="sheet__lede">{branch ? 'Nothing on its branch that isn’t in the project already.' : 'Nothing changed in the project’s folder.'}</p>
      ))}

      {task.live && finished && !task.landed && (
        <section className="sheet__section">
          <h3>Send it back</h3>
          <p className="sheet__lede">Tell {task.agent_name || 'the agent'} what to change. It works on it again, in its own context; the task is to review again once it finishes{task.plan != null ? ', and checked again' : ''}.</p>
          <label className="field">
            What to change
            <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Rename the endpoint, and add a test for the empty case." disabled={busy || !control} />
          </label>
          <div className="sheet__actions" style={{ justifyContent: 'start' }}>
            <button className="btn" type="button" disabled={busy || !note.trim() || !control} onClick={sendBack}>
              Send back
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
