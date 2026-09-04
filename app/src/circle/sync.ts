import { useDiscoverStore } from '../discover/store'
import { useAppStore } from '../state/appStore'
import { useGpsStore } from '../tracking/gpsStore'
import { useRouteStore } from '../routing/routeStore'
import { endTrip, startTrip } from '../routing/planner'
import { fetchCircle, parseJoinCode, postBoat, postMember as putMember, removeBoat, type OwnRecord } from './api'
import { syncPush } from './push'
import { useCircleStore, type BoatTrip, type Circle, type Plan } from './store'

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
 * (a final "home"). Offline, the post simply fails and the next tick tries
 * again; the server keeps only the latest record, so there is nothing to
 * queue.
 *
 * Sharing is ON by default for anyone in a circle — that is what joining
 * one is for. The trip card's switch is the way to keep one trip private;
 * it resets to the default when a new trip is planned and when a trip
 * ends. Nothing posts before cast-off or after the end, whatever the
 * switch says, so a boat on the trailer is never on the chart.
 *
 * The member record is the third clock, and it needs no fix: who this
 * boat is (on joining and whenever the skipper card changes) and the PLAN
 * — destination and time, the moment a time is picked (§0.4: a spot tap
 * explores, a time tap plans). The plan is restated on every change,
 * cleared at cast-off (the live record takes over) and when the trip is
 * cleared, and lapses on the server two hours past its out-time.
 */

const POLL_MS = 60_000
const POST_MS = 2 * 60_000
const MEMBER_DEBOUNCE_MS = 1500
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
        useCircleStore.getState().setCircle(c.id, r.boats, r.members)
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
    mark: s.skipper.mark,
    flair: s.skipper.flair,
    color: s.skipper.color,
    fix: { lon: fix.lon, lat: fix.lat, sogKn: fix.sogKn, cog: fix.cog, ts: fix.ts },
    trip,
  }
}

let posting = false

/** The switch's resting position: on when there is anyone to show. */
function defaultSharing(): boolean {
  return useCircleStore.getState().circles.length > 0
}

/** Post this boat to every circle now, if sharing, under way and there is
 *  a fix. The trip's end passes its own final record. */
export async function postNow(override?: { trip: BoatTrip | null }): Promise<void> {
  const s = useCircleStore.getState()
  if (!s.sharing || !s.circles.length || posting) return
  if (!override && useRouteStore.getState().tripStartedAt == null) return
  const rec = ownRecord(override ? override.trip : ownTrip())
  if (!rec) return
  posting = true
  try {
    const sent = await Promise.all(s.circles.map((c) => postBoat(c, rec).then(() => true, () => false)))
    // a trip the crew could see: On the Radar
    if (sent.some(Boolean) && useRouteStore.getState().tripStartedAt != null) useDiscoverStore.getState().touch('shared')
  } finally {
    posting = false
  }
}

/** The plan as the crew should hear it: a destination with a picked
 *  out-time, not yet under way, while this trip is shared. */
function ownPlan(): Plan | null {
  const rs = useRouteStore.getState()
  const app = useAppStore.getState()
  if (!useCircleStore.getState().sharing) return null
  if (!rs.destination || rs.tripStartedAt != null || app.planTimeMs == null) return null
  return {
    dest: { name: rs.destination.name, lon: rs.destination.lon, lat: rs.destination.lat },
    outMs: app.planTimeMs,
    backMs: app.planEndMs,
  }
}

let memberTimer: ReturnType<typeof setTimeout> | null = null
let memberSent = ''

/** Tell every circle who this boat is and what it plans — coalesced, and
 *  only when something about that changed since the last post. Needs no
 *  fix: a plan is where and when, not a position. */
