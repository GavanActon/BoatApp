import type { Map as MlMap } from 'maplibre-gl'
import { withMap } from '../map/mapController'
import { crestPassFrame, crestSettle, suspendRunAnimation } from '../routing/runAnimation'
import { useRouteStore } from '../routing/routeStore'
import { useAppStore } from '../state/appStore'
import { ensureWeatherGrid, gridConditionsAt, onWeatherGrid, onWeatherHour } from './weatherLayer'

/**
 * Wind made visible: particles advected by the real forecast grid at the
 * app-wide planning time, drawn as fading streaks on a canvas over the chart.
 *
 * It wears two hats:
 *
 *  - The WIND FLOW layer (Settings → Wind flow): ambient, running for as long
 *    as it's switched on, with a strength slider. The one sanctioned piece of
 *    standing motion on the chart — the user turned it on knowing it moves.
 *
 *  - The BRIEFING: a single on-command performance. The same wind, and the
 *    run plays its crest cycle inside it — the way out lit and swept end to
 *    end, then the way back — then everything settles. Finite on purpose.
 *
 * The particle field is sampled in screen space when a run starts and
 * resampled when the camera comes to rest after a move; while the camera is
 * actually moving the layer stands down, because streaks pinned to a sliding
 * screen read as smearing, not wind. Both hats stop for
 * `prefers-reduced-motion` and a hidden tab.
 */

const LANE_MS = 4600
const HOLD_MS = 900
const FIELD_STEP = 28 // css px between wind samples
// White water, coloured air (chosen 2026-08-30): broken water is white, so
// the sea-flow layer keeps foam; the AIR wears colour. The default hue/sat
// in FLOW_TUNING_DEFAULTS is the app accent; both are Settings knobs.

// trial seam: the composition mocks recolour the streaks; null = the knobs
let tint: string | null = null

export function setWindFlowTint(rgb: string | null) {
  tint = rgb
}
const CORRIDOR_PX = 70 // trial staging: how far off the course particles live

interface FieldGrid {
  step: number
  cols: number
  rows: number
  vx: Float32Array // css px/s
  vy: Float32Array
  live: boolean // any wind at all — an empty grid builds a dead field
}

function buildField(map: MlMap, w: number, h: number, atMs: number): FieldGrid {
  const cols = Math.ceil(w / FIELD_STEP) + 1
  const rows = Math.ceil(h / FIELD_STEP) + 1
  const vx = new Float32Array(cols * rows)
  const vy = new Float32Array(cols * rows)
  let live = false
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ll = map.unproject([c * FIELD_STEP, r * FIELD_STEP])
      const wx = gridConditionsAt(ll.lng, ll.lat, atMs)
      if (!wx) continue
      // blows TOWARD dir+180; screen y grows downward, north is up
      const rad = ((wx.windDir + 180) * Math.PI) / 180
      const speedMul = useAppStore.getState().flowTuning.windSpeed
      const pxps = Math.min(220, Math.max(8, wx.windKn * 4.5 * speedMul))
      vx[r * cols + c] = Math.sin(rad) * pxps
      vy[r * cols + c] = -Math.cos(rad) * pxps
      live = true
    }
  }
  return { step: FIELD_STEP, cols, rows, vx, vy, live }
}

function sampleField(f: FieldGrid, x: number, y: number): [number, number] {
  const fx = Math.min(f.cols - 1.001, Math.max(0, x / f.step))
  const fy = Math.min(f.rows - 1.001, Math.max(0, y / f.step))
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const i = y0 * f.cols + x0
  const vx =
    (f.vx[i] * (1 - tx) + f.vx[i + 1] * tx) * (1 - ty) +
    (f.vx[i + f.cols] * (1 - tx) + f.vx[i + f.cols + 1] * tx) * ty
  const vy =
    (f.vy[i] * (1 - tx) + f.vy[i + 1] * tx) * (1 - ty) +
    (f.vy[i + f.cols] * (1 - tx) + f.vy[i + f.cols + 1] * tx) * ty
  return [vx, vy]
}

/** Distance from a point to the route's screen polyline, in css px. */
function routeDistance(pts: [number, number][], x: number, y: number): number {
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]
    const [bx, by] = pts[i]
    const dx = bx - ax
    const dy = by - ay
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
    const px = ax + dx * t - x
    const py = ay + dy * t - y
    const d = px * px + py * py
    if (d < best) best = d
  }
  return Math.sqrt(best)
}

