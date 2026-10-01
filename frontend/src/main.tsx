import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { HubProvider } from './lib/hub'
import { MachinesProvider } from './lib/machines'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MachinesProvider>
      {/* Switching machines starts every module afresh, so nothing from the last machine lingers. */}
      {(machine) => (
        <HubProvider key={machine}>
          <App />
        </HubProvider>
      )}
    </MachinesProvider>
  </StrictMode>,
)
