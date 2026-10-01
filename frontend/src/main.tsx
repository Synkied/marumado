import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { HubProvider } from './lib/hub'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HubProvider>
      <App />
    </HubProvider>
  </StrictMode>,
)
