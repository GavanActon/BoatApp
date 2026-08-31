import type { Map as MlMap } from 'maplibre-gl'
import { depthAt } from '../map/depthGrid'
import { withMap } from '../map/mapController'
import { useAppStore } from '../state/appStore'
import { seaColor } from './seaState'
import { ensureWeatherGrid, gridConditionsAt, onWeatherGrid, onWeatherHour } from './weatherLayer'

/**
 * TRIAL: the sea itself, animated — the wave sibling of the wind-flow layer.
 *
 * Three renderings of the same real field (height, period, direction from the
 * forecast grid at the planning time), all strictly clipped to water by the
 * offline depth grid — waves stop at the shoreline because the lookup does.
 * Where the marine model has no data (rivers, tight bays) nothing is drawn,
 * which is honest twice over.
 *
 *  'swell'   — crest bands everywhere on the water: the run's rake grown into
 *              weather. Band spacing and length come from the real wavelength
 *              (deep water: ~1.56·T² m), each band drifting the way its sea
 *              travels and dissolving as the next rises.
 *  'heave'   — no marks at all: the water breathes. Travelling bands of
 *              light and shadow roll across the surface — crest brightens,
 *              trough darkens — amplitude from height, wavelength from period.
 *  'bobbers' — nothing travels: a raft of moored dots, each rising and
 *              falling as the sea passes under it. The phase rolls through
 *              the raft at the swell's own pace — wind moves ACROSS the
 *              water, waves move THROUGH it.
 *
 * Deliberately distinct from the wind streaks: wind translates, the sea
 * oscillates — coloured air over white water. Directions are true; pace is
 * the Settings speed knob times the sea's real phase speed.
 *
 * The foam swell ships as the SEA FLOW layer (initSeaFlow, Settings toggle +
 * tuning sliders). The other renderings stay reachable through the dev trial
 * hook window.__waves(variant).
 */

export type WaveTrialVariant =
  | 'swell' // natural swell, foam palette
  | 'swell-size' // natural swell wearing the sea-state ramp colour
  | 'swell-shadow' // natural swell as sculpted light + shadow
  | 'heave'
  | 'bobbers'
  | 'off'

interface WavePt {
  x: number
  y: number
  amp: number // 0..1 from height
  h: number // raw height, m — the size palette colours from it
  ux: number // unit vector of travel, screen space
  uy: number
  wlPx: number // wavelength in css px at this zoom (clamped legible)
  spdPx: number // phase speed, px/s (exaggerated, direction true)
  seed: number // decorrelates neighbouring points
  lenS: number // per-crest length variation
  bow: number // per-crest forward curvature
  pj: number // small phase jitter, so fronts are ragged, not machined
  /** Stroke weights, baked from EFFECTIVE height: glassy water draws as a
   *  hairline sheen, big water as bold crests. */
  wCore: number
  wHalo: number
  /** Depth is felt: waves steep enough for the bottom under them (effective
   *  height past ~0.72·depth) break — drawn as churned white spray. */
  breaking: boolean
  /** True when this anchor's drift sweep grazes land — its crest is then
   *  water-tested per frame so nothing ever laps onto the shore. */
  edge: boolean
}

const TIME_SCALE = 4 // real phase speed is a crawl at chart zoom
const FULL_AMP_M = 1.5 // this height = full-strength rendering
const MIN_WATER_M = 0.3

let stopFn: (() => void) | null = null
let current: WaveTrialVariant = 'off'

