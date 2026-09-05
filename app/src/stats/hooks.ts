/**
 * What gets counted. The stores are watched from here — one place, rather
 * than a track() call in every handler — so the list of events IS this
 * file, and a reader can see everything the app records in a minute.
 *
 *   open / close     a session: the build, the phone, the state of the
 *                    caches; how long it stayed on screen
 *   boot             ms from navigation to the chart's style being up
 *   tab              a sheet opened
 *   helm, low_power, heading_up, follow, layer, unit, wx_strip, round_trip
 *                    a control used
 *   dest, via, plan_time, route
 *                    a trip planned; `route` carries the router's ms
 *   trip_start / trip_end
 *                    cast-off and dock, with the minutes and miles logged
 *   gps              a status change (on, denied, error …)
 *   earn, level      Discover
 *   circle, share    Boats out
 *   place, measure, charts, gpx, report
 *                    the smaller features
 *   wx_fail, wx_source, wx_fetch
 *                    the forecast providers (see openMeteo.ts)
 *   error            an uncaught error (see diagnostics.ts)
 *
 * Nothing here carries a position. The trip events say how far and how
 * long, not where.
 */
import { useCircleStore } from '../circle/store'
import { isInstalled } from '../discover/install'
import { useDiscoverStore } from '../discover/store'
import { withMap } from '../map/mapController'
import { useMeasureStore } from '../measure/measureStore'
import { listStored, storageEstimate } from '../offline/fileStore'
import { useRouteStore } from '../routing/routeStore'
import { useAppStore } from '../state/appStore'
import { usePlacesStore } from '../state/placesStore'
import { useGpsStore } from '../tracking/gpsStore'
import { windOverlayStatus } from '../weather/hrdps'
import { cachedGridForecast } from '../weather/openMeteo'
import { waveOverlayStatus } from '../weather/rdwps'
import { devlog } from '../devlog'
import { flush, installStats, setStatsEnabled, track } from './core'

/** Hidden this long, coming back counts as a new session. */
const RESUME_MS = 30 * 60_000

function platform(): string {
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/Macintosh/.test(ua)) return 'mac'
  if (/Windows/.test(ua)) return 'windows'
  return 'other'
}

function hours(ms: number): number | null {
  return Number.isFinite(ms) ? Math.round(ms / 360_000) / 10 : null
}

async function open(resume: boolean) {
  const nav = navigator as Navigator & {
    deviceMemory?: number
    connection?: { effectiveType?: string }
  }
  const [quota, grid] = await Promise.all([
    storageEstimate().catch(() => null),
    cachedGridForecast().catch(() => null),
  ])
  const wind = windOverlayStatus()
  const waves = waveOverlayStatus()
  track('open', {
    resume,
    build: __BUILD__.sha,
    installed: isInstalled(),
    platform: platform(),
    w: innerWidth,
    h: innerHeight,
    dpr: devicePixelRatio,
    online: navigator.onLine,
    sw: !!navigator.serviceWorker?.controller,
    charts: listStored().length,
    storage_mb: quota ? Math.round(quota.usage / 1e6) : null,
    grid_h: grid ? hours(grid.ageMs) : null,
    wind: wind.state,
    wind_h: hours(wind.runAgeMs),
    waves: waves.state,
    waves_h: hours(waves.runAgeMs),
    cores: nav.hardwareConcurrency,
    mem: nav.deviceMemory,
    net: nav.connection?.effectiveType,
  })
}

let inited = false

