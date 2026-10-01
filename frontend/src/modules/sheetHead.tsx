import type { ReactNode } from 'react'
import type { ModuleId } from '../lib/hub'
import { MODULES, meta } from './registry'

export function SheetHead({ id, children }: { id: ModuleId; children?: ReactNode }) {
  const index = String(MODULES.findIndex((m) => m.id === id) + 1).padStart(2, '0')
  return (
    <header className={`sheet__head mod-${id}`}>
      <div>
        <span className="sheet__index">{index}</span>
        <h2 className="sheet__title">{meta(id).label}</h2>
      </div>
      {children && <div className="sheet__actions">{children}</div>}
    </header>
  )
}
