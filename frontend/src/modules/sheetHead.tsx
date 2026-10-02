import type { ReactNode } from 'react'
import type { ModuleId } from '../lib/hub'
import { meta } from './registry'

export function SheetHead({ id, children }: { id: ModuleId; children?: ReactNode }) {
  return (
    <header className={`sheet__head mod-${id}`}>
      <h2 className="sheet__title">{meta(id).label}</h2>
      {children && <div className="sheet__actions">{children}</div>}
    </header>
  )
}
