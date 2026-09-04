import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { installErrorLog } from './diagnostics'
import { initDevLog } from './devlog'
import './theme.css'
import './ui.css'

initDevLog()
installErrorLog() // before anything can throw — the report wants the first error, not the last
registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
