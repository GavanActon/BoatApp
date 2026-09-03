import { useAppStore } from '../state/appStore'
import { allPlaces, usePlacesStore } from '../state/placesStore'
import { isAfloat } from '../routing/router'
import { useRouteStore } from '../routing/routeStore'
import { haversineNm } from '../routing/waterRouter'
import { useGpsStore, type Fix } from '../tracking/gpsStore'
import type { Outing } from '../tracking/db'
import { gridConditionsAt } from '../weather/weatherLayer'
import { seaBand } from '../weather/seaState'
import { addArrival, loadLog, logView, onLog, outingStartedAt, refreshTracks, saveOuting } from './log'
import { ACHIEVEMENTS, type Ctx } from './registry'
import { REACH_NM, SEASON_PLACES, seasonOf } from './season'
import { chapters, levelOf } from './setup'
import { useDiscoverStore, type TripCtx } from './store'

/**
 * The engine: watches the stores the app already keeps, notes the gestures
 * that can't be read off a value, keeps the trip's context from cast-off to
 * the dock, and evaluates every achievement whenever anything moves. It
 * subscribes; it never edits the other stores' behaviour.
 */

const SANDIES = 'The Sandies'
const ARRIVAL_ACCURACY_M = 200
const ARRIVAL_TICK_MS = 20_000
const PLAN_LATER_MS = 60 * 60_000
const RAIN_CHECK_GRACE_MS = 3 * 3600_000

let inited = false
/** When this session opened cold — no trip, no plan — Last Minute Club's clock. */
let openedAt: number | null = null
let lastArrivalTick = 0
let evalTimer: number | undefined
/** The current trip's outing row id, known to the save chain even before the
 *  store has been told — so two saves racing at cast-off make one row. */
let curOutingId: number | null = null
/** Outing writes, one after another, in order. */
let chain: Promise<void> = Promise.resolve()

export async function initDiscover(): Promise<void> {
  if (inited) return
  inited = true
  const rs = useRouteStore.getState()
  openedAt = rs.tripStartedAt == null && rs.destination == null ? Date.now() : null
  curOutingId = useDiscoverStore.getState().trip?.outingId ?? null

  // subscriptions first: a slow or failing log must not leave the engine deaf
  subscribeAll()

  try {
    await loadLog()
  } catch (e) {
    console.warn('discover: the log could not be read', e)
  }

  // reconcile with a trip that started or ended while we weren't looking
  const d = useDiscoverStore.getState()
  const rs2 = useRouteStore.getState()
  if (d.trip && rs2.tripStartedAt == null) endTripCtx(Date.now(), null)
  else if (!d.trip && rs2.tripStartedAt != null) onTripStart()
  settleRainCheck()
  schedule()
}

