import type { Map as MlMap } from 'maplibre-gl'
import { depthAt, onDepthGrid } from '../map/depthGrid'
import { getMap, onEachMap, onFirstIdle, withMap } from '../map/mapController'
import { useAppStore } from '../state/appStore'
import { lodOf, qualityProfile, reportFrame } from './flowQuality'
import {
  applyX,
  applyY,
  centrePoint,
  FrameAnchor,
  IDENTITY,
  isIdentity,
  same,
  scaleOf,
  type Affine,
} from './frameAffine'
import { seaColor } from './seaState'
import { ensureWeatherGrid, onWeatherGrid, onWeatherHour, seaSampler, type SeaSample } from './weatherLayer'

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
 *
 * The swell's anchors live in a screen frame PINNED to the chart
 * (frameAffine): the camera carries them live, and when it settles the
 * engine re-pins itself there — every crest keeps its place on its wave —
 * and grows anchors into whatever water the move revealed. Nothing blinks
 * on a pan, a pinch or a turn at the helm. On a pitched chart the far water
 * carries fewer crests than the near, and under load the quality dial thins
 * them further (flowQuality); still, it draws thirty frames a second — the
 * crests crawl, and more frames show nothing more.
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
  /** Lattice cell this anchor grew from (pinned frame), so pruning a
   *  far-offscreen crest also forgets the cell and it can regrow on return. */
  key: string
  /** Where this crest stands in the thinning order, 0..1: the quality dial
   *  draws the anchors ranked under its share and skips the rest, so
   *  turning the dial neither rebuilds nor reshuffles the sea. */
  rank: number
  /** Grown in the far water of a pitched chart, where the dial thins harder. */
  far: boolean
}

const TIME_SCALE = 4 // real phase speed is a crawl at chart zoom
/** Gain on the Strength slider: 80% today = 100% before the wind default dropped */
const SEA_GAIN = 1.25
const FULL_AMP_M = 1.5 // this height = full-strength rendering
const MIN_WATER_M = 0.3
/** The crests crawl: at most 30 px/s, under a pixel a frame — thirty frames a
 *  second show everything sixty would. While the camera moves the sea draws
 *  every frame, so it never lags the chart under it. */
const STILL_FRAME_MS = 28
/** How long a camera may keep moving before the anchors are re-pinned anyway. */
const LONG_MOVE_MS = 4000
/** A move that never announced its end: re-pin once it has been still this long. */
const SETTLED_MS = 2500

let stopFn: (() => void) | null = null
let current: WaveTrialVariant = 'off'

/** Metres per css px at the map centre, for wavelength→px. */
function metresPerPx(map: MlMap): number {
  const c = map.getCenter()
  const p0 = map.project([c.lng, c.lat])
  const ll1 = map.unproject([p0.x + 100, p0.y])
  return (Math.abs(ll1.lng - c.lng) * 111320 * Math.cos((c.lat * Math.PI) / 180)) / 100 || 1
}

/**
 * One crest anchor, or null where the sea declines to stand one. `x, y` are
 * css px in the CALLER'S frame; `toLL` and `waterAt` translate that frame to
 * the world. Same recipe everywhere: depth, forecast, shoaling, character,
 * and the shoreline envelope. `lodW` is how much of the full density this
 * spot on the screen gets — all of it near the boat, less in the far water
 * of a pitched chart.
 */
function swellAnchor(
  key: string,
  x: number,
  y: number,
  sea: SeaSample,
  mPerPx: number,
  lenMul: number,
  lodW: number,
  toLL: (sx: number, sy: number) => { lng: number; lat: number },
  waterAt: (sx: number, sy: number) => boolean,
): WavePt | null {
  const ll = toLL(x, y)
  const d = depthAt(ll.lng, ll.lat)
  if (d == null || d < MIN_WATER_M) return null // the shoreline is the edge
  const wx = sea(ll.lng, ll.lat)
  if (!wx || wx.waveM <= 0.02) return null
  const T = wx.wavePeriodS ?? 3
  const rad = ((wx.waveDir + 180) * Math.PI) / 180 // travels away from FROM
  const wlM = 1.56 * T * T
  const ux = Math.sin(rad)
  const uy = -Math.cos(rad)

  // ---- shoaling: the wave feels the bottom ----
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

  // ---- character: the sea's size decides how it draws ----
  // Glassy: sparse, long, hairline sheen. Building: denser, shorter,
  // choppier. Big: bold long-crested fronts. Density through a keep
  // chance, so calm water isn't wallpapered with marks — and thinner in
  // the far water of a pitched chart, where a pixel is many times the lake.
  const keep = Math.min(1, 0.4 + hEff / 1.3) * lodW
  if (Math.random() > keep) return null
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
  if (!waterAt(x + bx, y + by) || !waterAt(x - bx, y - by)) return null
  const hw = wlPx / 2
  const edge = [1, -1].some(
    (sgn) =>
      !waterAt(x + ux * hw * sgn + bx, y + uy * hw * sgn + by) ||
      !waterAt(x + ux * hw * sgn - bx, y + uy * hw * sgn - by) ||
      !waterAt(x + ux * hw * sgn, y + uy * hw * sgn),
  )

  return {
    key,
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
    rank: Math.random(),
    far: lodW < 0.999,
  }
}

