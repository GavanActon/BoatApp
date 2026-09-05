import type { Map as MlMap } from 'maplibre-gl'
import { getMap, onEachMap, onFirstIdle, withMap } from '../map/mapController'
import { crestPassFrame, crestSettle, suspendRunAnimation } from '../routing/runAnimation'
import { useRouteStore } from '../routing/routeStore'
import { useAppStore } from '../state/appStore'
import { lodOf, meanLod, onQuality, qualityProfile, reportFrame } from './flowQuality'
import {
  centrePoint,
  compose,
  FrameAnchor,
  IDENTITY,
  invert,
  isIdentity,
  same,
  type Affine,
} from './frameAffine'
import { ensureWeatherGrid, onWeatherGrid, onWeatherHour, windSampler } from './weatherLayer'

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
 * The particle field is sampled in screen space when a run starts, and that
 * screen is PINNED to the chart (frameAffine): every frame the pinned frame
 * is carried to wherever the camera has taken it, trails and all, so a pan,
 * a turn at the helm or a pinch slide the wind WITH the chart. When the
 * camera settles the engine re-pins itself there — particles, trails and
 * ages all survive — and resamples the wind under the new view. The engine
 * used to tear itself down and start over on every zoom, bearing or pitch
 * change; at the helm, following the boat course-up, that was every fix.
 * Both hats stop for `prefers-reduced-motion` and a hidden tab.
 *
 * What it costs is on a dial (flowQuality): particle count, trail canvas
 * resolution and frame rate step down when the phone falls behind and back
 * up when it has room, and on a pitched chart the far water carries fewer
 * streaks than the near — the look at full quality is Settings' look.
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
  const speedMul = useAppStore.getState().flowTuning.windSpeed
  // one sampler for the whole lattice: the hour and the grid resolved once
  const wind = windSampler(atMs)
  const out = new Float32Array(2)
  if (wind) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const ll = map.unproject([c * FIELD_STEP, r * FIELD_STEP])
        if (!wind(ll.lng, ll.lat, out)) continue
        // blows TOWARD dir+180; screen y grows downward, north is up
        const rad = ((out[1] + 180) * Math.PI) / 180
        const pxps = Math.min(220, Math.max(8, out[0] * 4.5 * speedMul))
        vx[r * cols + c] = Math.sin(rad) * pxps
        vy[r * cols + c] = -Math.cos(rad) * pxps
        live = true
      }
    }
  }
  return { step: FIELD_STEP, cols, rows, vx, vy, live }
}

/** Writes the sampled velocity into `out`. An allocating version returned a
 *  fresh pair per particle per frame — at a few hundred particles and 60fps
 *  that is tens of thousands of short-lived arrays a second, and the garbage
 *  collector showed up in the profile because of it. */
/** Streak alpha rides speed only, so a dozen bands are indistinguishable
 *  from a per-particle colour and cost a dozen strokes instead of hundreds. */
const ALPHA_BANDS = 12

function sampleField(f: FieldGrid, x: number, y: number, out: Float32Array): void {
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
  out[0] = vx
  out[1] = vy
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
  /** Replacing an engine that was already running: skip the breathe-in fade,
   *  so a rebuild (hour step, density change) doesn't read as the layer restarting. */
  warm?: boolean
}

interface Engine {
  stop: () => void
  /** The camera has settled somewhere: pin the frame there. Every particle,
   *  its trail and its age survive — the wind is carried to where the chart
   *  went and resampled under the new view. Never a blink. */
  rebase: () => void
  /** True when the field found no wind at all (no grid yet). */
  dead: boolean
}

/** How long a camera may keep moving before the wind under it is resampled
 *  anyway — a follow ease ends in a moveend within a second; a flyTo may not. */
const LONG_MOVE_MS = 4000
/** A move that never announced its end: re-pin once it has been still this long. */
const SETTLED_MS = 2500