function subscribeAll() {
  useRouteStore.subscribe((s, p) => {
    const disc = useDiscoverStore.getState()
    // a saved trip applies cruise and back-by wholesale from the Places
    // sheet; only changes made anywhere else are the skipper's own gesture
    const own = useAppStore.getState().sheetTab !== 'places'
    if (s.cruiseKn !== p.cruiseKn && own) {
      disc.touch('cruise')
      if (disc.guide === 'cruise') disc.setGuide(null)
    }
    if (s.backByHour !== p.backByHour && own) disc.touch('backBy')
    if (s.viaPoints.length > 0 && p.viaPoints.length === 0) disc.touch('via')
    // a fresh subject, or a different named one — a dragged pin keeps its (null) name
    if (
      s.destination &&
      (p.destination == null || s.destination.name !== p.destination.name) &&
      s.destination.name !== SANDIES
    ) {
      disc.touch('newRoute')
    }
    if (s.tripStartedAt != null && p.tripStartedAt == null) onTripStart()
    if (s.tripStartedAt == null && p.tripStartedAt != null) {
      // the route store ends the trip before recording stops, so the
      // distance is still whole here
      endTripCtx(Date.now(), useGpsStore.getState().recordingDistanceNm)
    }
    // the planner's latch, trusted only when it was measured from the boat
    // — planned from home waters it fires for a destination beside the dock
    if (s.reachedDestAt != null && p.reachedDestAt == null && s.tripStartedAt != null && s.startFrom === 'fix') {
      markArrived(s.reachedDestAt)
    }
    schedule()
  })

  useAppStore.subscribe((s, p) => {
    const disc = useDiscoverStore.getState()
    // the fresh outlines are for the first look at the hub
    if (p.sheetTab === 'discover' && s.sheetTab !== 'discover') disc.markSeen()
    if (s.depthUnit !== p.depthUnit || s.speedUnit !== p.speedUnit || s.windUnit !== p.windUnit) disc.touch('units')
    if (s.seaScaleM !== p.seaScaleM) disc.touch('scale')
    if (s.planPicked && s.planTimeMs != null && (s.planTimeMs !== p.planTimeMs || !p.planPicked)) {
      disc.touch('planTime')
    }
    // the back chip was armed and the strip answered it
    if (p.armedEnd === 'back' && s.planEndMs !== p.planEndMs) disc.touch('backBy')
    if (s.helm && !p.helm) {
      disc.touch('helm')
      noteHelmHome()
    }
    if (s.lowPower !== p.lowPower) disc.touch('lowPower')
    // a plan for later: remembered, so a plan that never became a trip counts
    if (s.planPicked && s.planTimeMs != null && s.planTimeMs > Date.now() + PLAN_LATER_MS) {
      const cur = disc.pendingPlan
      if (!cur || cur.ms !== s.planTimeMs) {
        settleRainCheck() // the previous plan, if its hour has gone by
        disc.setPendingPlan({ ms: s.planTimeMs, name: useRouteStore.getState().destination?.name ?? null })
      }
    }
    schedule()
  })

  usePlacesStore.subscribe((s, p) => {
    if (s.saved !== p.saved && s.saved.length === p.saved.length) {
      const before = new Set(p.saved.map((x) => x.name))
      if (s.saved.some((x) => !before.has(x.name))) useDiscoverStore.getState().touch('rename')
    }
    schedule()
  })

  useGpsStore.subscribe((s, p) => {
    if (s.fix && s.fix !== p.fix) onFix(s.fix)
    if (!s.recording && p.recording) void refreshTracks()
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') settleRainCheck()
  })

  onLog(schedule)
  useDiscoverStore.subscribe(schedule)
}

function schedule() {
  if (evalTimer != null) return
  evalTimer = window.setTimeout(() => {
    evalTimer = undefined
    evaluate()
  }, 60)
}

function buildCtx(): Ctx {
  const app = useAppStore.getState()
  const places = usePlacesStore.getState()
  const disc = useDiscoverStore.getState()
  return {
    now: Date.now(),
    onboarded: app.onboarded,
    homeName: places.homeName,
    savedPlaces: places.saved,
    noteCount: Object.keys(places.notes).length,
    cruiseKn: useRouteStore.getState().cruiseKn,
    seaScaleM: app.seaScaleM,
    offlineReady: app.offlineReady,
    touched: disc.touched,
    rainChecks: disc.rainChecks,
    seasonReached: disc.seasonReached,
    log: logView(),
  }
}

/** Every unearned achievement gets its check; the first to pass are earned
 *  in list order, so a trip that earns two plays them in a sensible order. */
export function evaluate(): void {
  const ctx = buildCtx()
  const disc = useDiscoverStore.getState()
  for (const a of ACHIEVEMENTS) {
    if (disc.earned[a.id]) continue
    let facts: ReturnType<typeof a.check> = null
    try {
      facts = a.check(ctx)
    } catch {
      facts = null
    }
    if (facts) useDiscoverStore.getState().earn(a.id, facts)
  }
  // a finished chunk is a level — noticed here, where every input has settled
  const level = levelOf(chapters())
  if (level !== disc.level) useDiscoverStore.getState().levelUp(level)
}

