import { useAppStore } from '../state/appStore'
import { pushKey, subscribePush, unsubscribePush } from './api'
import { useCircleStore } from './store'

/**
 * Notifications: the crew's moments (joined · planning · departed · arrived
 * · heading home · home) as Web Push. The Notify switch on the Crew sheet
 * is the gesture the browser needs; joining a crew is one too, so the ask
 * lands there first. iPhone only offers push to the Home Screen app — in a
 * Safari tab there is no Notification API at all, and the row says so.
 */

export type PushState = 'on' | 'off' | 'denied' | 'unsupported'

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/** What the switch should show right now. */
export function pushState(): PushState {
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return Notification.permission === 'granted' && useCircleStore.getState().notify ? 'on' : 'off'
}

function toBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const pad = b64u.length % 4 === 0 ? '' : '='.repeat(4 - (b64u.length % 4))
  const bin = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Ask (a user gesture), subscribe, tell the server. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported'
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') {
    useCircleStore.getState().setNotify(false)
    return perm === 'denied' ? 'denied' : 'off'
  }
  useCircleStore.getState().setNotify(true)
  await syncPush()
  return pushState()
}

/** Stop: the subscription goes on both ends. */
export async function disablePush(): Promise<void> {
  useCircleStore.getState().setNotify(false)
  const s = useCircleStore.getState()
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    await sub?.unsubscribe()
  } catch {
    /* nothing to undo */
  }
  await unsubscribePush(s.deviceId, s.deviceKey).catch(() => undefined)
}

let syncing: Promise<void> | null = null

/** Keep the server's copy current — subscriptions rotate, and a fresh
 *  install has none yet. Quiet: never asks, only acts when allowed. */
export function syncPush(): Promise<void> {
  syncing ??= (async () => {
    const s = useCircleStore.getState()
    if (!pushSupported() || !s.notify || Notification.permission !== 'granted' || !useAppStore.getState().online) return
    try {
      const reg = await navigator.serviceWorker.ready
      let sub = await reg.pushManager.getSubscription()
      if (!sub) {
        const key = await pushKey()
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(key) })
      }
      const j = sub.toJSON()
      await subscribePush(s.deviceId, s.deviceKey, {
        endpoint: j.endpoint ?? '',
        keys: { p256dh: j.keys?.p256dh ?? '', auth: j.keys?.auth ?? '' },
      })
    } catch {
      /* next launch tries again */
    }
  })().finally(() => {
    syncing = null
  })
  return syncing
}
