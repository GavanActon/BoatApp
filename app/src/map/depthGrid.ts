/**
 * Compact binary depth grid (.dgrid) for instant depth lookups.
 *
 * File layout (little-endian):
 *   [0..4)   uint32 — JSON header byte length H
 *   [4..4+H) UTF-8 JSON: { west, south, east, north, nx, ny }
 *   rest     int16[nx*ny] — depth in decimetres, positive down, row 0 = north.
 *            32767 = nodata (land / outside coverage)
 */
import { DATA_BASE, DEPTH_GRID_FILE } from '../config'
import { getStoredFile } from '../offline/fileStore'

interface GridHeader {
  west: number
  south: number
  east: number
  north: number
  nx: number
  ny: number
}

const NODATA = 32767

let header: GridHeader | null = null
let data: Int16Array | null = null

let loadPromise: Promise<boolean> | null = null

/** Idempotent: concurrent callers (map boot, route planner) share one load. */
export function loadDepthGrid(): Promise<boolean> {
  if (!loadPromise) {
    loadPromise = doLoad().then((ok) => {
      if (!ok) loadPromise = null // allow a retry once files/network appear
      return ok
    })
  }
  return loadPromise
}

async function doLoad(): Promise<boolean> {
  try {
    let blob = await getStoredFile(DEPTH_GRID_FILE)
    if (!blob) {
      const resp = await fetch(DATA_BASE + DEPTH_GRID_FILE)
      if (!resp.ok) return false
      blob = await resp.blob()
    }
    const buf = await blob.arrayBuffer()
    const view = new DataView(buf)
    const hlen = view.getUint32(0, true)
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen))) as GridHeader
    // slice: Int16Array views must be 2-byte aligned, and 4+hlen may be odd
    data = new Int16Array(buf.slice(4 + hlen), 0, header.nx * header.ny)
    return true
  } catch {
    return false
  }
}

export function depthGridLoaded(): boolean {
  return data !== null
}

/** Raw grid access for the water router. */
export function getDepthGridRaw(): { header: GridHeader; data: Int16Array } | null {
  return header && data ? { header, data } : null
}

function sample(ix: number, iy: number): number {
  if (!header || !data) return NODATA
  if (ix < 0 || iy < 0 || ix >= header.nx || iy >= header.ny) return NODATA
  return data[iy * header.nx + ix]
}

/** Depth in metres at lon/lat (positive down), or null on land / outside grid. */
export function depthAt(lon: number, lat: number): number | null {
  if (!header || !data) return null
  const { west, south, east, north, nx, ny } = header
  if (lon < west || lon > east || lat < south || lat > north) return null

  const fx = ((lon - west) / (east - west)) * (nx - 1)
  const fy = ((north - lat) / (north - south)) * (ny - 1)
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const dx = fx - x0
  const dy = fy - y0

  const v00 = sample(x0, y0)
  const v10 = sample(x0 + 1, y0)
  const v01 = sample(x0, y0 + 1)
  const v11 = sample(x0 + 1, y0 + 1)

  const vals = [v00, v10, v01, v11]
  if (vals.every((v) => v === NODATA)) return null

  if (vals.some((v) => v === NODATA)) {
    // near shore: fall back to nearest valid neighbour
    const nearest = dy < 0.5 ? (dx < 0.5 ? v00 : v10) : dx < 0.5 ? v01 : v11
    const valid = nearest !== NODATA ? nearest : vals.find((v) => v !== NODATA)!
    return valid / 10
  }

  const top = v00 * (1 - dx) + v10 * dx
  const bot = v01 * (1 - dx) + v11 * dx
  return (top * (1 - dy) + bot * dy) / 10
}

export function formatDepth(metres: number | null, unit: 'm' | 'ft'): string {
  if (metres == null) return '—'
  const v = unit === 'ft' ? metres * 3.28084 : metres
  const digits = v < 10 ? 1 : 0
  return `${v.toFixed(digits)}`
}