// ---------- the trip, cast-off to dock ----------

function outingOf(t: TripCtx, id: number | null, endedAt: number | null, trackNm: number | null): Outing {
  return {
    ...(id != null ? { id } : {}),
    startedAt: t.startedAt,
    endedAt,
    openedAt: t.openedAt,
    destName: t.destName,
    destLon: t.destLon,
    destLat: t.destLat,
    originLon: t.originLon,
    originLat: t.originLat,
    roundTrip: t.roundTrip,
    plannedNm: t.plannedNm,
    plannedArriveMs: t.plannedArriveMs,
    plannedHomeMs: t.plannedHomeMs,
    arrivedAt: t.arrivedAt,
    leftDestAt: t.leftDestAt,
    homeAt: t.homeAt,
    trackNm,
    forecastBand: t.forecastBand,
    feltBand: t.feltBand,
    helmHome: t.helmHome,
    limitM: t.limitM,
    scaleM: t.scaleM,
  }
}

/** Write the live trip's row. Queued: writes never overlap, and the id the
 *  first write earns is seen by every later one. */
function persistTrip() {
  chain = chain
    .then(async () => {
      const t = useDiscoverStore.getState().trip
      if (!t) return
      const o = outingOf(t, t.outingId ?? curOutingId, null, null)
      await saveOuting(o)
      if (o.id != null && curOutingId !== o.id) {
        curOutingId = o.id
        useDiscoverStore.getState().patchTrip({ outingId: o.id })
      }
    })
    .catch(() => {})
}

function onTripStart() {
  const rs = useRouteStore.getState()
  const app = useAppStore.getState()
  const dest = rs.destination
  const origin = rs.tripOrigin
  if (!dest || !origin || rs.tripStartedAt == null) return
  const disc = useDiscoverStore.getState()
  curOutingId = null
  const trip: TripCtx = {
    openedAt,
    startedAt: rs.tripStartedAt,
    destName: dest.name,
    destLon: dest.lon,
    destLat: dest.lat,
    originLon: origin[0],
    originLat: origin[1],
    roundTrip: rs.roundTrip,
    plannedNm: rs.plan?.totalNm ?? null,
    plannedArriveMs: rs.promisedArriveMs,
    plannedHomeMs: rs.promisedHomeMs,
    arrivedAt: null,
    leftDestAt: null,
    homeAt: null,
    forecastBand: null,
    feltBand: null,
    helmHome: false,
    limitM: app.waveLimitM,
    scaleM: app.seaScaleM,
    outingId: null,
    earnedIds: [],
  }
  disc.setTrip(trip)
  disc.touch('tripStart')
  disc.setPendingPlan(null)
  openedAt = null // the next trip this session is not a cold open
  persistTrip()
}

/** The boat is at the destination — from the planner's latch or our own
 *  fix, whichever says so first. */
function markArrived(at: number) {
  const t = useDiscoverStore.getState().trip
  if (!t || t.arrivedAt != null) return
  const wave = gridConditionsAt(t.destLon, t.destLat, at)?.waveM ?? null
  useDiscoverStore.getState().patchTrip({ arrivedAt: at, forecastBand: seaBand(wave) })
  if (t.destName) void addArrival(t.destName, t.destLon, t.destLat, at)
  reachSeasonNear(t.destLon, t.destLat, at)
  persistTrip()
}

function noteHelmHome() {
  const t = useDiscoverStore.getState().trip
  if (t && t.arrivedAt != null && !t.helmHome) {
    useDiscoverStore.getState().patchTrip({ helmHome: true })
    persistTrip()
  }
}

/** The trip is over: the context closes NOW (a fix landing during the
 *  write must not reopen it), the final row is written from a snapshot, and
 *  an unanswered sea-felt question is kept to ask once more. */