function buildPoints(map: MlMap, stepPx: number): WavePt[] {
  const el = map.getContainer()
  const w = el.clientWidth
  const h = el.clientHeight
  const atMs = useAppStore.getState().planTimeMs ?? Date.now()

  // metres per css px at centre, for wavelength→px
  const c = map.getCenter()
  const p0 = map.project([c.lng, c.lat])
  const ll1 = map.unproject([p0.x + 100, p0.y])
  const mPerPx =
    (Math.abs(ll1.lng - c.lng) * 111320 * Math.cos((c.lat * Math.PI) / 180)) / 100 || 1

  /** Water (deep enough) at a SCREEN position — the shoreline test. */
  const waterAt = (sx: number, sy: number): boolean => {
    const q = map.unproject([sx, sy])
    const dq = depthAt(q.lng, q.lat)
    return dq != null && dq >= MIN_WATER_M
  }

  const lenMul = useAppStore.getState().flowTuning.seaLength

  const pts: WavePt[] = []
  for (let gy = stepPx / 2; gy < h; gy += stepPx) {
    for (let gx = stepPx / 2; gx < w; gx += stepPx) {
      // jittered off the lattice — rows of marks read as ruling, water doesn't
      const x = gx + (Math.random() - 0.5) * stepPx * 0.8
      const y = gy + (Math.random() - 0.5) * stepPx * 0.8
      const ll = map.unproject([x, y])
      const d = depthAt(ll.lng, ll.lat)
      if (d == null || d < MIN_WATER_M) continue // the shoreline is the edge
      const wx = gridConditionsAt(ll.lng, ll.lat, atMs)
      if (!wx || wx.waveM == null || wx.waveM <= 0.02 || wx.waveDir == null) continue
      const T = wx.wavePeriodS ?? 3
      const rad = ((wx.waveDir + 180) * Math.PI) / 180 // travels away from FROM
      const wlM = 1.56 * T * T
      const ux = Math.sin(rad)
      const uy = -Math.cos(rad)

      // ---- shoaling: the wave feels the bottom (#4) ----
      // In water shallower than about half a wavelength, crests shorten
      // (L = L0·tanh(2πd/L0)), slow (c ∝ √that), and stack up taller
      // (green's-law-ish Ks ≈ 1/√tanh, capped). Steep enough for the depth
      // under it — H > ~0.72·d — and the crest BREAKS. All of it reads off
      // the offline depth grid, so the bar off the Sandies wears real surf
      // while the deep water behind it rolls easy.
      const shoal = Math.tanh((2 * Math.PI * d) / wlM)
      const Ks = Math.min(1.6, 1 / Math.sqrt(Math.max(0.15, shoal)))
      const hEff = wx.waveM * Ks
      const breaking = hEff > 0.72 * d

      // ---- character: the sea's size decides how it draws (#1) ----
      // Glassy: sparse, long, hairline sheen. Building: denser, shorter,
      // choppier. Big: bold long-crested fronts. Density through a keep
      // chance, so calm water isn't wallpapered with marks.
      const keep = Math.min(1, 0.4 + hEff / 1.3)
      if (Math.random() > keep) continue
      const sizeT = Math.min(1, hEff / 1.8)
      const wCore = hEff < 0.35 ? 1.3 : 1.6 + 1.9 * sizeT
      const wHalo = wCore * 2.9
      const regimeLen = hEff < 0.35 ? 1.35 : hEff < 0.8 ? 0.9 : 1.12

      const wlPx = Math.min(220, Math.max(26, (wlM * shoal) / mPerPx))
      const lenS = (0.65 + Math.random() * 0.85) * regimeLen

      // The anchor is wet, but the crest is a BAND that also drifts up to
      // half a wavelength either way — near shore that sweep can lap onto
      // land. The band at rest must be wholly wet or the anchor is dropped;
      // an anchor whose full sweep grazes land is kept but flagged, and its
      // crest is water-tested per frame instead.
      const lenPx = Math.min(34, 8 + wlPx * 0.15) * lenS * lenMul
      const bx = -uy * lenPx
      const by = ux * lenPx
      if (!waterAt(x + bx, y + by) || !waterAt(x - bx, y - by)) continue
      const hw = wlPx / 2
      const edge = [1, -1].some(
        (s) =>
          !waterAt(x + ux * hw * s + bx, y + uy * hw * s + by) ||
          !waterAt(x + ux * hw * s - bx, y + uy * hw * s - by) ||
          !waterAt(x + ux * hw * s, y + uy * hw * s),
      )

      pts.push({
        x,
        y,
        // effective (shoaled) height drives strength — a lower floor than
        // before, so glassy water really is a whisper
        amp: Math.min(1, Math.max(0.18, hEff / FULL_AMP_M)),
        h: hEff,
        ux,
        uy,
        wlPx,
        // shoaled crests also slow down, the way real ones do
        spdPx: Math.min(30, Math.max(5, (1.56 * T * TIME_SCALE * Math.sqrt(shoal)) / mPerPx)),
        seed: Math.random() * Math.PI * 2,
        lenS,
        bow: 0.12 + Math.random() * 0.22,
        pj: (Math.random() - 0.5) * 0.9,
        wCore,
        wHalo,
        breaking,
        edge,
      })
    }
  }
  return pts
}