/** Call once at startup, after the stores have hydrated. */
export function initStats(): void {
  if (inited) return
  inited = true
  installStats(useAppStore.getState().usageStats)

  // ---- the session ----
  let shownAt = Date.now()
  let hiddenAt: number | null = null
  noteLastExit()
  void open(false)
  startHeartbeat(() => shownAt)
  withMap(() => track('boot', { ms: Math.round(performance.now()) }))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      track('close', { sec: Math.round((hiddenAt - shownAt) / 1000) })
      beat(false, shownAt)
      void flush()
    } else if (hiddenAt != null && Date.now() - hiddenAt >= RESUME_MS) {
      shownAt = Date.now()
      void open(true)
    }
  })

  // ---- the controls ----
  useAppStore.subscribe((s, p) => {
    if (s.usageStats !== p.usageStats) {
      setStatsEnabled(s.usageStats)
      if (s.usageStats) track('stats_on')
    }
    if (s.sheetTab !== p.sheetTab && s.sheetTab) track('tab', { tab: s.sheetTab })
    if (s.helm !== p.helm) {
      track('helm', { on: s.helm })
      devlog('helm', s.helm ? 'on' : 'off')
    }
    if (s.lowPower !== p.lowPower) track('low_power', { on: s.lowPower })
    if (s.headingUp !== p.headingUp && s.headingUp) track('heading_up')
    if (s.follow !== p.follow && s.follow) track('follow')
    if (s.layers !== p.layers) {
      for (const k of Object.keys(s.layers) as (keyof typeof s.layers)[]) {
        if (s.layers[k] !== p.layers[k]) track('layer', { key: k, on: s.layers[k] })
      }
    }
    if (s.depthUnit !== p.depthUnit) track('unit', { kind: 'depth', value: s.depthUnit })
    if (s.speedUnit !== p.speedUnit) track('unit', { kind: 'speed', value: s.speedUnit })
    if (s.windUnit !== p.windUnit) track('unit', { kind: 'wind', value: s.windUnit })
    if (s.wxStrip !== p.wxStrip) track('wx_strip', { on: s.wxStrip })
    if (s.planTimeMs !== p.planTimeMs && s.planTimeMs != null) {
      track('plan_time', { hours_ahead: (s.planTimeMs - Date.now()) / 3600_000 })
    }
  })

  // ---- the trip ----
  useRouteStore.subscribe((s, p) => {
    if (s.destination && !p.destination) {
      track('dest', { named: s.destination.name != null, round: s.roundTrip })
    }
    if (s.viaPoints.length > p.viaPoints.length) track('via', { n: s.viaPoints.length })
    if (s.roundTrip !== p.roundTrip) track('round_trip', { on: s.roundTrip })
    if (s.tripStartedAt != null && p.tripStartedAt == null) {
      track('trip_start', { round: s.roundTrip, nm: s.plan?.totalNm })
    }
    if (s.tripStartedAt == null && p.tripStartedAt != null) {
      // fires inside routeStore.endTrip(), before the recording stops —
      // the distance is still on the GPS store
      track('trip_end', {
        min: Math.round((Date.now() - p.tripStartedAt) / 60_000),
        nm: useGpsStore.getState().recordingDistanceNm,
        arrived: p.reachedDestAt != null,
      })
    }
  })

  useGpsStore.subscribe((s, p) => {
    if (s.status !== p.status && s.status !== 'acquiring') {
      track('gps', { status: s.status, err: s.lastError ?? undefined }, { every: 60_000 })
    }
  })

  // ---- Discover ----
  useDiscoverStore.subscribe((s, p) => {
    if (s.earned !== p.earned) {
      for (const id of Object.keys(s.earned)) if (!p.earned[id]) track('earn', { id })
    }
    if (s.level !== p.level) track('level', { n: s.level })
  })

  // ---- Boats out ----
  useCircleStore.subscribe((s, p) => {
    if (s.circles.length !== p.circles.length) track('circle', { n: s.circles.length })
    if (s.sharing !== p.sharing) track('share', { on: s.sharing })
  })

  // ---- the smaller features ----
  usePlacesStore.subscribe((s, p) => {
    if (s.saved.length > p.saved.length) track('place', { n: s.saved.length })
  })
  useMeasureStore.subscribe((s, p) => {
    if (s.active && !p.active) track('measure')
  })
}

// ---------- the exit nobody chose ----------
//
// iOS never says why an app went away. What we can know: whether the page
// was in front when it was last heard from, and whether it left cleanly.
// A heartbeat every ten seconds while visible writes the moment and the
// load the app was under; pagehide clears it. A launch that finds a
// heartbeat still there was preceded by a kill — in use if the beat says
// visible (the "closes on its own" a memory-starved phone does), else the
// ordinary background purge.

const ALIVE_KEY = 'sandies-alive'
const LAST_EXIT_KEY = 'sandies-last-exit'
const BEAT_MS = 10_000

interface Beat {
  ts: number
  visible: boolean
  sec: number
  sat: boolean
  wind: boolean
  sea: boolean
  low: boolean
  trip: boolean
}

function beat(visible: boolean, shownAt: number) {
  const app = useAppStore.getState()
  const b: Beat = {
    ts: Date.now(),
    visible,
    sec: Math.round((Date.now() - shownAt) / 1000),
    sat: app.layers.satellite,
    wind: app.layers.weather,
    sea: app.layers.seaFlow,
    low: app.lowPower,
    trip: useRouteStore.getState().tripStartedAt != null,
  }
  try {
    localStorage.setItem(ALIVE_KEY, JSON.stringify(b))
  } catch {
    /* storage full or gone: nothing to note */
  }
}

function startHeartbeat(shownAt: () => number) {
  beat(true, shownAt())
  setInterval(() => {
    if (document.visibilityState === 'visible') beat(true, shownAt())
  }, BEAT_MS)
  // a clean exit takes the beat with it
  window.addEventListener('pagehide', () => {
    try {
      localStorage.removeItem(ALIVE_KEY)
    } catch {
      /* ignore */
    }
  })
}

/** What the last exit was, for the diagnostics report. */
export function lastExit(): string | null {
  try {
    return localStorage.getItem(LAST_EXIT_KEY)
  } catch {
    return null
  }
}

function noteLastExit() {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(ALIVE_KEY)
    localStorage.removeItem(ALIVE_KEY)
  } catch {
    return
  }
  if (!raw) return
  try {
    const b = JSON.parse(raw) as Beat
    const ago = Math.round((Date.now() - b.ts) / 1000)
    const kind = b.visible ? 'killed' : 'purged'
    track(kind, { sec: b.sec, ago, sat: b.sat, wind: b.wind, sea: b.sea, low: b.low, trip: b.trip, dpr: devicePixelRatio })
    devlog('exit', `${kind} last time`, { ago, sec: b.sec, sat: b.sat, trip: b.trip })
    const when = new Date(b.ts).toISOString().slice(0, 16).replace('T', ' ')
    localStorage.setItem(
      LAST_EXIT_KEY,
      `${kind} ${when} after ${b.sec}s in front · sat ${b.sat ? 'on' : 'off'} · wind ${b.wind ? 'on' : 'off'} · sea ${b.sea ? 'on' : 'off'} · low power ${b.low ? 'on' : 'off'} · trip ${b.trip ? 'yes' : 'no'}`,
    )
  } catch {
    /* an old or odd beat: forget it */
  }
}