/** The whole screen's anchors at once, for the trial renderings that don't
 *  ride the camera (heave, bobbers). */
function buildPoints(map: MlMap, stepPx: number): WavePt[] {
  const el = map.getContainer()
  const w = el.clientWidth
  const h = el.clientHeight
  const sea = seaSampler(useAppStore.getState().planTimeMs ?? Date.now())
  if (!sea) return []
  const mPerPx = metresPerPx(map)
  const lenMul = useAppStore.getState().flowTuning.seaLength
  const toLL = (sx: number, sy: number) => map.unproject([sx, sy])
  const waterAt = (sx: number, sy: number): boolean => {
    const q = map.unproject([sx, sy])
    const dq = depthAt(q.lng, q.lat)
    return dq != null && dq >= MIN_WATER_M
  }

  const pts: WavePt[] = []
  for (let gy = stepPx / 2; gy < h; gy += stepPx) {
    for (let gx = stepPx / 2; gx < w; gx += stepPx) {
      // jittered off the lattice — rows of marks read as ruling, water doesn't
      const x = gx + (Math.random() - 0.5) * stepPx * 0.8
      const y = gy + (Math.random() - 0.5) * stepPx * 0.8
      const pt = swellAnchor(`${gx}|${gy}`, x, y, sea, mPerPx, lenMul, 1, toLL, waterAt)
      if (pt) pts.push(pt)
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
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; w: number; h: number; dpr: number } {
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
  return { canvas, ctx, w, h, dpr }
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
export interface SwellEngine {
  stop: () => void
  /** The camera has settled somewhere: pin the frame there. Every crest
   *  keeps its place on its wave; anchors grow into the water the move
   *  revealed and the far field is forgotten. A drag never blinks the sea. */
  rebase: () => void
}

function runSwell(
  map: MlMap,
  palette: SwellPalette,
  // reduced motion stills the water instead of erasing it: the crests are
  // DATA — sea state, surf over the bar — not decoration. One frozen frame,
  // redrawn only when the field changes.
  animate = true,
): SwellEngine {
  const stepPx = useAppStore.getState().flowTuning.seaSpacing
  const { canvas, ctx, w, h, dpr } = makeCanvas(map, 1)
  // one sampler for the engine's life: the hour and the grid resolved once
  // (the hour stepping, or a new grid, restarts the engine)
  const sea = seaSampler(useAppStore.getState().planTimeMs ?? Date.now())
  const lenMul = useAppStore.getState().flowTuning.seaLength
  let mPerPx = metresPerPx(map)

  // the pinned frame: anchors live in the css px of the last rebase; M
  // carries that frame to today's screen
  let anchor = new FrameAnchor(map, centrePoint(map))
  let M: Affine = IDENTITY
  let Mprev: Affine = IDENTITY
  let lod = lodOf(map, h)
  const pts: WavePt[] = []
  const tried = new Set<string>()
  const cellKey = (x: number, y: number) =>
    `${Math.floor(x / stepPx) * stepPx + stepPx / 2}|${Math.floor(y / stepPx) * stepPx + stepPx / 2}`

  // pinned-frame px → the world, through wherever the camera is now
  const toLL = (sx: number, sy: number) => map.unproject([applyX(M, sx, sy), applyY(M, sx, sy)])
  const waterAt = (sx: number, sy: number): boolean => {
    const q = toLL(sx, sy)
    const dq = depthAt(q.lng, q.lat)
    return dq != null && dq >= MIN_WATER_M
  }

  // Fill every untried lattice cell on the screen (the pinned frame IS the
  // screen right after a rebase), then forget crests far outside it so a
  // long cruise around the chart doesn't hoard anchors. Forgetting deletes
  // the cell key too: sail back and the water regrows — offscreen, so
  // nothing ever pops.
  const extend = () => {
    if (!sea) return
    for (let gy = stepPx / 2; gy < h; gy += stepPx) {
      for (let gx = stepPx / 2; gx < w; gx += stepPx) {
        const key = `${gx}|${gy}`
        if (tried.has(key)) continue
        tried.add(key)
        // jittered off the lattice — rows of marks read as ruling, water doesn't
        const x = gx + (Math.random() - 0.5) * stepPx * 0.8
        const y = gy + (Math.random() - 0.5) * stepPx * 0.8
        const pt = swellAnchor(key, x, y, sea, mPerPx, lenMul, lod(y), toLL, waterAt)
        if (pt) pts.push(pt)
      }
    }
    const keepR = Math.max(w, h) * 1.6
    const cx = w / 2
    const cy = h / 2
    for (let i = pts.length - 1; i >= 0; i--) {
      if (Math.abs(pts[i].x - cx) > keepR || Math.abs(pts[i].y - cy) > keepR) {
        tried.delete(pts[i].key)
        pts.splice(i, 1)
      }
    }
    if (!animate) raf = requestAnimationFrame(frame) // one still frame, no loop
  }

  const rebase = () => {
    const now = anchor.current(map)
    if (!isIdentity(now)) {
      const s = scaleOf(now)
      for (const p of pts) {
        // the phase is position along the travel: remember it, so the
        // crest stays where it was on its wave through the move
        const before = ((2 * Math.PI) / p.wlPx) * (p.x * p.ux + p.y * p.uy)
        const x = p.x
        const y = p.y
        p.x = applyX(now, x, y)
        p.y = applyY(now, x, y)
        // the direction through the linear part, kept unit
        const ux = now.a * p.ux + now.c * p.uy
        const uy = now.b * p.ux + now.d * p.uy
        const n = Math.hypot(ux, uy) || 1
        p.ux = ux / n
        p.uy = uy / n
        p.wlPx *= s
        p.spdPx *= s
        const after = ((2 * Math.PI) / p.wlPx) * (p.x * p.ux + p.y * p.uy)
        p.pj += before - after
      }
      // the lattice is the screen's: re-key every anchor to its cell there
      tried.clear()
      for (const p of pts) {
        p.key = cellKey(p.x, p.y)
        tried.add(p.key)
      }
    }
    anchor = new FrameAnchor(map, centrePoint(map))
    M = Mprev = IDENTITY
    movedAt = 0
    movingSince = 0
    mPerPx = metresPerPx(map)
    lod = lodOf(map, h)
    extend()
  }

  let raf = 0
  // the sea's own clock: advanced by dt × the speed knob, so dragging the
  // slider changes pace smoothly instead of teleporting every crest
  let clock = 0
  let last = performance.now()
  let drawnAt = last
  let movedAt = 0
  let movingSince = 0
  const frame = (now: number) => {
    reportFrame(now - last, now)
    last = now
    M = anchor.current(map)
    const moved = !same(M, Mprev)
    if (moved) {
      Mprev = M
      movedAt = now
      movingSince ||= now
    }
    // a move that never said it ended, or one that goes on and on
    if (!isIdentity(M)) {
      if ((!moved && now - movedAt > SETTLED_MS) || now - movingSince > LONG_MOVE_MS) rebase()
    }
    // still chart, crawling crests: every other frame is plenty
    if (animate && !moved && now - drawnAt < STILL_FRAME_MS) {
      raf = requestAnimationFrame(frame)
      return
    }
    const tune = useAppStore.getState().flowTuning
    const q = qualityProfile()
    const dt = Math.min(0.05, (now - drawnAt) / 1000)
    drawnAt = now
    clock += dt * tune.seaSpeed
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    // draw in the pinned frame, carried to today's screen
    ctx.setTransform(dpr * M.a, dpr * M.b, dpr * M.c, dpr * M.d, dpr * M.e, dpr * M.f)
    for (const p of pts) {
      // the dial's share: the crests ranked under it draw, the rest wait
      if (p.rank > (p.far ? q.far : q.near)) continue
      // off the screen — a crest carried out of view on a long leg still
      // lives (it is back the moment the boat turns) but is not stroked
      const sx = M.a * p.x + M.c * p.y + M.e
      const sy = M.b * p.x + M.d * p.y + M.f
      const margin = p.wlPx * 0.5 + 60
      if (sx < -margin || sx > w + margin || sy < -margin || sy > h + margin) continue
      const k = (2 * Math.PI) / p.wlPx
      // spdPx was baked at TIME_SCALE; divide back to the true phase speed —
      // the speed knob alone decides how far from honest the motion runs
      const phase = k * (p.x * p.ux + p.y * p.uy) - k * (p.spdPx / TIME_SCALE) * clock + p.pj
      const frac = ((phase / (2 * Math.PI)) % 1 + 1) % 1
      // the crest passing this anchor: rises, crosses, dies within one
      // wavelength — and because phase is spatial, the whole front does
      const off = (0.5 - frac) * p.wlPx
      const fade = Math.cos((Math.PI * off) / p.wlPx) ** 2
      // SEA_GAIN lifts the whole strength range so the 80% default reads
      // the way 100% used to — the crests have to hold their own now the
      // wind threads run quieter. Alpha strings clamp at 1, so the top of
      // the slider can't overflow.
      const a = fade * p.amp * tune.seaOpacity * SEA_GAIN
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (animate) raf = requestAnimationFrame(frame)
  }
  extend()
  if (animate) raf = requestAnimationFrame(frame)
  return {
    stop: () => {
      cancelAnimationFrame(raf)
      canvas.remove()
    },
    rebase,
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

let sea: SwellEngine | null = null
let seaWired = false

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function syncSea(map: MlMap) {
  sea?.stop()
  sea = null
  const want =
    useAppStore.getState().layers.seaFlow &&
    // low power stills the sea entirely — its information moves to the
    // numeric wave readout the weather layer draws (weatherLayer.ts)
    !useAppStore.getState().lowPower &&
    current === 'off' && // a console trial owns the water while it runs
    document.visibilityState === 'visible'
  if (!want) return
  void ensureWeatherGrid().then(() => {
    if (sea || current !== 'off') return
    if (!useAppStore.getState().layers.seaFlow) return
    sea = runSwell(map, 'foam', !reducedMotion())
  })
}

// Dev only: this module is a singleton engine — its canvas and listeners are
// wired to one map and one store instance. A Vite hot swap (its own edit, or
// one bubbling through appStore/weatherLayer) resets the module state while
// the old engine keeps animating, and every hot edit stacked another crest
// field on the chart (the "waves doubled up" bug). decline() is a Vite noop,
// so accept the update and take the full reload ourselves.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload())

/** Call once at startup; wires the sea to its switches. */
export function initSeaFlow() {
  // StrictMode double-runs effects in dev; two sets of listeners would fight
  if (seaWired) return
  seaWired = true
  // every map, as the wind does: a rebuilt chart gets its sea, and the sea
  // of a map that goes away goes with it
  onEachMap((map) => {
    // after the chart's first settled frame, a beat behind the wind
    onFirstIdle(map, () => window.setTimeout(() => syncSea(map), 300))
    // the camera settled: the crests you dragged along stay exactly where
    // they are and the water that came into view grows its own
    map.on('moveend', () => {
      if (sea) sea.rebase()
      else syncSea(map)
    })
    map.on('resize', () => syncSea(map))
    map.once('remove', () => {
      sea?.stop()
      sea = null
    })
  })
  withMap(() => {
    const cur = () => {
      const m = getMap()
      if (m) syncSea(m)
    }
    document.addEventListener('visibilitychange', cur)
    useAppStore.subscribe((s, prev) => {
      if (
        s.layers.seaFlow !== prev.layers.seaFlow ||
        s.lowPower !== prev.lowPower ||
        s.planTimeMs !== prev.planTimeMs || // the field is a moment's sea
        // spacing and length are baked into the anchors (length shapes the
        // shoreline envelope); the other knobs are live
        s.flowTuning.seaSpacing !== prev.flowTuning.seaSpacing ||
        s.flowTuning.seaLength !== prev.flowTuning.seaLength
      ) {
        cur()
      }
    })
    onWeatherGrid(cur)
    // the field is one hour's sea; when the hour steps, so does the field
    onWeatherHour(cur)
    // the shoreline arrives after the chart now: a sea built before the
    // depth grid landed found no water to stand on
    onDepthGrid(cur)
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
        : runSwell(map, variant === 'swell-size' ? 'size' : variant === 'swell-shadow' ? 'shadow' : 'foam').stop
}
