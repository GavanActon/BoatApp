import maplibregl from 'maplibre-gl'
import { FetchSource, PMTiles, Protocol } from 'pmtiles'
import type { RangeResponse, Source } from 'pmtiles'
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
    const data = await this.blob.slice(offset, offset + length).arrayBuffer()
    return { data }
  }
}

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
