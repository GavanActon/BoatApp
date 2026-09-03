import { useAppStore } from '../state/appStore'
import { useGpsStore } from '../tracking/gpsStore'
import { useRouteStore } from '../routing/routeStore'
import { endTrip, startTrip } from '../routing/planner'
import { fetchCircle, parseJoinCode, postBoat, removeBoat, type OwnRecord } from './api'
import { useCircleStore, type BoatTrip, type Circle } from './store'

/**
 * The circle's two clocks.
 *
 * Reading: while the app is visible and online and any circle exists,
 * every circle is fetched once a minute (and at once on becoming visible
 * or coming back online). Friends' records land in the store; the chart
 * layer and the Boats out list read from there.
 *
 * Writing: while THIS trip is being shared, the boat's record goes to every
 * circle every two minutes, and immediately on the moments that matter —
 * cast-off, the arrival latch, the ride-home flip, the end of the trip
 * (a final "home", then sharing switches itself off). Offline, the post
 * simply fails and the next tick tries again; the server keeps only the
 * latest record, so there is nothing to queue.
 */

const POLL_MS = 60_000
const POST_MS = 2 * 60_000
const LISTENERS = new Set<() => void>()

/** Run `cb` after every successful poll. */
export function onCirclePoll(cb: () => void): () => void {
  LISTENERS.add(cb)
  return () => LISTENERS.delete(cb)
}

function visibleOnline(): boolean {
  return document.visibilityState === 'visible' && useAppStore.getState().online
}

let polling: Promise<void> | null = null

/** Fetch every circle now (deduped while one is in flight). */
export function pollCircles(): Promise<void> {
  polling ??= (async () => {
    const s = useCircleStore.getState()
    if (!s.circles.length) return
    let failed: string | null = null
    for (const c of s.circles) {
      try {
        const r = await fetchCircle(c)
        useCircleStore.getState().setBoats(c.id, r.boats)
      } catch (e) {
        failed = e instanceof Error ? e.message : String(e)
      }
    }
    if (failed) useCircleStore.getState().setFetchError(failed)
    for (const cb of LISTENERS) cb()
  })().finally(() => {
    polling = null
  })
  return polling
}

/** This boat's trip, as the circle should see it — or null when just out. */
function ownTrip(): BoatTrip | null {
  const rs = useRouteStore.getState()
  if (rs.tripStartedAt == null || !rs.destination || !rs.plan) return null
  const headingHome = rs.plan.destName === 'Home'
  const state = headingHome ? 'heading-home' : rs.reachedDestAt != null ? 'there' : 'coming'
  // the plan's samples run along the plotted course — few enough to send,
  // enough to draw a line toward the spot
  const route = rs.plan.samples.map((p) => [p.lon, p.lat] as [number, number])
  return {
    dest: headingHome
      ? rs.tripOrigin
        ? { name: 'Home', lon: rs.tripOrigin[0], lat: rs.tripOrigin[1] }
        : null
      : { name: rs.destination.name, lon: rs.destination.lon, lat: rs.destination.lat },
    etaMs: rs.plan.arriveMs,
    homeMs: rs.plan.homeMs,
    sinceMs: rs.reachedDestAt,
    state,
    route: route.length >= 2 ? route : null,
  }
}

function ownRecord(trip: BoatTrip | null): OwnRecord | null {
  const fix = useGpsStore.getState().fix
  if (!fix) return null
  const s = useCircleStore.getState()
  return {
    deviceId: s.deviceId,
    deviceKey: s.deviceKey,
    name: s.skipper.name.trim() || 'A boat',
    boat: s.skipper.boat.trim(),
    fix: { lon: fix.lon, lat: fix.lat, sogKn: fix.sogKn, cog: fix.cog, ts: fix.ts },
    trip,
  }
}

let posting = false

/** Post this boat to every circle now, if sharing and there is a fix. */
export async function postNow(override?: { trip: BoatTrip | null }): Promise<void> {
  const s = useCircleStore.getState()
  if (!s.sharing || !s.circles.length || posting) return
  const rec = ownRecord(override ? override.trip : ownTrip())
  if (!rec) return
  posting = true
  try {
    await Promise.all(s.circles.map((c) => postBoat(c, rec).catch(() => undefined)))
  } finally {
    posting = false
  }
}

/** Stop showing this trip: a last "home" record, then sharing goes off.
 *  Called by the trip's end and by the card's "stop". */
export async function stopSharing(): Promise<void> {
  const s = useCircleStore.getState()
  if (!s.sharing) return
  await postNow({ trip: { dest: null, etaMs: null, homeMs: null, sinceMs: null, state: 'home', route: null } })
  s.setSharing(false)
}

/** Leave a circle: the secret goes, and so does this boat's record there. */
export async function leaveCircle(c: Circle): Promise<void> {
  const s = useCircleStore.getState()
  await removeBoat(c, s.deviceId, s.deviceKey).catch(() => undefined)
  s.removeCircle(c.id)
}

/** Join by code or link: the server confirms the secret and names the
 *  circle. Throws with a plain reason when it doesn't. */
export async function joinCircle(codeOrLink: string): Promise<Circle> {
  const parsed = parseJoinCode(codeOrLink)
  if (!parsed) throw new Error('That is not a circle code. It looks like ABCDEF-K7M2P9Q4RTW3.')
  const probe: Circle = { id: parsed.id, secret: parsed.secret, name: '' }
  const r = await fetchCircle(probe)
  const c = { ...probe, name: r.name }
  useCircleStore.getState().addCircle(c)
  useCircleStore.getState().setBoats(c.id, r.boats)
  for (const cb of LISTENERS) cb()
  return c
}

let inited = false

/** Call once at startup. */
export function initCircle() {
  if (inited) return
  inited = true
  if (import.meta.env.DEV) {
    // the verify harness drives two "phones" through the same doors the app uses
    ;(window as unknown as Record<string, unknown>).__circle = {
      store: useCircleStore,
      postNow,
      pollCircles,
      stopSharing,
      startTrip,
      endTrip,
    }
  }

  // an invite link opened in a browser that shares the app's storage
  // (Android, desktop) joins on the spot; the hash is consumed either way
  const m = /#join=([A-Za-z0-9]{6})[.-]([A-Za-z0-9]{12})/.exec(location.hash)
  if (m) {
    history.replaceState(null, '', location.pathname + location.search)
    void joinCircle(`${m[1]}-${m[2]}`)
      .then(() => useAppStore.getState().setSheetTab('places'))
      .catch(() => undefined)
  }

  if (visibleOnline()) void pollCircles()
  setInterval(() => {
    if (visibleOnline()) void pollCircles()
  }, POLL_MS)
  setInterval(() => {
    if (visibleOnline()) void postNow()
  }, POST_MS)
  document.addEventListener('visibilitychange', () => {
    if (visibleOnline()) {
      void pollCircles()
      void postNow()
    }
  })
  window.addEventListener('online', () => {
    void pollCircles()
    void postNow()
  })

  // the moments that matter post at once; the end of the trip posts "home"
  // and turns sharing off, so nobody is tracked back on the trailer
  useRouteStore.subscribe((s, prev) => {
    if (s.tripStartedAt !== prev.tripStartedAt) {
      if (s.tripStartedAt != null) void postNow()
      else void stopSharing()
      return
    }
    if (s.reachedDestAt !== prev.reachedDestAt || s.plan?.destName !== prev.plan?.destName) {
      void postNow()
    }
  })
  useCircleStore.subscribe((s, prev) => {
    if (s.sharing && !prev.sharing) void postNow()
    if (s.circles.length !== prev.circles.length) void pollCircles()
  })
}
