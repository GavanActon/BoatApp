import { statsInstallId } from './stats/core'

/**
 * The dev log: what the app was doing, minute by minute, for the bugs
 * that leave no trace — a chart gone blank, a screen that stops answering.
 * Off unless a tester switches it on in Settings; then everything worth
 * knowing is written here with a time: boots, resumes, the WebGL context
 * coming and going, freezes of the main thread, fixes the gate refused,
 * polls and posts that failed, errors and warnings. Kept on the phone
 * (a few hundred KB at most), uploaded to the API on demand, where it
 * gets a code to read out or a link to share.
 *
 * Positions are in it. That is the point of a log from the water, and why
 * it is off by default and uploaded only by hand.
 */

const ON_KEY = 'sandies-devlog'
const LINES_KEY = 'sandies-devlog-lines'
const LAST_KEY = 'sandies-devlog-last'
const MAX_LINES = 1500
const MAX_CHARS = 220
const FLUSH_MS = 5000
const FREEZE_MS = 3000

const API = (import.meta.env.VITE_API as string | undefined) ?? 'https://api.sandies.app'

let on = false
let lines: string[] = []
let dirty = false
let flushTimer: number | null = null
let installed = false
const listeners = new Set<() => void>()

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, v: string | null) {
  try {
    if (v == null) localStorage.removeItem(key)
    else localStorage.setItem(key, v)
  } catch {
    /* storage full or gone */
  }
}

export function devLogOn(): boolean {
  return on
}

export function devLogLines(): number {
  return lines.length
}

export function onDevLog(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function emit() {
  for (const l of listeners) l()
}

function stamp(ms = Date.now()): string {
  const d = new Date(ms)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function short(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** One line: `HH:MM:SS.mmm tag · message · {data}`. Cheap when off. */
export function devlog(tag: string, message: string, data?: unknown): void {
  if (!on) return
  const extra = data === undefined ? '' : ` · ${short(data)}`
  lines.push(`${stamp()} ${tag} · ${message}${extra}`.slice(0, MAX_CHARS))
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
  dirty = true
  if (flushTimer == null) flushTimer = window.setTimeout(flush, FLUSH_MS)
  emit()
}

function flush() {
  flushTimer = null
  if (!dirty) return
  dirty = false
  write(LINES_KEY, JSON.stringify(lines))
}

function dateLine(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Switch the log on or off. On writes a boot line; off wipes it. */
export function setDevLog(v: boolean): void {
  if (v === on) return
  on = v
  write(ON_KEY, v ? '1' : null)
  if (v) {
    lines = []
    boot('switched on')
    installHooks()
  } else {
    lines = []
    dirty = false
    write(LINES_KEY, null)
  }
  flush()
  emit()
}

function boot(why: string) {
  const nav = navigator as Navigator & { standalone?: boolean; deviceMemory?: number }
  devlog('boot', why, {
    date: dateLine(),
    build: __BUILD__.sha,
    ua: navigator.userAgent.slice(0, 120),
    dpr: devicePixelRatio,
    vp: `${innerWidth}x${innerHeight}`,
    installed: nav.standalone === true || matchMedia('(display-mode: standalone)').matches,
    mem: nav.deviceMemory ?? null,
    online: navigator.onLine,
  })
}

/** Call once at startup, before the app renders: picks up the switch and
 *  the lines from the last session, and starts listening. */
export function initDevLog(): void {
  on = read(ON_KEY) === '1'
  if (!on) return
  try {
    const saved = JSON.parse(read(LINES_KEY) ?? '[]') as unknown
    if (Array.isArray(saved)) lines = saved.filter((l) => typeof l === 'string').slice(-MAX_LINES)
  } catch {
    lines = []
  }
  boot('launch')
  installHooks()
}

function installHooks() {
  if (installed) return
  installed = true
  document.addEventListener('visibilitychange', () => devlog('page', document.visibilityState))
  window.addEventListener('pagehide', () => {
    devlog('page', 'pagehide')
    flush()
  })
  window.addEventListener('pageshow', (e) => devlog('page', `pageshow${(e as PageTransitionEvent).persisted ? ' (from cache)' : ''}`))
  window.addEventListener('online', () => devlog('net', 'online'))
  window.addEventListener('offline', () => devlog('net', 'offline'))
  // the main thread went away: a timer that should fire every second
  // fires late by seconds. Hidden, that is the ordinary suspend; in front
  // it is the screen that stopped answering.
  let last = Date.now()
  setInterval(() => {
    const now = Date.now()
    const gap = now - last
    last = now
    if (gap > FREEZE_MS) {
      devlog(document.visibilityState === 'visible' ? 'freeze' : 'suspend', `${(gap / 1000).toFixed(1)} s`)
    }
  }, 1000)
  // memory, where the browser will say (Chrome; not Safari)
  const perf = performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }
  if (perf.memory) {
    setInterval(() => {
      if (document.visibilityState !== 'visible') return
      const m = perf.memory!
      devlog('mem', `${Math.round(m.usedJSHeapSize / 1e6)} MB of ${Math.round(m.jsHeapSizeLimit / 1e6)}`)
    }, 60_000)
  }
}

/** The whole log as text, newest last. */
export function devLogText(): string {
  const head = [
    `Sandies dev log · ${dateLine()} · build ${__BUILD__.sha} · install ${statsInstallId() || '?'}`,
    `${lines.length} lines · ${navigator.userAgent.slice(0, 120)}`,
    '',
  ]
  return head.concat(lines).join('\n') + '\n'
}

export interface Uploaded {
  code: string
  url: string
  at: number
}

/** The last upload, so the report can point at it. */
export function lastUpload(): Uploaded | null {
  try {
    const u = JSON.parse(read(LAST_KEY) ?? 'null') as Uploaded | null
    return u && typeof u.code === 'string' ? u : null
  } catch {
    return null
  }
}

/** Send the log to the API; the answer is a code to read out and a link. */
export async function uploadDevLog(): Promise<Uploaded> {
  flush()
  const text = devLogText()
  const resp = await fetch(`${API}/devlog`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: statsInstallId(), build: __BUILD__.sha, text }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const r = (await resp.json()) as { code: string; url: string }
  const u: Uploaded = { code: r.code, url: r.url, at: Date.now() }
  write(LAST_KEY, JSON.stringify(u))
  devlog('log', `uploaded · ${u.code}`)
  emit()
  return u
}

/** Hand the log to the share sheet as a file, or copy it where there is none. */
export async function shareDevLog(): Promise<'shared' | 'copied' | 'failed'> {
  const text = devLogText()
  const file = new File([text], `sandies-log-${dateLine()}.txt`, { type: 'text/plain' })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Sandies dev log' })
      return 'shared'
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'failed'
    }
  }
  try {
    await navigator.clipboard.writeText(text)
    return 'copied'
  } catch {
    return 'failed'
  }
}

export function clearDevLog(): void {
  lines = []
  write(LINES_KEY, null)
  write(LAST_KEY, null)
  if (on) boot('cleared')
  flush()
  emit()
}