/** '#a8ece4' → 'r, g, b' for alpha-composed strokes. */
function rgbOf(hex: string): string {
  return `${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}`
}

function makeCanvas(
  map: MlMap,
  z = 2,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; w: number; h: number } {
  const el = map.getContainer()
  const w = el.clientWidth
  const h = el.clientHeight
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const canvas = document.createElement('canvas')
  canvas.width = w * dpr
  canvas.height = h * dpr
  // the sea sits at z 1, UNDER the wind's z 2 — air over water, like outside
  canvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:${z};`
  el.appendChild(canvas)
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)
  ctx.lineCap = 'round'
  return { canvas, ctx, w, h }
}

/** Phase of the travelling wave under a point — position along the direction
 *  of travel, minus time. Neighbouring points therefore peak in sequence,
 *  which is what makes the phase visibly ROLL through the field. */
function phaseAt(p: WavePt, t: number): number {
  const k = (2 * Math.PI) / p.wlPx
  return k * (p.x * p.ux + p.y * p.uy) - k * p.spdPx * t
}

type SwellPalette = 'foam' | 'size' | 'shadow'

/**
 * The natural swell. What made the first cut look mechanical was that every
 * mark kept its own clock: neighbours twinkled independently, so the eye saw
 * a lattice blinking. Here every crest takes its phase from POSITION along
 * the direction of travel — the same travelling wave the heave and bobbers
 * use — so neighbouring marks on one wavefront rise together and the broken
 * segments join up into fronts that genuinely march across the bay. Jittered
 * anchors, varied lengths, a slight forward bow and a touch of phase raggedness
 * keep it water rather than ruling.
 */
function runSwell(map: MlMap, palette: SwellPalette, resync: () => void = () => {}): () => void {
  const pts = buildPoints(map, useAppStore.getState().flowTuning.seaSpacing)
  const { canvas, ctx, w, h } = makeCanvas(map, 1)
  let drift = { x: 0, y: 0 }
  // the per-frame shoreline check for edge-flagged anchors only. Anchors
  // live in the START frame; drift maps them to today's screen, and only
  // there does unproject speak the truth.
  const waterAt = (sx: number, sy: number): boolean => {
    const q = map.unproject([sx + drift.x, sy + drift.y])
    const dq = depthAt(q.lng, q.lat)
    return dq != null && dq >= MIN_WATER_M
  }
  // geographic anchoring, same scheme as the wind engine: translation rides
  // along live, a reshaped camera clears and waits for a rebuild
  const refLL = map.unproject([0, 0])
  const camKey = () =>
    `${map.getZoom().toFixed(3)}|${map.getBearing().toFixed(1)}|${map.getPitch().toFixed(1)}`
  const cam0 = camKey()
  let invalidSince = 0
  let raf = 0
  // the sea's own clock: advanced by dt × the speed knob, so dragging the
  // slider changes pace smoothly instead of teleporting every crest
  let clock = 0
  let last = performance.now()
  const frame = (now: number) => {
    const tune = useAppStore.getState().flowTuning
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    clock += dt * tune.seaSpeed
    ctx.clearRect(0, 0, w, h)
    if (camKey() !== cam0) {
      invalidSince ||= now
      if (now - invalidSince > 1200) resync()
      else raf = requestAnimationFrame(frame)
      return
    }
    invalidSince = 0
    drift = map.project(refLL)
    ctx.save()
    ctx.translate(drift.x, drift.y)
    for (const p of pts) {
      const k = (2 * Math.PI) / p.wlPx
      // spdPx was baked at TIME_SCALE; divide back to the true phase speed —
      // the speed knob alone decides how far from honest the motion runs
      const phase = k * (p.x * p.ux + p.y * p.uy) - k * (p.spdPx / TIME_SCALE) * clock + p.pj
      const frac = ((phase / (2 * Math.PI)) % 1 + 1) % 1
      // the crest passing this anchor: rises, crosses, dies within one
      // wavelength — and because phase is spatial, the whole front does
      const off = (0.5 - frac) * p.wlPx
      const fade = Math.cos((Math.PI * off) / p.wlPx) ** 2
      const a = fade * p.amp * tune.seaOpacity
      if (a < 0.02) continue
      const cx = p.x + p.ux * off
      const cy = p.y + p.uy * off
      const len = Math.min(34, 8 + p.wlPx * 0.15) * p.lenS * tune.seaLength
      // the band lies ACROSS the travel, bowing gently the way it's going
      const bx = -p.uy * len
      const by = p.ux * len
      // an anchor whose sweep grazes land checks its actual crest position —
      // the sea washes UP TO the shore, never onto it
      if (p.edge && (!waterAt(cx, cy) || !waterAt(cx + bx, cy + by) || !waterAt(cx - bx, cy - by)))
        continue
      const bow = p.bow * tune.seaCurve
      const qx = cx + p.ux * bow * len
      const qy = cy + p.uy * bow * len

      const arc = (scale: number) => {
        ctx.beginPath()
        ctx.moveTo(cx - bx * scale, cy - by * scale)
        ctx.quadraticCurveTo(qx, qy, cx + bx * scale, cy + by * scale)
        ctx.stroke()
      }

      if (palette === 'shadow') {
        // the trough holds shadow just behind the crest; the crest keeps a
        // bright rim — the water sculpted, not marked
        const sx = -p.ux * p.wlPx * 0.16
        const sy = -p.uy * p.wlPx * 0.16
        ctx.save()
        ctx.translate(sx, sy)
        ctx.strokeStyle = `rgba(5, 14, 26, ${(0.42 * a).toFixed(3)})`
        ctx.lineWidth = p.wHalo * 1.2
        arc(1)
        ctx.restore()
        ctx.strokeStyle = `rgba(214, 234, 248, ${(0.7 * a).toFixed(3)})`
        ctx.lineWidth = Math.max(1.2, p.wCore * 0.85)
        arc(0.9)
      } else if (palette === 'size') {
        const rgb = rgbOf(seaColor(p.h))
        ctx.strokeStyle = `rgba(${rgb}, ${(0.3 * a).toFixed(3)})`
        ctx.lineWidth = p.wHalo
        arc(1)
        ctx.strokeStyle = `rgba(${rgb}, ${(0.8 * a).toFixed(3)})`
        ctx.lineWidth = p.wCore
        arc(0.82)
      } else {
        // foam, but foam with a colour knob: hue/saturation from Settings,
        // lightness pinned high so the crests stay the white of broken water
        ctx.strokeStyle = `hsla(${tune.seaHue}, ${tune.seaSat * 0.8}%, 84%, ${(0.3 * a).toFixed(3)})`
        ctx.lineWidth = p.wHalo
        arc(1)
        ctx.strokeStyle = `hsla(${tune.seaHue}, ${tune.seaSat}%, 92%, ${(0.8 * a).toFixed(3)})`
        ctx.lineWidth = p.wCore
        arc(0.82)
      }
      if (p.breaking) {
        // surf: the crest tumbles — a ragged bright spray line just ahead
        // of the front, the one place the sea gets to be louder than data
        ctx.setLineDash([2.5, 4])
        ctx.strokeStyle = `rgba(244, 250, 254, ${(0.85 * a).toFixed(3)})`
        ctx.lineWidth = 1.5
        arc(0.62)
        ctx.setLineDash([])
      }
    }
    ctx.restore()
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  return () => {
    cancelAnimationFrame(raf)
    canvas.remove()
  }
}

function runHeave(map: MlMap): () => void {
  const pts = buildPoints(map, 16)
  const { canvas, ctx, w, h } = makeCanvas(map)
  const r = 13
  let raf = 0
  const frame = () => {
    const t = performance.now() / 1000
    ctx.clearRect(0, 0, w, h)
    for (const p of pts) {
      const s = Math.sin(phaseAt(p, t))
      const a = s * s * p.amp
      if (a < 0.02) continue
      // crest catches light, trough holds shadow — the surface, not a symbol
      ctx.fillStyle =
        s > 0
          ? `rgba(196, 226, 244, ${(0.42 * a).toFixed(3)})`
          : `rgba(6, 16, 28, ${(0.5 * a).toFixed(3)})`
      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  return () => {
    cancelAnimationFrame(raf)
    canvas.remove()
  }
}

function runBobbers(map: MlMap): () => void {
  const pts = buildPoints(map, 30)
  const { canvas, ctx, w, h } = makeCanvas(map)
  let raf = 0
  const frame = () => {
    const t = performance.now() / 1000
    ctx.clearRect(0, 0, w, h)
    for (const p of pts) {
      const s = 0.5 + 0.5 * Math.sin(phaseAt(p, t))
      const lift = s * p.amp
      ctx.fillStyle = `rgba(180, 220, 240, ${(0.2 + 0.6 * lift).toFixed(3)})`
      ctx.beginPath()
      ctx.arc(p.x, p.y, 1.1 + 2.1 * lift, 0, Math.PI * 2)
      ctx.fill()
    }
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  return () => {
    cancelAnimationFrame(raf)
    canvas.remove()
  }
}

// ---------- the ambient layer (Settings → Sea flow) ----------

let seaStop: (() => void) | null = null
let seaWired = false
let seaResyncQueued = false

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** A rebuild requested from inside the engine's own frame — defer a tick so
 *  it isn't torn down mid-draw. */
function queueSeaResync(map: MlMap) {
  if (seaResyncQueued) return
  seaResyncQueued = true
  setTimeout(() => {
    seaResyncQueued = false
    syncSea(map)
  }, 0)
}

function syncSea(map: MlMap) {
  seaStop?.()
  seaStop = null
  const want =
    useAppStore.getState().layers.seaFlow &&
    current === 'off' && // a console trial owns the water while it runs
    !reducedMotion() &&
    document.visibilityState === 'visible'
  if (!want) return
  void ensureWeatherGrid().then(() => {
    if (seaStop || current !== 'off') return
    if (!useAppStore.getState().layers.seaFlow) return
    seaStop = runSwell(map, 'foam', () => queueSeaResync(map))
  })
}

/** Call once at startup; wires the sea to its switches. */
export function initSeaFlow() {
  // StrictMode double-runs effects in dev; two sets of listeners would fight
  if (seaWired) return
  seaWired = true
  withMap((map) => {
    syncSea(map)
    // same rule as the wind: translation rides along live (anchoring); a
    // finished move is when the anchors resample for the new viewport
    map.on('moveend', () => syncSea(map))
    map.on('resize', () => syncSea(map))
    document.addEventListener('visibilitychange', () => syncSea(map))
    useAppStore.subscribe((s, prev) => {
      if (
        s.layers.seaFlow !== prev.layers.seaFlow ||
        s.planTimeMs !== prev.planTimeMs || // the field is a moment's sea
        // spacing and length are baked into the anchors (length shapes the
        // shoreline envelope); the other knobs are live
        s.flowTuning.seaSpacing !== prev.flowTuning.seaSpacing ||
        s.flowTuning.seaLength !== prev.flowTuning.seaLength
      ) {
        syncSea(map)
      }
    })
    onWeatherGrid(() => syncSea(map))
    // the field is one hour's sea; when the hour steps, so does the field
    onWeatherHour(() => syncSea(map))
  })
}

/** Start a trial variant (stopping any other), or 'off'. Trials borrow the
 *  water from the ambient layer and hand it back on 'off'. */
export async function playWaveTrial(map: MlMap, variant: WaveTrialVariant): Promise<void> {
  stopFn?.()
  stopFn = null
  current = variant
  syncSea(map) // yields while a trial runs, returns on 'off'
  if (variant === 'off') return
  await ensureWeatherGrid()
  if (current !== variant) return // superseded while the grid loaded
  stopFn =
    variant === 'heave'
      ? runHeave(map)
      : variant === 'bobbers'
        ? runBobbers(map)
        : runSwell(map, variant === 'swell-size' ? 'size' : variant === 'swell-shadow' ? 'shadow' : 'foam')
}
