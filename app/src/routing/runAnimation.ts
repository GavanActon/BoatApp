import type { Feature, FeatureCollection } from 'geojson'
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import { setLaneHighlight } from './routeLayer'
import { useRouteStore } from './routeStore'
import { useAppStore } from '../state/appStore'

/**
 * Motion on the run.
 *
 * The default is still the comet: a faint travelling brightness inside each
 * lane's own colour ramp, both lanes at once, one shared phase.
 *
 * The crest variants under trial move the RAKE instead — the swell bands
 * combed along the course — and take the run one way at a time: the way out
 * is lit and animated through a full pass, then the way back, so the circuit
 * is read as two journeys rather than one loop. Each variant is one idea:
 *
 *   'trail' — crests appear behind a moving front, the comet at its head;
 *             the pass leaves the whole rake standing, then the return
 *             sweeps it the other way.
 *   'roll'  — every crest stays put; a window of brightness rolls along the
 *             course through them. Nothing appears or disappears — the sea
 *             is always there, the light just travels the direction you do.
 *   'march' — the crests themselves drift the way their own sea travels,
 *             in sets that rise and dissolve; the lanes alternate emphasis
 *             to say which way is being read. The only variant where the
 *             motion is the WATER's, not the journey's.
 *
 * Everything stops for `prefers-reduced-motion`, a hidden tab, and an empty
 * chart. Motion on a chart costs battery and, left running forever, starts
 * to read as an alarm rather than as information.
 */

export type RunAnimVariant = 'comet' | 'trail' | 'roll' | 'march' | 'wave'

const LANE_MS = 4600 // one pass along a lane — slow on purpose
const HOLD_MS = 900 // the finished pass stands for a beat before the return
const CYCLE_MS = (LANE_MS + HOLD_MS) * 2
const FPS_MS = 40 // per-step rebuild cost is small; 25 fps is plenty

// 'march': one set of crests lives this long, drifting this far
const MARCH_MS = 3600
const MARCH_SPAN_DEG = 0.004 // degrees of latitude a set travels over its life

// the rake layers' resting paint, restored when a variant lets go of them —
// mirrors the layer definitions in routeLayer.addLayers
const RAKE_OPACITY = ['interpolate', ['linear'], ['zoom'], 9, 0.24, 13, 0.36]
const HAZE_OPACITY = ['interpolate', ['linear'], ['zoom'], 9, 0.13, 13, 0.2]
const CREST_FILTER = ['==', ['get', 'kind'], 'crest']

let variant: RunAnimVariant = 'comet'
let raf: number | null = null
let lastStepMs = 0
let theMap: MlMap | null = null

// what the animation has borrowed and must give back
let lanesDimmed = false
let rakeForced = false
let rakeBase: FeatureCollection | null = null

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** Where the cycle is: which lane is being read, how far along (0..1), and
 *  whether the pass is finished and standing. */
function cyclePos(now: number): { lane: 'out' | 'back'; p: number; hold: boolean } {
  const t = now % CYCLE_MS
  const half = LANE_MS + HOLD_MS
  const lane = t < half ? 'out' : 'back'
  const lt = t % half
  return { lane, p: Math.min(1, lt / LANE_MS), hold: lt >= LANE_MS }
}

/** Emphasize one lane, resting the other. MapLibre's default paint
 *  transition eases the swap, so the handover reads as a breath, not a cut. */
function emphasizeLane(map: MlMap, lane: 'out' | 'back' | null) {
  const set = (id: string, v: number) =>
    map.getLayer(id) && map.setPaintProperty(id, 'line-opacity', v)
  if (lane == null) {
    if (!lanesDimmed) return
    lanesDimmed = false
    set('run-out', 1)
    set('run-back', 1)
    return
  }
  lanesDimmed = true
  set('run-out', lane === 'out' ? 1 : 0.3)
  set('run-back', lane === 'back' ? 1 : 0.3)
}

/** True while a crest variant has borrowed the rake — routeLayer keeps it
 *  visible regardless of the layer toggle for as long as this holds. */
export function isRakeForced(): boolean {
  return rakeForced
}

/** The crest variants need the rake on screen whatever the layer toggle
 *  says; remember that it was borrowed. */
function forceRake(map: MlMap) {
  if (rakeForced) return
  rakeForced = true
  for (const id of ['run-rake', 'run-rake-haze']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible')
  }
}

/** Put back everything a variant touched: filters, opacity, visibility,
 *  lane emphasis, geometry. */