export function postMember(opts: { force?: boolean } = {}): void {
  if (memberTimer) clearTimeout(memberTimer)
  memberTimer = setTimeout(() => {
    memberTimer = null
    const s = useCircleStore.getState()
    if (!s.circles.length) return
    const record = {
      deviceId: s.deviceId,
      deviceKey: s.deviceKey,
      name: s.skipper.name.trim() || 'A boat',
      boat: s.skipper.boat.trim(),
      mark: s.skipper.mark,
      flair: s.skipper.flair,
      color: s.skipper.color,
      plan: ownPlan(),
    }
    const key = JSON.stringify([record.name, record.boat, record.mark, record.flair, record.color, record.plan, s.circles.map((c) => c.id)])
    if (!opts.force && key === memberSent) return
    memberSent = key
    void Promise.all(s.circles.map((c) => putMember(c, record).then(() => true, () => false))).then((sent) => {
      // a plan the crew could see: Save the Date
      if (record.plan && sent.some(Boolean)) useDiscoverStore.getState().touch('planShared')
    })
  }, MEMBER_DEBOUNCE_MS)
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
  useCircleStore.getState().setCircle(c.id, r.boats, r.members)
  for (const cb of LISTENERS) cb()
  // joining IS the first word: the crew hears who arrived at once
  postMember({ force: true })
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
      app: useAppStore,
      postNow,
      postMember,
      pollCircles,
      stopSharing,
      leaveCircle,
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
      .then(() => useAppStore.getState().setSheetTab('crew'))
      .catch(() => undefined)
  }
  // a tapped notification lands on the Crew sheet: cold from its URL, warm
  // by a word from the service worker
  if (location.hash === '#crew') {
    history.replaceState(null, '', location.pathname + location.search)
    useAppStore.getState().setSheetTab('crew')
  }
  navigator.serviceWorker?.addEventListener('message', (e) => {
    const d = e.data as { type?: string; tab?: string } | null
    if (d?.type === 'open' && d.tab === 'crew') useAppStore.getState().setSheetTab('crew')
    // a push landed while the app is open: the chart need not wait its minute
    if (d?.type === 'crew-news') void pollCircles()
  })
  // the subscription rotates and a fresh install has none: keep the server current
  void syncPush()
  window.addEventListener('online', () => void syncPush())

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
  // (nothing posts after it), then the switch returns to its default for
  // the next trip. A newly planned trip resets it too — a private trip is
  // a decision about that trip, not a setting.
  useRouteStore.subscribe((s, prev) => {
    if (s.tripStartedAt !== prev.tripStartedAt) {
      if (s.tripStartedAt != null) void postNow()
      else void stopSharing().finally(() => useCircleStore.getState().setSharing(defaultSharing()))
      return
    }
    if (s.tripStartedAt == null) {
      const planned = s.destination && s.destination.name !== prev.destination?.name
      if (planned) useCircleStore.getState().setSharing(defaultSharing())
      return
    }
    if (s.reachedDestAt !== prev.reachedDestAt || s.plan?.destName !== prev.plan?.destName) {
      void postNow()
    }
  })
  useCircleStore.subscribe((s, prev) => {
    if (s.sharing && !prev.sharing) void postNow()
    if (s.circles.length !== prev.circles.length) {
      void pollCircles()
      // the first circle turns the switch on (unless a trip is already under
      // way — that one stays as it was tapped); the last one leaving turns it off
      if (!s.circles.length || (!prev.circles.length && useRouteStore.getState().tripStartedAt == null)) {
        s.setSharing(defaultSharing())
      }
    }
    // a new crew, a renamed skipper, a new mark, the switch: the member record follows
    if (s.circles !== prev.circles || s.skipper !== prev.skipper || s.sharing !== prev.sharing) postMember()
  })
  // the plan: destination + time pick, gone at cast-off or with the ✕
  useRouteStore.subscribe((s, prev) => {
    if (s.destination !== prev.destination || s.tripStartedAt !== prev.tripStartedAt) postMember()
  })
  useAppStore.subscribe((s, prev) => {
    if (s.planTimeMs !== prev.planTimeMs || s.planEndMs !== prev.planEndMs) postMember()
  })
  // and on every launch, so a member row exists for anyone who joined
  // before there was one
  postMember()
}
