/**
 * Automatic over-water routing on the offline depth grid.
 *
 * The .dgrid raster (~65–90 m cells) is downsampled 2× into a navigable mask
 * (all four fine cells must be water at least MIN_NAV_DEPTH_M deep, which also
 * bakes in roughly one fine cell of shore clearance). A* runs over the mask
 * with a soft cost penalty next to shore so routes stand off land where the
 * water allows, then the cell path is string-pulled down to a few waypoints.
 *
 * Everything here is pure (grid in, coords out) so it can run in tests
 * without the app shell; `computeRoute` in router.ts binds it to the live grid.
 */

export interface GridHeader {
  west: number
  south: number
  east: number
  north: number
  nx: number
  ny: number
}

export const NODATA = 32767
const DOWN = 2 // downsample factor: routing cell = DOWN×DOWN fine cells
const MIN_NAV_DEPTH_M = 2 // don't route through water shallower than this
const SHORE_PENALTY = 1.6 // cost multiplier for cells touching non-navigable cells
const SNAP_RADIUS_CELLS = 60 // how far a start/dest may be from navigable water

export interface NavMask {
  header: GridHeader
  rnx: number
  rny: number
  mask: Uint8Array // 1 = navigable
  nearShore: Uint8Array // 1 = navigable but touching a non-navigable cell
  mpcX: number // metres per routing cell, east-west
  mpcY: number // metres per routing cell, north-south
}

export function buildNavMask(header: GridHeader, data: Int16Array): NavMask {
  const { nx, ny } = header
  const rnx = Math.floor(nx / DOWN)
  const rny = Math.floor(ny / DOWN)
  const mask = new Uint8Array(rnx * rny)
  const minDm = MIN_NAV_DEPTH_M * 10

  for (let cy = 0; cy < rny; cy++) {
    for (let cx = 0; cx < rnx; cx++) {
      let ok = 1
      for (let sy = 0; sy < DOWN && ok; sy++) {
        for (let sx = 0; sx < DOWN; sx++) {
          const v = data[(cy * DOWN + sy) * nx + (cx * DOWN + sx)]
          if (v === NODATA || v < minDm) {
            ok = 0
            break
          }
        }
      }
      mask[cy * rnx + cx] = ok
    }
  }

  const nearShore = new Uint8Array(rnx * rny)
  for (let cy = 0; cy < rny; cy++) {
    for (let cx = 0; cx < rnx; cx++) {
      const i = cy * rnx + cx
      if (!mask[i]) continue
      let edge = 0
      for (let dy = -1; dy <= 1 && !edge; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx
          const y = cy + dy
          if (x < 0 || y < 0 || x >= rnx || y >= rny || !mask[y * rnx + x]) {
            edge = 1
            break
          }
        }
      }
      nearShore[i] = edge
    }
  }

  const midLat = ((header.south + header.north) / 2) * (Math.PI / 180)
  const mpcX = (((header.east - header.west) / nx) * DOWN * 111320 * Math.cos(midLat))
  const mpcY = (((header.north - header.south) / ny) * DOWN * 110540)

  return { header, rnx, rny, mask, nearShore, mpcX, mpcY }
}

export function cellToLonLat(nav: NavMask, cx: number, cy: number): [number, number] {
  const { west, south, east, north, nx, ny } = nav.header
  const fx = cx * DOWN + (DOWN - 1) / 2
  const fy = cy * DOWN + (DOWN - 1) / 2
  return [west + (fx / (nx - 1)) * (east - west), north - (fy / (ny - 1)) * (north - south)]
}

function lonLatToCell(nav: NavMask, lon: number, lat: number): [number, number] {
  const { west, south, east, north, nx, ny } = nav.header
  const fx = ((lon - west) / (east - west)) * (nx - 1)
  const fy = ((north - lat) / (north - south)) * (ny - 1)
  const cx = Math.min(nav.rnx - 1, Math.max(0, Math.floor(fx / DOWN)))
  const cy = Math.min(nav.rny - 1, Math.max(0, Math.floor(fy / DOWN)))
  return [cx, cy]
}

/** Nearest navigable cell to a point, searching outward in square rings. */
export function snapToWater(nav: NavMask, lon: number, lat: number): [number, number] | null {
  const [cx, cy] = lonLatToCell(nav, lon, lat)
  if (nav.mask[cy * nav.rnx + cx]) return [cx, cy]
  for (let r = 1; r <= SNAP_RADIUS_CELLS; r++) {
    let best: [number, number] | null = null
    let bestD = Infinity
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= nav.rnx || y >= nav.rny) continue
        if (!nav.mask[y * nav.rnx + x]) continue
        const d = dx * nav.mpcX * dx * nav.mpcX + dy * nav.mpcY * dy * nav.mpcY
        if (d < bestD) {
          bestD = d
          best = [x, y]
        }
      }
    }
    if (best) return best
  }
  return null
}

// binary min-heap over f-scores
class Heap {
  idx: Int32Array
  f: Float64Array
  n = 0
  constructor(cap: number, f: Float64Array) {
    this.idx = new Int32Array(cap)
    this.f = f
  }
  push(i: number) {
    let c = this.n++
    this.idx[c] = i
    while (c > 0) {
      const p = (c - 1) >> 1
      if (this.f[this.idx[p]] <= this.f[this.idx[c]]) break
      const t = this.idx[p]
      this.idx[p] = this.idx[c]
      this.idx[c] = t
      c = p
    }
  }
  pop(): number {
    const top = this.idx[0]
    this.idx[0] = this.idx[--this.n]
    let c = 0
    for (;;) {
      const l = c * 2 + 1
      const r = l + 1
      let m = c
      if (l < this.n && this.f[this.idx[l]] < this.f[this.idx[m]]) m = l
      if (r < this.n && this.f[this.idx[r]] < this.f[this.idx[m]]) m = r
      if (m === c) break
      const t = this.idx[m]
      this.idx[m] = this.idx[c]
      this.idx[c] = t
      c = m
    }
    return top
  }
}