function restore(map: MlMap) {
  if (!map.getLayer('run-rake')) return
  emphasizeLane(map, null)
  map.setFilter('run-rake', CREST_FILTER as never)
  map.setFilter('run-rake-haze', CREST_FILTER as never)
  map.setPaintProperty('run-rake', 'line-opacity', RAKE_OPACITY as never)
  map.setPaintProperty('run-rake-haze', 'line-opacity', HAZE_OPACITY as never)
  rakeForced = false
  rakeBase = null
  // rebuilds the rake source from the plan and re-applies the layer toggle
  setLaneHighlight(map, null)
}

// ---------- the variants, one step each ----------

function stepComet(map: MlMap, now: number) {
  setLaneHighlight(map, (now % LANE_MS) / LANE_MS)
}

function stepTrail(map: MlMap, now: number) {
  const { lane, p, hold } = cyclePos(now)
  forceRake(map)
  emphasizeLane(map, lane)
  // the front reveals crests behind it; the comet rides the lit lane at its
  // head, so the front has a face and the trail has a cause
  const f =
    lane === 'out'
      ? ['all', CREST_FILTER, ['<=', ['get', 'd'], p]]
      : ['all', CREST_FILTER, ['>=', ['get', 'd'], 1 - p]]
  setLaneHighlight(map, hold ? null : p, lane)
  map.setFilter('run-rake', f as never)
  map.setFilter('run-rake-haze', f as never)
}

function stepWave(map: MlMap, now: number) {
  const { lane, p, hold } = cyclePos(now)
  crestPassFrame(map, lane, p, hold, now)
}

/**
 * One frame of a wave-style crest pass — the briefing's crest act, also
 * selectable as the 'wave' variant. The trail's front and comet, but smooth
 * the whole way: crests FADE in behind the front instead of popping through
 * a filter, and the whole rake drifts the way its own sea travels in sets
 * that rise and dissolve (the march) — so what the front reveals is already
 * moving like water, not like notation.
 */
export function crestPassFrame(
  map: MlMap,
  lane: 'out' | 'back',
  p: number,
  hold: boolean,
  now: number,
) {
  if (!map.getLayer('run-rake')) return
  forceRake(map)
  emphasizeLane(map, lane)
  setLaneHighlight(map, hold ? null : p, lane)
  map.setFilter('run-rake', CREST_FILTER as never)
  map.setFilter('run-rake-haze', CREST_FILTER as never)

  // the march: crests ride their own sea, sets rising and dissolving —
  // the sine envelope is what hides the drift's loop seam
  const src = map.getSource('rake') as GeoJSONSource | undefined
  if (!src) return
  rakeBase ??= structuredClone(src.serialize().data as FeatureCollection)
  const frac = (now % MARCH_MS) / MARCH_MS
  const env = Math.sin(Math.PI * frac)
  src.setData(marchFc(rakeBase, frac))

  // …and the reveal: full strength behind the front, easing to nothing at
  // its edge — a soft shoulder about a tenth of the course long
  const SOFT = 0.1
  const reveal = hold
    ? 1
    : lane === 'out'
      ? ['interpolate', ['linear'], ['get', 'd'],
          Math.max(0, p - SOFT), 1, Math.max(0.0001, p), 0]
      : ['interpolate', ['linear'], ['get', 'd'],
          Math.min(0.9999, 1 - p), 0, Math.min(1, 1 - p + SOFT), 1]
  map.setPaintProperty('run-rake', 'line-opacity', ['*', 0.42 * env, reveal] as never)
  map.setPaintProperty('run-rake-haze', 'line-opacity', ['*', 0.24 * env, reveal] as never)
}

/** Put the chart back to rest after externally driven passes. */
export function crestSettle(map: MlMap) {
  restore(map)
}

// the briefing takes the stage; the ambient loop stands down while it plays
let suspended = false

export function suspendRunAnimation(on: boolean) {
  suspended = on
  if (on) {
    if (raf != null) {
      cancelAnimationFrame(raf)
      raf = null
    }
  } else if (theMap) {
    syncRunAnimation(theMap)
  }
}

function stepRoll(map: MlMap, now: number) {
  const { lane, p, hold } = cyclePos(now)
  forceRake(map)
  emphasizeLane(map, lane)
  // a window of brightness travelling through crests that never move —
  // centred at c, falling away over W of the course either side
  const W = 0.14
  const c = lane === 'out' ? p : 1 - p
  const pulse = [
    'max',
    0,
    ['-', 1, ['/', ['abs', ['-', ['get', 'd'], c]], W]],
  ]
  const dur = hold ? 0 : 1 // the standing beat rests at the faint base
  map.setPaintProperty('run-rake', 'line-opacity', ['+', 0.1, ['*', 0.5 * dur, pulse]] as never)
  map.setPaintProperty('run-rake-haze', 'line-opacity', ['+', 0.06, ['*', 0.24 * dur, pulse]] as never)
}

