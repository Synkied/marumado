import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { inDesktop } from './lib/desktop'
import { HubProvider } from './lib/hub'
import { MachinesProvider } from './lib/machines'
import { StreamingProvider } from './lib/streaming'
import { AgentCard } from './modules/agentCard'
import './index.css'

createRoot(document.getElementById('root')!).render(
  // The desktop app's card window shows the agents' card alone.
  inDesktop && window.location.hash.startsWith('#/card') ? (
    <StrictMode>
      <AgentCard />
    </StrictMode>
  ) : (
    <StrictMode>
      <StreamingProvider>
        <MachinesProvider>
          {/* Switching machines starts every module afresh, so nothing from the last machine lingers. */}
          {(machine) => (
            <HubProvider key={machine}>
              <App />
            </HubProvider>
          )}
        </MachinesProvider>
      </StreamingProvider>
    </StrictMode>
  ),
)
