import { Icon } from '../components/Icon'
import { Meter } from '../components/Meter'
import { duration } from '../lib/format'
import { CPU_BUDGET, DISK_BUDGET, MEM_BUDGET, machineIssues, useHub, type ModuleId } from '../lib/hub'
import { useMachines } from '../lib/machines'
import { useRedact, useStreaming } from '../lib/streaming'
import { go } from '../lib/route'
import type { Machine } from '../lib/types'
import { RetryButton } from './machines'

type Problem = { id: string; title: string; detail: string; href: string }

/** The home view: every machine side by side, with what is running on it and what needs you there. */
export function OverviewSheet() {
  const { machines, current, select } = useMachines()
  const { alerts, error } = useHub()

  // Show a module of a machine: switch every module to that machine, then open it.
  const open = (m: Machine, href: string) => {
    if (m.id !== current) select(m.id)
    go(href)
  }

  return (
    <div className="sheet">
      <header className="sheet__head">
        <h2 className="sheet__title">Overview</h2>
        <div className="sheet__actions">
          <a className="btn btn--quiet" href="#/m/machines/new">
            <Icon name="plus" size={18} /> Add machine
          </a>
        </div>
      </header>
      <p className="sheet__lede">
        {machines && machines.length > 1 ? 'Every machine at a glance.' : 'This machine at a glance. Add your other machines to see them here too.'} Choose a
        reading to open it on that machine.
      </p>
      {!machines && error ? (
        <p className="notice">
          <strong>The Marumado backend isn’t answering.</strong> Start it with <span className="mono">uv run python manage.py serve</span> in{' '}
          <span className="mono">backend/</span>, then this page reconnects by itself.
        </p>
      ) : !machines ? (
        <div className="sheet__empty">Loading…</div>
      ) : (
        <ul className="mcards">
          {machines.map((m) => {
            // The machine on screen has the full alerts; the others, what their digest says.
            const problems: Problem[] =
              m.id === current
                ? alerts
                    .filter((a) => a.module !== 'machines')
                    .map((a) => ({
                      id: a.id,
                      title: a.title,
                      detail: a.detail,
                      href: a.href,
                    }))
                : machineIssues(m).map((i) => ({
                    id: i.id,
                    title: i.title,
                    detail: i.detail,
                    href: issueHref(i.module, i.id),
                  }))
            return <MachineCard key={m.id} machine={m} viewing={m.id === current} problems={problems} open={(href) => open(m, href)} />
          })}
        </ul>
      )}
    </div>
  )
}

function issueHref(module: ModuleId, id: string): string {
  return id.startsWith('agent:') ? `#/m/agents/${id.slice(6)}` : `#/m/${module}`
}

function Gauge({ label, percent, budget, title }: { label: string; percent: number; budget: number; title?: string }) {
  const hot = percent >= budget
  return (
    <span className="mcard__gauge" title={title}>
      <span className="mcard__key">{label}</span>
      <Meter percent={percent} budget={budget} label={label} />
      <span className={`mcard__value${hot ? ' signal-text' : ''}`}>{Math.round(percent)}%</span>
    </span>
  )
}

type Count = {
  id: ModuleId
  label: string
  value: string
  fault?: string
  off?: boolean
}

function counts(m: Machine): Count[] {
  const o = m.overview
  if (!o) return []
  const waiting = o.agents.blocked.length
  return [
    o.agents.available
      ? {
          id: 'agents',
          label: 'Agents',
          value: o.agents.total ? `${o.agents.working} of ${o.agents.total} working` : 'none running',
          fault: waiting ? `${waiting} waiting` : undefined,
        }
      : {
          id: 'agents',
          label: 'Agents',
          value: 'Herdr not running',
          off: true,
        },
    {
      id: 'projects',
      label: 'Projects',
      value: `${o.projects.running} of ${o.projects.total} running`,
    },
    o.urls.checked
      ? {
          id: 'urls',
          label: 'URLs',
          value: `${o.urls.up} of ${o.urls.checked} up`,
          fault: o.urls.down.length ? `${o.urls.down.length} down` : undefined,
        }
      : { id: 'urls', label: 'URLs', value: 'no live URLs yet', off: true },
    o.docker.available
      ? {
          id: 'docker',
          label: 'Docker',
          value: `${o.docker.running} of ${o.docker.total} running`,
          fault: o.docker.unhealthy.length ? `${o.docker.unhealthy.length} unhealthy` : undefined,
        }
      : { id: 'docker', label: 'Docker', value: 'not available', off: true },
    { id: 'ports', label: 'Ports', value: `${o.ports} listening` },
  ]
}

