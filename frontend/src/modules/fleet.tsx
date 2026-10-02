import { useState } from 'react'
import { Icon } from '../components/Icon'
import { duration } from '../lib/format'
import { issueHref, machineIssues, useHub } from '../lib/hub'
import { useFolds, useReadouts, type Readouts } from '../lib/fleet'
import { useMachines } from '../lib/machines'
import { go } from '../lib/route'
import { useRedact, useStreaming } from '../lib/streaming'
import type { Machine } from '../lib/types'
import { RetryButton } from './machines'
import { READOUTS, readout, type Reading, type Readout, type ReadoutId } from './readouts'
import './fleet.css'

type Problem = { id: string; module: string; title: string; detail: string; href: string }

/** Home: every machine as a block of readings, the ones that need you first. Each reading opens its module on that
    machine. The readings wrap onto as many lines as they need, and every block shares the same columns, so the same
    reading sits in the same place on every machine. Which readings a machine shows is set per machine. */
export function Fleet() {
  const { machines, current, select } = useMachines()
  const { alerts, error } = useHub()
  const readouts = useReadouts()
  const [fold, setFold] = useFolds()
  const [arranging, setArranging] = useState<Machine['id'] | null>(null)

  if (!machines) {
    return (
      <div className="fleet">
        {error ? (
          <p className="notice">
            <strong>The Marumado backend isn’t answering.</strong> Start it with <span className="mono">uv run python manage.py serve</span> in{' '}
            <span className="mono">backend/</span>, then this page reconnects by itself.
          </p>
        ) : (
          <div className="sheet__empty">Loading…</div>
        )}
      </div>
    )
  }

  // Show a module of a machine: switch every module to that machine, then open it.
  const open = (m: Machine, href: string) => {
    if (m.id !== current) select(m.id)
    go(href)
  }

  // The machine on screen has the full alerts; the others, what their digest says.
  const problemsOf = (m: Machine): Problem[] =>
    m.id === current
      ? alerts.filter((a) => a.module !== 'machines').map((a) => ({ id: a.id, module: a.module, title: a.title, detail: a.detail, href: a.href }))
      : machineIssues(m).map((i) => ({ id: i.id, module: i.module, title: i.title, detail: i.detail, href: issueHref(i.module, i.id) }))

  const rows = machines.map((m) => ({ m, problems: problemsOf(m) }))
  const needs = (r: (typeof rows)[number]) => r.m.state === 'down' || r.problems.length > 0
  // What needs you rises to the top; otherwise this machine first, then the rest by name (as the API lists them).
  const sorted = [...rows.filter(needs), ...rows.filter((r) => !needs(r))]

  return (
    <div className="fleet">
      <ul className="fleet__machines">
        {sorted.map(({ m, problems }) => (
          <MachineBlock
            key={m.id}
            machine={m}
            viewing={m.id === current}
            problems={problems}
            readouts={readouts}
            allIds={machines.map((x) => x.id)}
            // Something that needs you is always open; otherwise this machine is, unless folded by hand.
            open={problems.length > 0 || (fold(m.id) ?? (m.id === current || machines.length === 1))}
            canFold={problems.length === 0 && m.state !== 'down'}
            onFold={(o) => setFold(m.id, o)}
            arranging={arranging === m.id}
            onArrange={(on) => setArranging(on ? m.id : null)}
            go={(href) => open(m, href)}
          />
        ))}
      </ul>
      <p className="fleet__foot">
        <a className="btn btn--quiet" href="#/m/machines/new">
          <Icon name="plus" size={18} /> Add machine
        </a>
      </p>
    </div>
  )
}

type BlockProps = {
  machine: Machine
  viewing: boolean
  problems: Problem[]
  readouts: Readouts
  allIds: Machine['id'][]
  open: boolean
  canFold: boolean
  onFold: (open: boolean) => void
  arranging: boolean
  onArrange: (on: boolean) => void
  go: (href: string) => void
}

