import type { LngLat, Map as MlMap } from 'maplibre-gl'

/**
 * A screen frame pinned to the chart.
 *
 * The motion layers draw in css pixels of the moment they were built. When
 * the camera moves, the same water is somewhere else on the screen — and a
 * pan, a turn at the helm, a pinch are all, to a good approximation, one
 * affine map from the old screen to the new. Three reference points around
 * the camera's centre (the boat, while following) are remembered as lng/lat;
 * projecting them again later gives the affine, exact on a flat chart and
 * exact at the boat on a pitched one, with the far field drifting a little
 * until the next rebase. That is what lets the wind and the sea ride a
 * moving chart instead of clearing and rebuilding every time it moves.
 *
 * The matrix is in canvas `setTransform` order: x' = a·x + c·y + e,
 * y' = b·x + d·y + f.
 */
export interface Affine {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export const IDENTITY: Readonly<Affine> = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

export class FrameAnchor {
  private readonly ll: [LngLat, LngLat, LngLat]
  private readonly ox: number
  private readonly oy: number
  private readonly span: number

  /** Pin the current screen, with reference points `span` px around `origin`. */
  constructor(map: MlMap, origin: { x: number; y: number }, span = 120) {
    this.ox = origin.x
    this.oy = origin.y
    this.span = span
    this.ll = [
      map.unproject([origin.x, origin.y]),
      map.unproject([origin.x + span, origin.y]),
      map.unproject([origin.x, origin.y + span]),
    ]
  }

  /** The affine taking the pinned frame's css px to today's screen. */
  current(map: MlMap): Affine {
    const A = map.project(this.ll[0])
    const B = map.project(this.ll[1])
    const C = map.project(this.ll[2])
    const a = (B.x - A.x) / this.span
    const b = (B.y - A.y) / this.span
    const c = (C.x - A.x) / this.span
    const d = (C.y - A.y) / this.span
    return { a, b, c, d, e: A.x - a * this.ox - c * this.oy, f: A.y - b * this.ox - d * this.oy }
  }
}

export function applyX(m: Affine, x: number, y: number): number {
  return m.a * x + m.c * y + m.e
}

export function applyY(m: Affine, x: number, y: number): number {
  return m.b * x + m.d * y + m.f
}

export function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c || 1e-9
  const a = m.d / det
  const b = -m.b / det
  const c = -m.c / det
  const d = m.a / det
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) }
}

/** m ∘ n: apply n, then m. */
export function compose(m: Affine, n: Affine): Affine {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  }
}

/** Uniform scale factor (√|det|). */
export function scaleOf(m: Affine): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c))
}

/** Same transform to within a hundredth of a pixel at the origin and in the linear part. */
export function same(m: Affine, n: Affine): boolean {
  return (
    Math.abs(m.a - n.a) < 1e-4 &&
    Math.abs(m.b - n.b) < 1e-4 &&
    Math.abs(m.c - n.c) < 1e-4 &&
    Math.abs(m.d - n.d) < 1e-4 &&
    Math.abs(m.e - n.e) < 0.01 &&
    Math.abs(m.f - n.f) < 0.01
  )
}

export function isIdentity(m: Affine): boolean {
  return same(m, IDENTITY)
}

/** Where the camera centre sits on screen — the boat, while following. */
export function centrePoint(map: MlMap): { x: number; y: number } {
  const p = map.project(map.getCenter())
  return { x: p.x, y: p.y }
}
