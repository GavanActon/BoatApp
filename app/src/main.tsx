import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { installErrorLog } from './diagnostics'
import { devlog, initDevLog } from './devlog'
import { useRouteStore } from './routing/routeStore'
import { useGpsStore } from './tracking/gpsStore'
import './theme.css'
import './ui.css'

initDevLog()
installErrorLog() // before anything can throw — the report wants the first error, not the last

// A new build installs in the background and WAITS (registerType 'prompt');
// this is where it is let in. Found in the first moments of a launch, before
// the chart has been built, switching costs almost nothing — take it. Found
// on coming back to the app with nothing under way, take it too: a reload
// there is what iOS does to a PWA on its own. Otherwise it waits for the
// next launch, or the next idle resume. Never mid-trip, never mid-recording:
// a reload then would cut the track and drop the wake lock.
const EARLY_MS = 1500
const bootedAt = performance.now()
let resumedAt = 0
let pending = false
let registration: ServiceWorkerRegistration | null = null
const idle = () => useRouteStore.getState().tripStartedAt == null && !useGpsStore.getState().recording
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW: (_url, reg) => {
    registration = reg ?? null
  },
  onNeedRefresh: () => {
    const now = performance.now()
    if ((now - bootedAt < EARLY_MS || now - resumedAt < 5000) && idle()) {
      devlog('sw', 'new build · switching now')
      void updateSW() // the page reloads once the new worker is in control
    } else {
      pending = true
      devlog('sw', 'new build waiting for the next launch')
    }
  },
})
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  resumedAt = performance.now()
  if (pending && idle()) {
    devlog('sw', 'new build · switching on resume')
    void updateSW()
    return
  }
  // a deploy while the app slept: ask; a find lands in onNeedRefresh above
  void registration?.update().catch(() => {})
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