/** A* over the navigable mask. Returns routing-cell path start→dest, or null. */
export function findCellPath(
  nav: NavMask,
  start: [number, number],
  dest: [number, number],
): [number, number][] | null {
  const { rnx, rny, mask, nearShore, mpcX, mpcY } = nav
  const N = rnx * rny
  const sI = start[1] * rnx + start[0]
  const dI = dest[1] * rnx + dest[0]
  if (!mask[sI] || !mask[dI]) return null

  const g = new Float64Array(N).fill(Infinity)
  const f = new Float64Array(N).fill(Infinity)
  const came = new Int32Array(N).fill(-1)
  const closed = new Uint8Array(N)
  const heap = new Heap(N, f)

  const dCost = Math.hypot(mpcX, mpcY)
  const h = (i: number) => {
    const dx = ((i % rnx) - dest[0]) * mpcX
    const dy = (((i / rnx) | 0) - dest[1]) * mpcY
    return Math.hypot(dx, dy)
  }

  g[sI] = 0
  f[sI] = h(sI)
  heap.push(sI)

  const NB_DX = [1, -1, 0, 0, 1, 1, -1, -1]
  const NB_DY = [0, 0, 1, -1, 1, -1, 1, -1]

  while (heap.n > 0) {
    const cur = heap.pop()
    if (cur === dI) break
    if (closed[cur]) continue
    closed[cur] = 1
    const cx = cur % rnx
    const cy = (cur / rnx) | 0
    for (let k = 0; k < 8; k++) {
      const x = cx + NB_DX[k]
      const y = cy + NB_DY[k]
      if (x < 0 || y < 0 || x >= rnx || y >= rny) continue
      const ni = y * rnx + x
      if (!mask[ni] || closed[ni]) continue
      const base = k < 2 ? mpcX : k < 4 ? mpcY : dCost
      const cost = base * (nearShore[ni] ? SHORE_PENALTY : 1)
      const ng = g[cur] + cost
      if (ng < g[ni]) {
        g[ni] = ng
        f[ni] = ng + h(ni)
        came[ni] = cur
        heap.push(ni)
      }
    }
  }

  if (came[dI] === -1 && dI !== sI) return null
  const path: [number, number][] = []
  for (let i = dI; i !== -1; i = came[i]) path.push([i % rnx, (i / rnx) | 0])
  path.reverse()
  return path
}

/** True if the straight segment between two cells stays in navigable water. */
function lineOfSight(nav: NavMask, a: [number, number], b: [number, number]): boolean {
  const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / 0.35)
  for (let s = 1; s < steps; s++) {
    const t = s / steps
    const x = Math.round(a[0] + (b[0] - a[0]) * t)
    const y = Math.round(a[1] + (b[1] - a[1]) * t)
    if (!nav.mask[y * nav.rnx + x]) return false
  }
  return true
}

/** Greedy string-pulling: keep only waypoints needed to stay in water. */
export function smoothPath(nav: NavMask, path: [number, number][]): [number, number][] {
  if (path.length <= 2) return path
  const out: [number, number][] = [path[0]]
  let anchor = 0
  while (anchor < path.length - 1) {
    let far = anchor + 1
    for (let j = path.length - 1; j > anchor + 1; j--) {
      if (lineOfSight(nav, path[anchor], path[j])) {
        far = j
        break
      }
    }
    out.push(path[far])
    anchor = far
  }
  return out
}

export function haversineNm(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const R = 3440.065
  const toRad = Math.PI / 180
  const dLat = (bLat - aLat) * toRad
  const dLon = (bLon - aLon) * toRad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export interface RouteResult {
  /** Waypoints start→dest, [lon, lat]. First/last are the exact requested points. */
  coords: [number, number][]
  distanceNm: number
}

/**
 * Full pipeline: snap both endpoints to navigable water, A*, smooth,
 * splice exact endpoints back on. Returns null when no water path exists.
 */
export function routeOnGrid(
  nav: NavMask,
  start: [number, number],
  dest: [number, number],
): RouteResult | null {
  const sCell = snapToWater(nav, start[0], start[1])
  const dCell = snapToWater(nav, dest[0], dest[1])
  if (!sCell || !dCell) return null

  const cellPath = findCellPath(nav, sCell, dCell)
  if (!cellPath) return null

  const smooth = smoothPath(nav, cellPath)
  const coords = smooth.map(([cx, cy]) => cellToLonLat(nav, cx, cy))

  // splice the exact requested points back on only when they sit just inshore
  // of the snapped cell (a dock or beach); a point further inland stays at the
  // nearest navigable water so the track never crosses land
  const SPLICE_NM = 0.15
  if (haversineNm(start[0], start[1], coords[0][0], coords[0][1]) < SPLICE_NM) coords[0] = start
  const last = coords[coords.length - 1]
  if (haversineNm(dest[0], dest[1], last[0], last[1]) < SPLICE_NM) coords[coords.length - 1] = dest

  let distanceNm = 0
  for (let i = 1; i < coords.length; i++) {
    distanceNm += haversineNm(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
  }
  return { coords, distanceNm }
}
