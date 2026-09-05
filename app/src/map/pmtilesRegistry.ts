import maplibregl from 'maplibre-gl'
import { FetchSource, PMTiles, Protocol } from 'pmtiles'
import type { RangeResponse, Source } from 'pmtiles'
import { devlog } from '../devlog'
import { DATA_BASE, DATA_FILES } from '../config'
import { getStoredFile } from '../offline/fileStore'

/**
 * All chart data is PMTiles referenced in the style as `pmtiles://<key>`.
 * Each key resolves to either a locally stored Blob (OPFS/Cache — offline)
 * or a network FetchSource, whichever is available.
 */

class BlobSource implements Source {
  private blob: Blob
  private key: string
  constructor(blob: Blob, key: string) {
    this.blob = blob
    this.key = key
  }
  getKey() {
    return this.key
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    // a slice of a stored archive can fail to read under memory pressure —
    // Safari rejects the arrayBuffer — or simply never answer, and a read
    // that never answers is a tile that stays "loading" forever: a hole
    // with no error, and one of the few requests MapLibre runs at once
    // gone for good. So every read has a deadline, and a miss is retried
    // twice before the tile counts as failed (the map asks again later).
    let last: unknown = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = Date.now()
      inFlight.add(started)
      try {
        const data = await withDeadline(this.blob.slice(offset, offset + length).arrayBuffer(), READ_DEADLINE_MS)
        const took = Date.now() - started
        if (took > SLOW_READ_MS) devlog('data', `${this.key} slow read · ${took} ms`)
        return { data }
      } catch (e) {
        last = e
        devlog('data', `${this.key} read ${attempt + 1} failed at ${offset} · ${(e as Error)?.message ?? e}`)
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)))
      } finally {
        inFlight.delete(started)
      }
    }
    throw last instanceof Error ? last : new Error('archive read failed')
  }
}

/** A read of a stored archive that takes longer than this is given up on. */
const READ_DEADLINE_MS = 10_000
const SLOW_READ_MS = 2000
/** Start times of reads under way, for the log's word on reads that hang. */
const inFlight = new Set<number>()

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`read timed out after ${ms / 1000} s`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

// every half minute while the app is in front: reads that have been going
// too long are worth a line before their deadline decides
setInterval(() => {
  if (document.visibilityState !== 'visible' || !inFlight.size) return
  const now = Date.now()
  const oldest = Math.min(...inFlight)
  if (now - oldest > SLOW_READ_MS) devlog('data', `${inFlight.size} reads in flight · oldest ${((now - oldest) / 1000).toFixed(1)} s`)
}, 30_000)

class KeyedFetchSource implements Source {
  private inner: FetchSource
  private key: string
  constructor(url: string, key: string) {
    this.inner = new FetchSource(url)
    this.key = key
  }
  getKey() {
    return this.key
  }
  getBytes(offset: number, length: number, signal?: AbortSignal, etag?: string) {
    return this.inner.getBytes(offset, length, signal, etag)
  }
}

const protocol = new Protocol()
maplibregl.addProtocol('pmtiles', protocol.tile)

export type DataSourceMode = 'local' | 'network' | 'missing'

/** key -> where the archive is being read from */
export const sourceModes = new Map<string, DataSourceMode>()

function absoluteDataUrl(file: string): string {
  return new URL(DATA_BASE + file, window.location.href).toString()
}

/** (Re)register one data file, preferring local storage. Probes the archive header
 *  so callers can omit sources that aren't reachable at all. */
export async function registerDataFile(key: string, file: string): Promise<DataSourceMode> {
  const blob = await getStoredFile(file)
  const source: Source = blob
    ? new BlobSource(blob, key)
    : new KeyedFetchSource(absoluteDataUrl(file), key)
  const p = new PMTiles(source)
  let mode: DataSourceMode = blob ? 'local' : 'network'
  try {
    await p.getHeader()
  } catch {
    mode = 'missing'
  }
  if (mode !== 'missing') protocol.add(p)
  sourceModes.set(key, mode)
  return mode
}

/** Register every configured data file. Returns the set of available source keys. */
export async function registerAllDataFiles(): Promise<Set<string>> {
  const available = new Set<string>()
  await Promise.all(
    DATA_FILES.map(async (d) => {
      const mode = await registerDataFile(d.key, d.file)
      if (mode !== 'missing') available.add(d.key)
    }),
  )
  return available
}

export function allDataLocal(): boolean {
  return DATA_FILES.every((d) => sourceModes.get(d.key) === 'local')
}

/** Look up the depth (metres, positive down) at a lon/lat from the contour tiles' bathy grid.
 *  Placeholder for now — implemented via querying the depth raster is not possible client-side,
 *  so depth readout uses the contour vector features near the point instead (see MapView).
 */
export function getProtocol(): Protocol {
  return protocol
}