function MachineBlock({ machine: m, viewing, problems, readouts, allIds, open, canFold, onFold, arranging, onArrange, go }: BlockProps) {
  const streaming = useStreaming().on
  const redact = useRedact()
  const s = m.summary
  const down = m.state === 'down'
  const name = m.local ? (streaming ? 'This machine' : (s?.hostname ?? 'This machine')) : m.name
  const where = m.local ? 'this machine' : streaming ? 'over SSH' : `ssh ${m.ssh_target}`
  const ids = readouts.of(m.id)
  const shown = ids.map((id) => ({ r: readout(id)!, reading: readout(id)!.read(m) }))

  const context =
    m.state === 'connecting'
      ? `${where} · connecting…`
      : down
        ? redact(m.error || 'Unreachable', m.ssh_target)
        : s
          ? `${where} · up ${duration(s.time - s.boot_time)}${viewing && allIds.length > 1 ? ' · on screen' : ''}`
          : `${where} · waiting for its first reading`
  // Folded, the header still says how the machine is: its vitals in one line.
  const vitals = s ? `CPU ${Math.round(s.cpu)}% · RAM ${Math.round(s.memory)}%${s.disk ? ` · disk ${Math.round(s.disk.percent)}%` : ''}` : ''
  const lamp = down || problems.length ? 'fault' : m.state === 'connecting' ? 'wait' : 'ok'
  const status = down ? 'unreachable' : problems.length ? `${problems.length} ${problems.length === 1 ? 'needs' : 'need'} you` : m.state === 'connecting' ? 'connecting' : 'all clear'
  // Problems no reading on the block shows (a local URL, a slipping push…) are listed under it.
  const faulted = new Set(shown.filter((x) => x.reading?.state === 'fault').map((x) => x.r.module))
  const unshown = problems.filter((p) => !faulted.has(p.module as never))

  return (
    <li className={`mblock${down ? ' is-down' : ''}${problems.length ? ' is-fault' : ''}${open ? ' is-open' : ''}`}>
      <header className="mblock__head">
        <span className={`mblock__lamp mblock__lamp--${lamp}`} role="img" aria-label={status} />
        <button className="mblock__name" type="button" onClick={() => go('#/m/machine')} disabled={down} title={`Open ${name}'s machine page`}>
          {name}
        </button>
        <span className={`mblock__context${down ? ' signal-text' : ''}`}>{open || down || !vitals ? context : vitals}</span>
        <span className={`mblock__status${lamp === 'fault' ? ' signal-text' : ''}`}>{status}</span>
        <span className="mblock__actions">
          {down && !m.local && <RetryButton machine={m} />}
          {!down && open && (
            <button
              className={`iconbtn${arranging ? ' is-on' : ''}`}
              type="button"
              onClick={() => onArrange(!arranging)}
              aria-pressed={arranging}
              title={`Choose and order ${name}'s readings`}
            >
              <Icon name="sliders" size={18} />
              <span className="sr-only">Arrange {name}'s readings</span>
            </button>
          )}
          {canFold && (
            <button
              className={`iconbtn mblock__fold${open ? ' is-open' : ''}`}
              type="button"
              onClick={() => {
                onFold(!open)
                if (open) onArrange(false)
              }}
              aria-expanded={open}
              title={open ? `Fold ${name} to one line` : `Show ${name}'s readings`}
            >
              <Icon name="chevron" size={18} />
              <span className="sr-only">{open ? 'Fold' : 'Unfold'}</span>
            </button>
          )}
        </span>
      </header>

      {open && !down && (
        <>
          {arranging ? (
            <ReadoutEditor machine={m} name={name} readouts={readouts} allIds={allIds} onDone={() => onArrange(false)} />
          ) : (
            <div className="readouts">
              {shown.map(({ r, reading }) => (
                <Cell key={r.id} readout={r} reading={reading} pending={m.state !== 'up'} onOpen={() => go(`#/m/${r.module}`)} />
              ))}
            </div>
          )}
          {m.state === 'up' && !m.overview && (
            <p className="mblock__note">{m.local ? 'Reading this machine…' : 'Update the Marumado on this machine to see its agents, projects, URLs and containers here.'}</p>
          )}
          {unshown.length > 0 && (
            <ul className="mblock__issues" aria-label={`Also needs you on ${name}`}>
              {unshown.map((p) => (
                <li key={p.id}>
                  <button className="mblock__issue" type="button" onClick={() => go(p.href)}>
                    <span className="mblock__issue-title">{redact(p.title, m.ssh_target)}</span>
                    <span className="mblock__issue-detail">{redact(p.detail, m.ssh_target)}</span>
                    <Icon name="arrow" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  )
}

function Cell({ readout: { label, module, pen }, reading, pending, onOpen }: { readout: Readout; reading: Reading | null; pending: boolean; onOpen: () => void }) {
  const r = reading ?? { value: '—', detail: pending ? 'waiting' : undefined, state: 'off' as const }
  return (
    <button
      className={`readout readout--${r.state} mod-${pen ?? module}`}
      type="button"
      onClick={onOpen}
      title={r.title ?? `${label}: ${r.value}${r.detail ? ` ${r.detail}` : ''}`}
    >
      <span className="readout__label">{label}</span>
      <Seal seal={r.seal} off={r.state === 'off'} />
      <span className="readout__value">{r.value}</span>
      {r.graphic?.kind === 'trace' ? <Trace values={r.graphic.values} limit={r.graphic.limit} /> : <span className="readout__detail">{r.detail}</span>}
    </button>
  )
}

// The seal's geometry, in its own 40-unit box.
const SC = 20
const SR = 15

const sealPt = (r: number, turn: number) => {
  const a = turn * 2 * Math.PI - Math.PI / 2
  return `${(SC + r * Math.cos(a)).toFixed(2)} ${(SC + r * Math.sin(a)).toFixed(2)}`
}
const sealArc = (from: number, to: number) => `M${sealPt(SR, from)}A${SR} ${SR} 0 ${to - from > 0.5 ? 1 : 0} 1 ${sealPt(SR, to)}`

/** The reading's round window: a small chart in the module's pen, read from twelve o'clock clockwise, like the
    module's disc. A share is one arc with a tick at its budget; parts are one arc per item. */
function Seal({ seal, off }: { seal: Reading['seal']; off: boolean }) {
  let record = null
  if (seal?.kind === 'share') {
    const v = Math.max(0, Math.min(0.9999, seal.value))
    record = (
      <>
        {v > 0.004 && <path className="seal__arc" d={sealArc(0, v)} />}
        {seal.limit != null && <path className="seal__limit" d={`M${sealPt(SR - 5, seal.limit)}L${sealPt(SR + 5, seal.limit)}`} />}
      </>
    )
  } else if (seal?.kind === 'parts') {
    const n = seal.items.length
    const gap = n > 1 ? Math.min(0.03, 0.3 / n) : 0
    record = seal.items.map((part, i) => <path key={i} className={`seal__part seal__part--${part}`} d={sealArc(i / n + gap / 2, n === 1 ? 0.9999 : (i + 1) / n - gap / 2)} />)
  }
  return (
    <svg className={`seal${off ? ' seal--off' : ''}`} viewBox="0 0 40 40" aria-hidden="true">
      <circle className="seal__track" cx={SC} cy={SC} r={SR} />
      {!off && record}
      <circle className="seal__hub" cx={SC} cy={SC} r={2.2} />
    </svg>
  )
}

const TH = 24 // the trace's height in its own units

/** The CPU's last half hour as a pen line, its limit as a faint dashed rule, and a dot where the pen is now. */
function Trace({ values, limit }: { values: (number | null)[]; limit: number }) {
  const n = values.length
  const y = (v: number) => TH - 1 - Math.max(0, Math.min(1, v)) * (TH - 2)
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 100)
  let d = ''
  let pen = false
  values.forEach((v, i) => {
    if (v == null) return void (pen = false)
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(2)} ${y(v).toFixed(2)}`
    pen = true
  })
  const last = values[n - 1]
  return (
    <span className="readout__trace" aria-hidden="true">
      <svg viewBox={`0 0 100 ${TH}`} preserveAspectRatio="none">
        <path className="readout__limit" d={`M0 ${y(limit)}H100`} />
        {n === 1 && last != null ? <path className="readout__pen" d={`M0 ${y(last)}H100`} /> : <path className="readout__pen" d={d} />}
      </svg>
      {last != null && <span className="readout__tip" style={{ top: `${(y(last) / TH) * 100}%` }} />}
    </span>
  )
}

/** Choose a machine's readings and their order. "Use on every machine" copies them, so the blocks line up again. */
function ReadoutEditor({ machine: m, name, readouts, allIds, onDone }: { machine: Machine; name: string; readouts: Readouts; allIds: Machine['id'][]; onDone: () => void }) {
  const ids = readouts.of(m.id)
  const hidden = READOUTS.filter((r) => !ids.includes(r.id))
  const set = (next: ReadoutId[]) => readouts.set(m.id, next)
  const move = (i: number, by: number) => {
    const next = [...ids]
    const j = i + by
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    set(next)
  }
  return (
    <div className="readedit">
      <p className="readedit__lede">What {name}’s block shows, in this order. Other machines keep their own.</p>
      <ol className="list">
        {ids.map((id, i) => {
          const r = readout(id)!
          return (
            <li className="row" key={id}>
              <span className="row__main">
                {r.label}
                <span className="row__sub">{r.blurb}</span>
              </span>
              <span className="row__actions">
                <button className="btn btn--quiet" type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${r.label} earlier`}>
                  Earlier
                </button>
                <button className="btn btn--quiet" type="button" onClick={() => move(i, 1)} disabled={i === ids.length - 1} aria-label={`Move ${r.label} later`}>
                  Later
                </button>
                <button className="btn btn--quiet" type="button" onClick={() => set(ids.filter((x) => x !== id))} disabled={ids.length === 1}>
                  Hide
                </button>
              </span>
            </li>
          )
        })}
        {hidden.map((r) => (
          <li className="row row--muted" key={r.id}>
            <span className="row__main">
              {r.label}
              <span className="row__sub">{r.blurb}</span>
            </span>
            <span className="row__actions">
              <button className="btn" type="button" onClick={() => set([...ids, r.id])}>
                Show
              </button>
            </span>
          </li>
        ))}
      </ol>
      <div className="readedit__actions">
        <button className="btn" type="button" onClick={onDone}>
          Done
        </button>
        {allIds.length > 1 && (
          <button className="btn btn--quiet" type="button" onClick={() => readouts.setAll(allIds, ids)} title="Give every machine these readings in this order, so their blocks line up">
            Use on every machine
          </button>
        )}
        {readouts.custom(m.id) && (
          <button className="btn btn--quiet" type="button" onClick={() => readouts.reset(m.id)}>
            Reset
          </button>
        )}
      </div>
    </div>
  )
}