/** One set of crests, shifted along the way each crest's own sea travels. */
function marchFc(base: FeatureCollection, frac: number): FeatureCollection {
  const shift = (frac - 0.5) * MARCH_SPAN_DEG
  const features: Feature[] = base.features.map((f) => {
    if (f.properties?.kind !== 'crest' || f.geometry.type !== 'LineString') return f
    const dir = f.properties.dir as number
    // waveDir is where the sea comes FROM; the crest travels the other way
    const rad = ((dir + 180) * Math.PI) / 180
    const lat0 = (f.geometry.coordinates[0] as [number, number])[1]
    const kx = 1 / Math.cos((lat0 * Math.PI) / 180)
    const dLat = Math.cos(rad) * shift
    const dLon = Math.sin(rad) * shift * kx
    return {
      ...f,
      geometry: {
        type: 'LineString',
        coordinates: (f.geometry.coordinates as [number, number][]).map(([x, y]) => [
          x + dLon,
          y + dLat,
        ]),
      },
    }
  })
  return { type: 'FeatureCollection', features }
}

function stepMarch(map: MlMap, now: number) {
  const { lane } = cyclePos(now)
  forceRake(map)
  emphasizeLane(map, lane)
  const src = map.getSource('rake') as GeoJSONSource | undefined
  if (!src) return
  if (!rakeBase) {
    // snapshot what routeLayer built, once; invalidated on any route change
    rakeBase = structuredClone(src.serialize().data as FeatureCollection)
  }
  const frac = (now % MARCH_MS) / MARCH_MS
  // sets rise, travel, dissolve — the fade at both ends is what hides the
  // loop's seam, and reads as sea rather than as a conveyor
  const env = Math.sin(Math.PI * frac)
  src.setData(marchFc(rakeBase, frac))
  map.setPaintProperty('run-rake', 'line-opacity', 0.04 + 0.42 * env)
  map.setPaintProperty('run-rake-haze', 'line-opacity', 0.02 + 0.24 * env)
}

// ---------- the loop ----------

function frame(map: MlMap, now: number) {
  raf = null
  if (!map.getLayer('run-out')) return
  if (now - lastStepMs >= FPS_MS) {
    lastStepMs = now
    if (variant === 'comet') stepComet(map, now)
    else if (variant === 'trail') stepTrail(map, now)
    else if (variant === 'roll') stepRoll(map, now)
    else if (variant === 'wave') stepWave(map, now)
    else stepMarch(map, now)
  }
  schedule(map)
}

function schedule(map: MlMap) {
  if (raf != null) return
  raf = requestAnimationFrame((t) => frame(map, t))
}

/** Start or stop the run's motion to match what's on screen. */
export function syncRunAnimation(map: MlMap) {
  rakeBase = null // any reason to be here may have moved the route
  const shouldRun =
    !suspended &&
    !reducedMotion() &&
    !useAppStore.getState().lowPower &&
    document.visibilityState === 'visible' &&
    useRouteStore.getState().route != null

  if (shouldRun) {
    schedule(map)
    return
  }
  if (raf != null) {
    cancelAnimationFrame(raf)
    raf = null
  }
  // held still, everything goes back to its resting look
  restore(map)
}

/** Swap the animation in place — the trial switch. */
export function setRunAnimVariant(v: RunAnimVariant) {
  if (v === variant) return
  variant = v
  if (theMap) {
    restore(theMap)
    syncRunAnimation(theMap)
  }
}

let wired = false

/** Call once, after the layers exist. */
export function initRunAnimation(map: MlMap) {
  theMap = map
  syncRunAnimation(map)
  if (wired) return
  wired = true
  if (import.meta.env.DEV) {
    // drive the trials from the console / a test harness
    const w = window as unknown as Record<string, unknown>
    w.__runAnim = setRunAnimVariant
    void import('../weather/windFlow').then((m) => {
      w.__briefing = (v: string) => m.playBriefing(map, v as never)
    })
    void import('../weather/waveFlow').then((m) => {
      w.__waves = (v: string) => m.playWaveTrial(map, v as never)
    })
    void import('../weather/windFlow').then((m) => {
      w.__windTint = m.setWindFlowTint
    })
  }
  document.addEventListener('visibilitychange', () => syncRunAnimation(map))
  useRouteStore.subscribe((s, prev) => {
    if (s.route !== prev.route || s.plan !== prev.plan) syncRunAnimation(map)
  })
  useAppStore.subscribe((s, prev) => {
    if (s.lowPower !== prev.lowPower) syncRunAnimation(map)
  })
}
