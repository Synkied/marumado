import { apisFor } from '../lib/agents'
import { useHub } from '../lib/hub'

/** Which model a new `kind` agent uses: its own login, or a model API added under Agents → Sources. Nothing when that
    kind can't be pointed at one, or none were added. `value`: the API's id, null for its own login. */
export function ModelApiPick({
  kind,
  value,
  onChange,
  id,
  className,
  disabled,
}: {
  kind: string
  value: number | null
  onChange: (api: number | null) => void
  id?: string
  className?: string
  disabled?: boolean
}) {
  const { agents } = useHub()
  const apis = apisFor(agents, kind)
  if (!apis.length) return null
  return (
    <select id={id} className={className} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} disabled={disabled}>
      <option value="">its own login</option>
      {apis.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
          {a.model ? ` · ${a.model}` : ''}
        </option>
      ))}
    </select>
  )
}