// ---------- the particle engine, shared by both hats ----------

interface EngineOpts {
  corridor: boolean
  /** Stroke strength right now, 0..1 — polled every frame, so a slider or a
   *  briefing's fade drives it live. */
  level: () => number
}

interface Engine {
  stop: () => void
  /** True when the field found no wind at all (no grid yet). */
  dead: boolean
}

function startEngine(map: MlMap, opts: EngineOpts): Engine {
  const container = map.getContainer()
  const w = container.clientWidth
  const h = container.clientHeight
  const dpr = Math.min(2, window.devicePixelRatio || 1)

  const atMs = useAppStore.getState().planTimeMs ?? Date.now()
  const field = buildField(map, w, h, atMs)
  if (!field.live) return { stop: () => {}, dead: true }

  const canvas = document.createElement('canvas')
  canvas.width = w * dpr
  canvas.height = h * dpr
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;'
  container.appendChild(canvas)
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)
  ctx.lineCap = 'round'

  const route = useRouteStore.getState().route
  const routePts: [number, number][] =
    opts.corridor && route
      ? route.coords.map((c) => {
          const p = map.project(c as [number, number])
          return [p.x, p.y]
        })
      : []
  const corridor = opts.corridor && routePts.length >= 2

  const N = corridor ? 420 : Math.round(useAppStore.getState().flowTuning.windDensity)
  const px = new Float32Array(N)
  const py = new Float32Array(N)
  const age = new Float32Array(N)
  const life = new Float32Array(N)

  const spawn = (i: number) => {
    if (corridor) {
      // a seed on the course, nudged off it — the run's own water, populated
      const t = Math.random() * (routePts.length - 1)
      const s = Math.floor(t)
      const f = t - s
      const ang = Math.random() * Math.PI * 2
      const r = Math.random() * CORRIDOR_PX
      px[i] = routePts[s][0] + (routePts[s + 1][0] - routePts[s][0]) * f + Math.cos(ang) * r
      py[i] = routePts[s][1] + (routePts[s + 1][1] - routePts[s][1]) * f + Math.sin(ang) * r
    } else {
      px[i] = Math.random() * w
      py[i] = Math.random() * h
    }
    age[i] = 0
    life[i] = 1.6 + Math.random() * 2.2
  }
  for (let i = 0; i < N; i++) {
    spawn(i)
    age[i] = Math.random() * life[i] // stagger, so the field is alive at once
  }

  const born = performance.now()
  let last = born
  let raf = 0

  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now

    // trails fade instead of clearing — that IS the streak. Fade rate is a
    // live knob: read per frame so the Settings slider answers immediately.
    ctx.globalCompositeOperation = 'destination-in'
    ctx.fillStyle = `rgba(0, 0, 0, ${useAppStore.getState().flowTuning.windTrail})`
    ctx.fillRect(0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'

    // a short rise from nothing, so switching the layer on breathes in
    const level = opts.level() * Math.min(1, (now - born) / 900)
    for (let i = 0; i < N; i++) {
      age[i] += dt
      const [vx, vy] = sampleField(field, px[i], py[i])
      const nx = px[i] + vx * dt
      const ny = py[i] + vy * dt
      const gone =
        age[i] > life[i] ||
        nx < 0 || nx > w || ny < 0 || ny > h ||
        (vx === 0 && vy === 0) ||
        (corridor && routeDistance(routePts, nx, ny) > CORRIDOR_PX * 1.6)
      if (gone) {
        spawn(i)
        continue
      }
      const spd = Math.hypot(vx, vy)
      const alpha = (0.22 + (spd / 130) * 0.4) * level
      // colour is a knob: hue/saturation from Settings (lightness pinned so
      // contrast on the dark chart survives any slider position)
      const tn = useAppStore.getState().flowTuning
      ctx.strokeStyle = tint
        ? `rgba(${tint}, ${alpha})`
        : `hsla(${tn.windHue}, ${tn.windSat}%, 62%, ${alpha})`
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(px[i], py[i])
      ctx.lineTo(nx, ny)
      ctx.stroke()
      px[i] = nx
      py[i] = ny
    }
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  return {
    dead: false,
    stop: () => {
      cancelAnimationFrame(raf)
      canvas.remove()
    },
  }
}

// ---------- the ambient layer (Settings → Wind flow) ----------

