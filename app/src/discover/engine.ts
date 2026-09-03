import { DESTINATIONS } from '../config'
import { useAppStore } from '../state/appStore'
import { usePlacesStore } from '../state/placesStore'
import { useRouteStore } from '../routing/routeStore'
import { haversineNm } from '../routing/waterRouter'
import { useGpsStore, type Fix } from '../tracking/gpsStore'
import type { Outing } from '../tracking/db'
import { gridConditionsAt } from '../weather/weatherLayer'
import { seaBand } from '../weather/seaState'
import { addArrival, loadLog, logView, onLog, refreshTracks, saveOuting } from './log'
import { ACHIEVEMENTS, knownPlaceNames, type Ctx } from './registry'
import { REACH_NM, SEASON_PLACES, seasonOf } from './season'
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
/** When this session opened with no trip under way — Last Minute Club's clock. */
let openedAt: number | null = null
let lastArrivalTick = 0
let evalTimer: number | undefined

export async function initDiscover(): Promise<void> {
  if (inited) return
  inited = true
  const d = useDiscoverStore.getState()
  const rs = useRouteStore.getState()
  openedAt = rs.tripStartedAt == null ? Date.now() : null

  await loadLog()

  // a trip the app forgot while we weren't looking (expired on load) — close
  // its context so a stale one never leaks into the next trip
  if (d.trip && rs.tripStartedAt == null) await finishTrip(Date.now(), null)
  settleRainCheck()

  useRouteStore.subscribe((s, p) => {
    const disc = useDiscoverStore.getState()
    if (s.cruiseKn !== p.cruiseKn) disc.touch('cruise')
    if (s.viaPoints.length > 0 && p.viaPoints.length === 0) disc.touch('via')
    if (s.backByHour !== p.backByHour) disc.touch('backBy')
    if (s.destination && s.destination !== p.destination && s.destination.name !== SANDIES) {
      disc.touch('newRoute')
    }
    if (s.tripStartedAt != null && p.tripStartedAt == null) onTripStart()
    if (s.tripStartedAt == null && p.tripStartedAt != null) void finishTrip(Date.now(), useGpsStore.getState().recordingDistanceNm)
    if (s.reachedDestAt != null && p.reachedDestAt == null && s.tripStartedAt != null) onReachedDest(s.reachedDestAt)
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

  onLog(schedule)
  useDiscoverStore.subscribe(schedule)
  schedule()
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
    waveLimitM: app.waveLimitM,
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
}

// ---------- the trip, cast-off to dock ----------

function outingOf(t: TripCtx, endedAt: number | null, trackNm: number | null): Outing {
  return {
    ...(t.outingId != null ? { id: t.outingId } : {}),
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
  }
}

async function persistTrip(): Promise<void> {
  const t = useDiscoverStore.getState().trip
  if (!t) return
  const o = outingOf(t, null, null)
  await saveOuting(o)
  if (t.outingId == null && o.id != null) useDiscoverStore.getState().patchTrip({ outingId: o.id })
}

function onTripStart() {
  const rs = useRouteStore.getState()
  const dest = rs.destination
  const origin = rs.tripOrigin
  if (!dest || !origin || rs.tripStartedAt == null) return
  const disc = useDiscoverStore.getState()
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
    outingId: null,
    earnedIds: [],
  }
  disc.setTrip(trip)
  disc.touch('tripStart')
  disc.setPendingPlan(null)
  openedAt = null // the next trip this session is not a cold open
  void persistTrip()
}

function onReachedDest(at: number) {
  const t = useDiscoverStore.getState().trip
  if (!t || t.arrivedAt != null) return
  const wave = gridConditionsAt(t.destLon, t.destLat, at)?.waveM ?? null
  useDiscoverStore.getState().patchTrip({ arrivedAt: at, forecastBand: seaBand(wave) })
  // the planner's latch is the authoritative "we're there" — the proximity
  // watcher only samples every so often and can miss a short stop
  if (t.destName) void addArrival(t.destName, t.destLon, t.destLat, at)
  reachSeasonNear(t.destLon, t.destLat, at)
  void persistTrip()
}

function noteHelmHome() {
  const t = useDiscoverStore.getState().trip
  if (t && t.arrivedAt != null && !t.helmHome) useDiscoverStore.getState().patchTrip({ helmHome: true })
}

async function finishTrip(endedAt: number, trackNm: number | null): Promise<void> {
  const t = useDiscoverStore.getState().trip
  if (!t) return
  await saveOuting(outingOf(t, endedAt, trackNm))
  useDiscoverStore.getState().setTrip(null)
}

/** The arrival card's one question: what did the water feel like? */
export function setSeaFelt(band: number | null): void {
  useDiscoverStore.getState().patchTrip({ feltBand: band })
  void persistTrip()
}

// ---------- the boat's position ----------

function onFix(fix: Fix) {
  if (fix.accuracy > ARRIVAL_ACCURACY_M) return
  const now = fix.ts || Date.now()
  const disc = useDiscoverStore.getState()
  const t = disc.trip
  if (t) {
    if (t.arrivedAt != null && t.leftDestAt == null && haversineNm(fix.lon, fix.lat, t.destLon, t.destLat) > REACH_NM) {
      disc.patchTrip({ leftDestAt: now })
      void persistTrip()
    }
    if (
      t.roundTrip &&
      t.arrivedAt != null &&
      t.leftDestAt != null &&
      t.homeAt == null &&
      haversineNm(fix.lon, fix.lat, t.originLon, t.originLat) < REACH_NM
    ) {
      disc.patchTrip({ homeAt: now })
      void persistTrip()
    }
    if (useAppStore.getState().helm) noteHelmHome()
  }

  if (now - lastArrivalTick < ARRIVAL_TICK_MS) return
  lastArrivalTick = now
  const places = usePlacesStore.getState()
  const known = knownPlaceNames(places.saved)
  const coords = new Map<string, [number, number]>()
  for (const p of places.saved) coords.set(p.name, [p.lon, p.lat])
  for (const name of known) {
    const c = coords.get(name) ?? destCoords(name)
    if (!c) continue
    if (haversineNm(fix.lon, fix.lat, c[0], c[1]) < REACH_NM) void addArrival(name, c[0], c[1], now)
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

const DEST_COORDS = new Map(DESTINATIONS.map((d) => [d.name, [d.lon, d.lat] as [number, number]]))
function destCoords(name: string): [number, number] | null {
  return DEST_COORDS.get(name) ?? null
}

// ---------- plans that never became trips ----------

function settleRainCheck() {
  const disc = useDiscoverStore.getState()
  const pp = disc.pendingPlan
  if (!pp) return
  const now = Date.now()
  if (now < pp.ms + RAIN_CHECK_GRACE_MS) return
  const went = logView().outings.some(
    (o) => o.startedAt >= pp.ms - 2 * 3600_000 && o.startedAt <= pp.ms + RAIN_CHECK_GRACE_MS,
  )
  if (!went) disc.setRainChecks(disc.rainChecks + 1)
  disc.setPendingPlan(null)
}