function endTripCtx(endedAt: number, trackNm: number | null) {
  const disc = useDiscoverStore.getState()
  const t = disc.trip
  if (!t) return
  disc.setTrip(null)
  if (t.arrivedAt != null && t.feltBand == null) {
    disc.setPendingFelt({ startedAt: t.startedAt, destName: t.destName })
  }
  chain = chain
    .then(async () => {
      await saveOuting(outingOf(t, t.outingId ?? curOutingId, endedAt, trackNm))
    })
    .catch(() => {})
}

/** The arrival card's one question: what did the water feel like? Answers
 *  the live trip, or the last one if it was asked after the fact. */
export function setSeaFelt(band: number | null): void {
  const disc = useDiscoverStore.getState()
  if (disc.trip) {
    disc.patchTrip({ feltBand: band })
    persistTrip()
    return
  }
  const pf = disc.pendingFelt
  if (!pf) return
  chain = chain
    .then(async () => {
      const o = outingStartedAt(pf.startedAt)
      if (o) await saveOuting({ ...o, feltBand: band })
    })
    .catch(() => {})
  if (band != null) disc.setPendingFelt(null)
}

export function dismissSeaFelt(): void {
  useDiscoverStore.getState().setPendingFelt(null)
}

// ---------- the boat's position ----------

function onFix(fix: Fix) {
  if (fix.accuracy > ARRIVAL_ACCURACY_M) return
  const now = Date.now()
  const disc = useDiscoverStore.getState()
  const t = disc.trip
  if (t) {
    const toDest = haversineNm(fix.lon, fix.lat, t.destLon, t.destLat)
    if (t.arrivedAt == null && toDest < REACH_NM) markArrived(now)
    else if (t.arrivedAt != null && t.leftDestAt == null && toDest > REACH_NM) {
      disc.patchTrip({ leftDestAt: now })
      persistTrip()
    }
    const t2 = useDiscoverStore.getState().trip
    if (
      t2 &&
      t2.roundTrip &&
      t2.arrivedAt != null &&
      t2.leftDestAt != null &&
      t2.homeAt == null &&
      haversineNm(fix.lon, fix.lat, t2.originLon, t2.originLat) < REACH_NM
    ) {
      disc.patchTrip({ homeAt: now })
      persistTrip()
    }
    if (useAppStore.getState().helm) noteHelmHome()
  }

  // being somewhere counts from the WATER: the deck of a cottage beside a
  // watched spot is not a visit
  if (now - lastArrivalTick < ARRIVAL_TICK_MS) return
  lastArrivalTick = now
  if (!isAfloat(fix.lon, fix.lat)) return
  const home = usePlacesStore.getState().homeName
  for (const p of allPlaces()) {
    if (p.name === home) continue
    if (haversineNm(fix.lon, fix.lat, p.lon, p.lat) < REACH_NM) void addArrival(p.name, p.lon, p.lat, now)
  }
  reachSeasonNear(fix.lon, fix.lat, now)
}

/** Any season place within arrival range of here is reached — first time this year. */
function reachSeasonNear(lon: number, lat: number, at: number) {
  const disc = useDiscoverStore.getState()
  for (const p of SEASON_PLACES) {
    if (haversineNm(lon, lat, p.lon, p.lat) < REACH_NM) {
      const had = disc.seasonReached[p.id]
      if (had == null || seasonOf(had) !== seasonOf(at)) disc.reachSeason(p.id, at)
    }
  }
}

// ---------- plans that never became trips ----------

/** A plan for a later hour whose hour has gone by, with no trip started
 *  (cast-off clears the plan), is a rain check. */
function settleRainCheck() {
  const disc = useDiscoverStore.getState()
  const pp = disc.pendingPlan
  if (!pp) return
  if (Date.now() < pp.ms + RAIN_CHECK_GRACE_MS) return
  disc.setRainChecks(disc.rainChecks + 1)
  disc.setPendingPlan(null)
}
