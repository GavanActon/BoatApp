/**
 * Whole-file storage for chart data (.pmtiles).
 *
 * Primary backend: OPFS (navigator.storage.getDirectory) with streaming writes.
 * Fallback (older iOS without createWritable): Cache Storage with an in-memory
 * assembled response.
 *
 * A localStorage manifest marks files whose download completed, so a torn
 * download is never mistaken for a valid file.
 */

const DIR = 'charts'
const CACHE_NAME = 'chart-files'
const MANIFEST_PREFIX = 'chartfile:'

export interface StoredFileInfo {
  name: string
  size: number
  savedAt: number
}

function manifestGet(name: string): StoredFileInfo | null {
  try {
    const raw = localStorage.getItem(MANIFEST_PREFIX + name)
    return raw ? (JSON.parse(raw) as StoredFileInfo) : null
  } catch {
    return null
  }
}

function manifestSet(info: StoredFileInfo) {
  localStorage.setItem(MANIFEST_PREFIX + info.name, JSON.stringify(info))
}

function manifestDelete(name: string) {
  localStorage.removeItem(MANIFEST_PREFIX + name)
}

export function listStored(): StoredFileInfo[] {
  const out: StoredFileInfo[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k?.startsWith(MANIFEST_PREFIX)) {
      const info = manifestGet(k.slice(MANIFEST_PREFIX.length))
      if (info) out.push(info)
    }
  }
  return out
}

async function opfsDir(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(DIR, { create })
  } catch {
    return null
  }
}

/** Returns the stored file as a Blob (random-access via .slice), or null. */
export async function getStoredFile(name: string): Promise<Blob | null> {
  const info = manifestGet(name)
  if (!info) return null

  const dir = await opfsDir(false)
  if (dir) {
    try {
      const fh = await dir.getFileHandle(name)
      const f = await fh.getFile()
      if (f.size === info.size) return f
    } catch {
      /* fall through to cache */
    }
  }
  try {
    const cache = await caches.open(CACHE_NAME)
    const resp = await cache.match(`/${DIR}/${name}`)
    if (resp) {
      const blob = await resp.blob()
      if (blob.size === info.size) return blob
    }
  } catch {
    /* not stored */
  }
  // manifest points at nothing valid — clean it up
  manifestDelete(name)
  return null
}

export async function deleteStoredFile(name: string): Promise<void> {
  manifestDelete(name)
  const dir = await opfsDir(false)
  if (dir) {
    try {
      await dir.removeEntry(name)
    } catch {
      /* not there */
    }
  }
  try {
    const cache = await caches.open(CACHE_NAME)
    await cache.delete(`/${DIR}/${name}`)
  } catch {
    /* ignore */
  }
}

export type ProgressFn = (loaded: number, total: number) => void

/** Download url and persist as `name`. Reports progress. Throws on failure. */
export async function downloadToStore(
  url: string,
  name: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<StoredFileInfo> {
  const resp = await fetch(url, { signal })
  if (!resp.ok || !resp.body) throw new Error(`Download failed (${resp.status}) for ${url}`)
  const total = Number(resp.headers.get('content-length') ?? 0)

  manifestDelete(name) // invalidate while writing

  const dir = await opfsDir(true)
  let written = 0

  if (dir && 'createWritable' in FileSystemFileHandle.prototype) {
    const fh = await dir.getFileHandle(name, { create: true })
    const writable = await fh.createWritable()
    const reader = resp.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await writable.write(value)
        written += value.byteLength
        onProgress?.(written, total)
      }
      await writable.close()
    } catch (e) {
      try {
        await writable.abort()
      } catch {
        /* ignore */
      }
      throw e
    }
  } else {
    // Cache Storage fallback — assemble in memory (fine for bundle-sized files)
    const reader = resp.body.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      written += value.byteLength
      onProgress?.(written, total)
    }
    const blob = new Blob(chunks as BlobPart[], { type: 'application/octet-stream' })
    const cache = await caches.open(CACHE_NAME)
    await cache.put(`/${DIR}/${name}`, new Response(blob))
  }

  const info: StoredFileInfo = { name, size: written, savedAt: Date.now() }
  manifestSet(info)
  return info
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const est = await navigator.storage.estimate()
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 }
  } catch {
    return null
  }
}

/** Ask the browser to make storage persistent (protects downloads from eviction). */
export async function requestPersistence(): Promise<boolean> {
  try {
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