function MachineCard({ machine: m, viewing, problems, open }: { machine: Machine; viewing: boolean; problems: Problem[]; open: (href: string) => void }) {
  const s = m.summary
  const down = m.state === 'down'
  const streaming = useStreaming().on
  const redact = useRedact()
  const name = m.local ? (streaming ? 'This machine' : (s?.hostname ?? 'This machine')) : m.name
  const where = m.local ? 'This machine' : streaming ? 'over SSH' : `via ${m.ssh_target}`
  const sub =
    m.state === 'connecting'
      ? streaming
        ? 'Connecting over SSH…'
        : `Connecting over SSH to ${m.ssh_target}…`
      : down
        ? redact(m.error || 'Unreachable', m.ssh_target)
        : s
          ? `${where} · ${s.os} · ${s.cores} cores · up ${duration(s.time - s.boot_time)}`
          : 'Reachable, waiting for its first reading'
  const rows = counts(m)

  return (
    <li className={`mcard${down ? ' is-fault' : ''}${viewing ? ' is-viewing' : ''}`}>
      <header className="mcard__head">
        <span
          className={`row__lamp${m.state === 'up' ? ' row__lamp--on' : down ? ' row__lamp--fault' : ''}`}
          role="img"
          aria-label={m.state === 'up' ? 'reachable' : down ? 'unreachable' : 'connecting'}
        />
        <h3 className="mcard__name">{name}</h3>
        {viewing ? (
          <span className="mcard__tag" title="Every module shows this machine">
            On screen
          </span>
        ) : (
          !down && (
            <button className="btn btn--quiet" type="button" onClick={() => open('#/m/machine')} aria-label={`View ${name}`}>
              View
            </button>
          )
        )}
        {down && !m.local && <RetryButton machine={m} />}
      </header>
      <p className={`mcard__sub${down ? ' signal-text' : ''}`}>{sub}</p>

      {s && (
        <button className="mcard__vitals" type="button" onClick={() => open('#/m/machine')} title={`Open ${name}'s machine details`}>
          <Gauge label="CPU" percent={s.cpu} budget={CPU_BUDGET} title={`Load ${s.load.map((l) => l.toFixed(2)).join(' ')}`} />
          <Gauge label="RAM" percent={s.memory} budget={MEM_BUDGET} />
          {s.disk && <Gauge label="Disk" percent={s.disk.percent} budget={DISK_BUDGET} title={streaming ? undefined : `Fullest disk: ${s.disk.mount}`} />}
        </button>
      )}

      {rows.length > 0 && (
        <ul className="mcard__counts">
          {rows.map((r) => (
            <li key={r.id}>
              <button className={`mcard__count mod-${r.id}${r.off ? ' is-off' : ''}`} type="button" onClick={() => open(`#/m/${r.id}`)}>
                <span className="mcard__key">{r.label}</span>
                <span className="mcard__reading">
                  {r.value}
                  {r.fault && <span className="signal-text"> · {r.fault}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {m.state === 'up' && !m.overview && (
        <p className="mcard__note">
          {m.local ? 'Reading this machine…' : 'Update the Marumado on this machine to see its agents, projects, URLs and containers here.'}
        </p>
      )}

      {problems.length > 0 && (
        <ul className="mcard__issues" aria-label={`Needs you on ${name}`}>
          {problems.map((p) => (
            <li key={p.id}>
              <button className="mcard__issue" type="button" onClick={() => open(p.href)}>
                <span className="row__lamp row__lamp--fault" aria-hidden="true" />
                <span className="mcard__issue-text">
                  {redact(p.title, m.ssh_target)}
                  <span className="row__sub">{redact(p.detail, m.ssh_target)}</span>
                </span>
                <Icon name="arrow" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
