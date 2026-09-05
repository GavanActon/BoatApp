import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { installErrorLog } from './diagnostics'
import { devlog, initDevLog } from './devlog'
import './theme.css'
import './ui.css'

initDevLog()
installErrorLog() // before anything can throw — the report wants the first error, not the last
registerSW({
  immediate: true,
  // never called back into: the waiting worker activates on its own once
  // this page is gone, so the next launch is the new build — logged so an
  // uploaded report can say a newer build was waiting
  onNeedRefresh: () => devlog('sw', 'new build waiting for the next launch'),
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