function startEngine(map: MlMap, opts: EngineOpts): Engine {
  const container = map.getContainer()
  const w = container.clientWidth
  const h = container.clientHeight
  const atMs = () => useAppStore.getState().planTimeMs ?? Date.now()

  let field = buildField(map, w, h, atMs())
  if (!field.live) return { stop: () => {}, rebase: () => {}, dead: true }
  // Where the field was sampled, relative to the pinned frame. A follow
  // step is a few pixels; the wind under the screen is the same wind, so
  // small pans slide the lookup instead of resampling — the field is only
  // rebuilt once the screen has drifted a whole lattice step off it.
  const fieldOff = { x: 0, y: 0 }

  // the trail canvas, at the quality dial's resolution — and a second one
  // of the same size that carries the trails through a camera move
  const canvas = document.createElement('canvas')
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;'
  const carrier = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const cctx = carrier.getContext('2d')!
  let dpr = 0
  const wantDpr = () => Math.min(qualityProfile().trailDpr, window.devicePixelRatio || 1)
  const setDpr = (d: number) => {
    dpr = d
    canvas.width = carrier.width = Math.round(w * d)
    canvas.height = carrier.height = Math.round(h * d)
    ctx.lineCap = 'round' // sizing a canvas resets its context
  }
  setDpr(wantDpr())
  container.appendChild(canvas)

  const route = useRouteStore.getState().route
  const routePts: [number, number][] =
    opts.corridor && route
      ? route.coords.map((c) => {
          const p = map.project(c as [number, number])
          return [p.x, p.y]
        })
      : []
  const corridor = opts.corridor && routePts.length >= 2

  // capacity is what Settings asks for; how many are alive is the dial's
  // call, and on a pitched chart the far water's share is thinned so the
  // near water keeps a flat chart's density
  const N = corridor ? 420 : Math.max(20, Math.round(useAppStore.getState().flowTuning.windDensity))
  const px = new Float32Array(N)
  const py = new Float32Array(N)
  const vel = new Float32Array(2) // sampleField's out-param, reused every particle
  const bands: Path2D[] = new Array(ALPHA_BANDS)
  const age = new Float32Array(N)
  const life = new Float32Array(N)

  // the pinned frame: particles live in the css px of the moment of the last
  // rebase; M carries that frame to today's screen
  let anchor = new FrameAnchor(map, centrePoint(map))
  let M: Affine = IDENTITY
  let Mprev: Affine = IDENTITY
  let Minv: Affine = IDENTITY
  let lod = lodOf(map, h)
  let active = N
  const sizeActive = () => {
    active = corridor
      ? N
      : Math.max(20, Math.min(N, Math.round(N * qualityProfile().particles * meanLod(lod, h))))
  }
  sizeActive()

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
      // somewhere on today's screen, thinned toward the far water of a
      // pitched chart, then into the pinned frame
      let x = Math.random() * w
      let y = Math.random() * h
      for (let t = 0; t < 4 && Math.random() > lod(y); t++) {
        x = Math.random() * w
        y = Math.random() * h
      }
      px[i] = Minv.a * x + Minv.c * y + Minv.e
      py[i] = Minv.b * x + Minv.d * y + Minv.f
    }
    age[i] = 0
    life[i] = 1.6 + Math.random() * 2.2
  }
  for (let i = 0; i < N; i++) {
    spawn(i)
    age[i] = Math.random() * life[i] // stagger, so the field is alive at once
  }

  const born = performance.now() - (opts.warm ? 900 : 0)
  let last = performance.now()
  let drawnAt = last
  let movedAt = 0
  let movingSince = 0
  let raf = 0

  /** Carry the trails through the camera's move since they were drawn. */
  const carry = (delta: Affine) => {
    cctx.setTransform(1, 0, 0, 1, 0, 0)
    cctx.clearRect(0, 0, carrier.width, carrier.height)
    cctx.drawImage(canvas, 0, 0)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // css px in, device px out: the linear part is the same, the shift scales
    ctx.setTransform(delta.a, delta.b, delta.c, delta.d, delta.e * dpr, delta.f * dpr)
    ctx.drawImage(carrier, 0, 0)
  }

  const rebase = () => {
    const now = anchor.current(map)
    if (!same(now, Mprev)) carry(compose(now, invert(Mprev)))
    if (!isIdentity(now)) {
      for (let i = 0; i < N; i++) {
        const x = px[i]
        const y = py[i]
        px[i] = now.a * x + now.c * y + now.e
        py[i] = now.b * x + now.d * y + now.f
      }
      for (const p of routePts) {
        const [x, y] = p
        p[0] = now.a * x + now.c * y + now.e
        p[1] = now.b * x + now.d * y + now.f
      }
    }
    anchor = new FrameAnchor(map, centrePoint(map))
    M = Mprev = Minv = IDENTITY
    movedAt = 0
    movingSince = 0
    // a pure pan of less than a lattice step: slide the lookup, keep the field
    const slid =
      Math.abs(now.a - 1) < 1e-3 && Math.abs(now.d - 1) < 1e-3 && Math.abs(now.b) < 1e-3 && Math.abs(now.c) < 1e-3
    if (slid && Math.hypot(fieldOff.x + now.e, fieldOff.y + now.f) < FIELD_STEP) {
      fieldOff.x += now.e
      fieldOff.y += now.f
    } else {
      field = buildField(map, w, h, atMs())
      fieldOff.x = 0
      fieldOff.y = 0
    }
    lod = lodOf(map, h)
    sizeActive()
    // a resolution change clears the trails; new ones grow in a few frames
    const d = wantDpr()
    if (d !== dpr) setDpr(d)
  }

  const frame = (now: number) => {
    reportFrame(now - last, now)
    last = now
    const q = qualityProfile()

    M = anchor.current(map)
    const moved = !same(M, Mprev)
    if (moved) {
      carry(compose(M, invert(Mprev)))
      Mprev = M
      Minv = invert(M)
      movedAt = now
      movingSince ||= now
    }
    // a move that never said it ended, or one that goes on and on: re-pin
    // so the wind under the particles is today's
    if (!isIdentity(M)) {
      if ((!moved && now - movedAt > SETTLED_MS) || now - movingSince > LONG_MOVE_MS) rebase()
    }

    // under load the wind draws every other frame while the chart is still
    if (q.wind30 && !moved && now - drawnAt < 28) {
      raf = requestAnimationFrame(frame)
      return
    }
    const dt = Math.min(0.05, (now - drawnAt) / 1000)
    drawnAt = now
    // read ONCE: this was a store read per particle per frame
    const tune = useAppStore.getState().flowTuning

    // trails fade instead of clearing — that IS the streak. Fade rate is a
    // live knob: read per frame so the Settings slider answers immediately.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.globalCompositeOperation = 'destination-in'
    ctx.fillStyle = `rgba(0, 0, 0, ${tune.windTrail})`
    ctx.fillRect(0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'

    // draw in the pinned frame, carried to today's screen
    ctx.setTransform(dpr * M.a, dpr * M.b, dpr * M.c, dpr * M.d, dpr * M.e, dpr * M.f)

    // a short rise from nothing, so switching the layer on breathes in
    const level = opts.level() * Math.min(1, (now - born) / 900)
    // Colour is a knob: hue/saturation from Settings (lightness pinned so
    // contrast on the dark chart survives any slider position).
    //
    // Every streak used to set its own strokeStyle and run its own
    // beginPath/stroke — a colour string built, parsed and a native stroke
    // issued per particle per frame. Alpha only rides speed, so it bands
    // without anyone seeing the joins: collect the segments into a dozen
    // Path2Ds and stroke each once.
    for (let b = 0; b < ALPHA_BANDS; b++) bands[b] = new Path2D()
    for (let i = 0; i < active; i++) {
      age[i] += dt
      sampleField(field, px[i] - fieldOff.x, py[i] - fieldOff.y, vel)
      const vx = vel[0]
      const vy = vel[1]
      const nx = px[i] + vx * dt
      const ny = py[i] + vy * dt
      // where that is on today's screen
      const sx = M.a * nx + M.c * ny + M.e
      const sy = M.b * nx + M.d * ny + M.f
      const gone =
        age[i] > life[i] ||
        sx < 0 || sx > w || sy < 0 || sy > h ||
        (vx === 0 && vy === 0) ||
        (corridor && routeDistance(routePts, nx, ny) > CORRIDOR_PX * 1.6)
      if (gone) {
        spawn(i)
        continue
      }
      const spd = Math.hypot(vx, vy)
      const band = Math.min(ALPHA_BANDS - 1, ((spd / 130) * ALPHA_BANDS) | 0)
      const path = bands[band]
      path.moveTo(px[i], py[i])
      path.lineTo(nx, ny)
      px[i] = nx
      py[i] = ny
    }
    ctx.lineWidth = 1.2
    for (let b = 0; b < ALPHA_BANDS; b++) {
      const alpha = (0.22 + ((b + 0.5) / ALPHA_BANDS) * 0.4) * level
      ctx.strokeStyle = tint
        ? `rgba(${tint}, ${alpha})`
        : `hsla(${tune.windHue}, ${tune.windSat}%, 62%, ${alpha})`
      ctx.stroke(bands[b])
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  // the dial moved: the count and the resolution follow at the next re-pin
  const offQuality = onQuality(() => rebase())

  return {
    dead: false,
    rebase,
    stop: () => {
      cancelAnimationFrame(raf)
      offQuality()
      canvas.remove()
    },
  }
}

// ---------- the ambient layer (Settings → Wind flow) ----------

let ambient: Engine | null = null
let briefing: Engine | null = null
let briefingActive = false

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function syncAmbient(map: MlMap) {
  const want =
    useAppStore.getState().layers.windFlow &&
    !useAppStore.getState().lowPower &&
    !briefingActive &&
    !reducedMotion() &&
    document.visibilityState === 'visible'

  const wasLive = !!ambient
  if (ambient) {
    ambient.stop()
    ambient = null
  }
  if (!want) return
  void ensureWeatherGrid().then(() => {
    // conditions may have changed while the grid loaded
    if (ambient || briefingActive) return
    if (!useAppStore.getState().layers.windFlow) return
    const eng = startEngine(map, {
      corridor: false,
      warm: wasLive, // replacing running wind shouldn't breathe in again
      level: () => useAppStore.getState().windFlowOpacity,
    })
    if (eng.dead) return // no grid data — onWeatherGrid will retry us
    ambient = eng
  })
}

let wired = false

// Dev only: singleton engine, same story as the sea's — a hot swap orphans
// the running canvas and doubles the wind. decline() is a Vite noop, so
// accept the update and take the full reload ourselves.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload())

/** Call once at startup; wires the ambient layer to its switches. */
export function initWindFlow() {
  // StrictMode double-runs effects in dev; two sets of listeners would fight
  if (wired) return
  wired = true
  // the map can be replaced — a rebuild after a lost WebGL context, an HMR
  // update — so the camera hooks bind to EVERY map, and the engine on a map
  // that goes away goes with it (its canvas would otherwise stay in the
  // container, drawing over the new chart from a map that no longer exists)
  onEachMap((map) => {
    // after the chart's first settled frame, not racing its first tiles
    onFirstIdle(map, () => syncAmbient(map))
    // engines ride the camera live (the pinned frame); when it settles they
    // re-pin where it stopped — a pan, a zoom, a turn at the helm, none of
    // them restarts the wind
    map.on('moveend', () => {
      briefing?.rebase()
      if (ambient) ambient.rebase()
      else syncAmbient(map)
    })
    map.on('resize', () => syncAmbient(map))
    map.once('remove', () => {
      ambient?.stop()
      ambient = null
    })
  })
  // the switches, once: they act on whichever map is current
  withMap(() => {
    const cur = () => {
      const m = getMap()
      if (m) syncAmbient(m)
    }
    document.addEventListener('visibilitychange', cur)
    useAppStore.subscribe((s, prev) => {
      if (
        s.layers.windFlow !== prev.layers.windFlow ||
        s.lowPower !== prev.lowPower ||
        s.planTimeMs !== prev.planTimeMs || // the field is a moment's wind
        // density and speed are baked into the running engine; the other
        // knobs (trail, strength) are read live and need no restart
        s.flowTuning.windDensity !== prev.flowTuning.windDensity ||
        s.flowTuning.windSpeed !== prev.flowTuning.windSpeed
      ) {
        cur()
      }
    })
    onWeatherGrid(cur)
    // the field is one hour's wind; when the hour steps, so does the field
    onWeatherHour(cur)
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
  briefing = engine

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
  briefing = null
  if (hasRun) crestSettle(map)
  suspendRunAnimation(false)
  briefingActive = false
  syncAmbient(map) // and the ambient layer takes it back
}