let ambient: Engine | null = null
let cameraMoving = false
let briefingActive = false

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function syncAmbient(map: MlMap) {
  const want =
    useAppStore.getState().layers.windFlow &&
    !cameraMoving &&
    !briefingActive &&
    !reducedMotion() &&
    document.visibilityState === 'visible'

  if (ambient) {
    ambient.stop()
    ambient = null
  }
  if (!want) return
  void ensureWeatherGrid().then(() => {
    // conditions may have changed while the grid loaded
    if (ambient || cameraMoving || briefingActive) return
    if (!useAppStore.getState().layers.windFlow) return
    const eng = startEngine(map, {
      corridor: false,
      level: () => useAppStore.getState().windFlowOpacity,
    })
    if (eng.dead) return // no grid data — onWeatherGrid will retry us
    ambient = eng
  })
}

let wired = false

/** Call once at startup; wires the ambient layer to its switches. */
export function initWindFlow() {
  // StrictMode double-runs effects in dev; two sets of listeners would fight
  if (wired) return
  wired = true
  withMap((map) => {
    syncAmbient(map)
    // a moving camera invalidates the screen-space field — stand down, come
    // back when it settles
    map.on('movestart', () => {
      cameraMoving = true
      syncAmbient(map)
    })
    map.on('moveend', () => {
      cameraMoving = false
      syncAmbient(map)
    })
    map.on('resize', () => syncAmbient(map))
    document.addEventListener('visibilitychange', () => syncAmbient(map))
    useAppStore.subscribe((s, prev) => {
      if (
        s.layers.windFlow !== prev.layers.windFlow ||
        s.planTimeMs !== prev.planTimeMs || // the field is a moment's wind
        // density and speed are baked into the running engine; the other
        // knobs (trail, strength) are read live and need no restart
        s.flowTuning.windDensity !== prev.flowTuning.windDensity ||
        s.flowTuning.windSpeed !== prev.flowTuning.windSpeed
      ) {
        syncAmbient(map)
      }
    })
    onWeatherGrid(() => syncAmbient(map))
    // the field is one hour's wind; when the hour steps, so does the field
    onWeatherHour(() => syncAmbient(map))
  })
}

// ---------- the briefing ----------

export type BriefingVariant = 'ensemble' | 'corridor' | 'acts'

/**
 * One performance: wind streaming while the run plays its crest cycle, then
 * quiet. 'ensemble' is the shipped staging; the other two remain for trials.
 * Resolves when the chart is still again.
 */
export async function playBriefing(map: MlMap, variant: BriefingVariant = 'ensemble'): Promise<void> {
  if (briefingActive) return
  if (reducedMotion()) return
  await ensureWeatherGrid()

  briefingActive = true
  syncAmbient(map) // the ambient layer yields the stage
  suspendRunAnimation(true)

  const hasRun = (useRouteStore.getState().route?.coords.length ?? 0) >= 2

  // ---- the score: what happens when ----
  const crestStart = variant === 'acts' ? 3500 : 800
  const crestLen = hasRun ? (LANE_MS + HOLD_MS) * 2 : 0
  const total = hasRun ? crestStart + crestLen + 1600 : 9000 // wind alone, briefer

  const level = (t: number): number => {
    const fadeIn = Math.min(1, t / 900)
    const fadeOut = Math.min(1, Math.max(0, (total - t) / 1400))
    // in 'acts' the wind yields the stage once the sea starts
    const yielded = variant === 'acts' && t > crestStart ? 0.35 : 1
    return fadeIn * fadeOut * yielded
  }

  const start = performance.now()
  const engine = startEngine(map, {
    corridor: variant === 'corridor',
    level: () => level(performance.now() - start),
  })

  let lastCrest = 0
  await new Promise<void>((done) => {
    const tick = (now: number) => {
      const t = now - start
      const ct = t - crestStart
      if (hasRun && ct >= 0 && ct < crestLen && now - lastCrest >= 40) {
        lastCrest = now
        const half = LANE_MS + HOLD_MS
        const lane = ct < half ? 'out' : 'back'
        const lt = ct % half
        crestPassFrame(map, lane, Math.min(1, lt / LANE_MS), lt >= LANE_MS, now)
      }
      if (hasRun && ct >= crestLen && ct < crestLen + 100) crestSettle(map)
      if (t < total) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  })

  engine.stop()
  if (hasRun) crestSettle(map)
  suspendRunAnimation(false)
  briefingActive = false
  syncAmbient(map) // and the ambient layer takes it back
}
