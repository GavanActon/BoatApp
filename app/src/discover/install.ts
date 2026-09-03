/**
 * Putting the app on the Home Screen. On iOS it is the ONLY thing that
 * keeps the charts: Safari clears a site's storage — the downloads, the
 * home dock, the crew — after seven days without a visit, and a Home
 * Screen web app is exempt. There is no install button on iOS; the page
 * can only say the two taps. Android and desktop Chrome hand the page a
 * prompt to fire, so there the row is a real Install.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: BeforeInstallPromptEvent | null = null
let installedNow = false
const listeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

/** Re-render hook for whoever shows the row: fires when a prompt arrives or an install lands. */
export function onInstallChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

let inited = false

export function initInstall() {
  if (inited || typeof window === 'undefined') return
  inited = true
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as BeforeInstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    installedNow = true
    deferred = null
    notify()
  })
}

/** Running from the Home Screen (or installed on desktop) — or installed this session. */
export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false
  if (installedNow) return true
  const nav = navigator as Navigator & { standalone?: boolean }
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true
}

/** The browser offered a prompt (Android, desktop Chrome/Edge). */
export function canPromptInstall(): boolean {
  return deferred != null
}

export async function promptInstall(): Promise<boolean> {
  const e = deferred
  if (!e) return false
  deferred = null
  notify()
  try {
    await e.prompt()
    const { outcome } = await e.userChoice
    return outcome === 'accepted'
  } catch {
    return false
  }
}

export type Platform = 'ios-safari' | 'ios-other' | 'android' | 'desktop'

/** Which two taps to describe. iPadOS reports itself as a Mac with touch. */
export function platform(): Platform {
  if (typeof navigator === 'undefined') return 'desktop'
  const ua = navigator.userAgent
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (ios) return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-other' : 'ios-safari'
  if (/Android/.test(ua)) return 'android'
  return 'desktop'
}
