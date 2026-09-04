/**
 * Usage stats — what gets used, how the app performs, how many boats run
 * it. Counted, never watched: an event is a short name and a few numbers
 * or words. Never a position, never a name, never the track.
 *
 * The bay has no signal. So an event is written to a queue on the phone
 * the instant it happens and goes to api.sandies.app later, in a batch,
 * when there is a connection: recording never waits on the network (the
 * rule everything else here follows), and a summer of no bars costs a
 * short queue that is capped, oldest dropped. The phone's own clock stamps
 * the event, not the moment it was sent.
 *
 * "Usage stats" in Settings switches the whole thing off: nothing is
 * recorded, and the queue is emptied.
 *
 * This module imports nothing from the app, so anything — the weather
 * fetchers, the error log, the stores — can call track() without a cycle.
 * hooks.ts is where the app's stores are watched.
 */

const API = (import.meta.env.VITE_API as string | undefined) ?? 'https://api.sandies.app'
const QUEUE_KEY = 'sandies-stats-queue'
const ID_KEY = 'sandies-stats-id'
/** Kept on the phone; beyond this the oldest go. A long trip with no
 *  signal writes a few dozen. */
const QUEUE_MAX = 500
/** Per request. keepalive requests are capped at 64 KB; this is ~20 KB. */
const BATCH_MAX = 150
/** A burst this long flushes without waiting for the timer. */
const BURST = 60
const FLUSH_EVERY_MS = 5 * 60_000
const SEND_TIMEOUT_MS = 10_000
const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/
const MAX_PROPS = 12
const MAX_TEXT = 120

export type Props = Record<string, string | number | boolean | null | undefined>

export interface StatEvent {
  /** When it happened, ms epoch, the phone's clock. */
  t: number
  n: string
  p?: Record<string, string | number | boolean>
}

let enabled = true
let installId = ''
let queue: StatEvent[] = []
let sending = false
/** Last time each throttled (name+props) key was recorded. */
const lastAt = new Map<string, number>()

// ---------- storage ----------

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* full or blocked: the queue lives in memory until it isn't */
  }
}

function hex(bytes: number): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function save() {
  write(QUEUE_KEY, queue)
}

// ---------- recording ----------

function clean(p: Props | undefined): StatEvent['p'] | undefined {
  if (!p) return undefined
  const out: NonNullable<StatEvent['p']> = {}
  let n = 0
  for (const [k, v] of Object.entries(p)) {
    if (v == null || n >= MAX_PROPS) continue
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue
      out[k] = Math.round(v * 100) / 100
    } else if (typeof v === 'string') out[k] = v.slice(0, MAX_TEXT)
    else out[k] = v
    n++
  }
  return n ? out : undefined
}

/**
 * Record one event. Synchronous, never throws, never touches the network.
 * `every` throttles: the same event is recorded at most once per that many
 * ms — for things that repeat (a rate limit that answers every poll, an
 * error that fires on every frame). "The same" is the name and props, or
 * `key` when the props are the thing that varies (a timing).
 */
export function track(name: string, props?: Props, opts?: { every?: number; key?: string }): void {
  if (!enabled) return
  if (import.meta.env.DEV && !NAME_RE.test(name)) console.warn(`stats: bad event name "${name}"`)
  const p = clean(props)
  const now = Date.now()
  if (opts?.every) {
    const key = opts.key ?? `${name}:${JSON.stringify(p ?? {})}`
    const last = lastAt.get(key)
    if (last != null && now - last < opts.every) return
    lastAt.set(key, now)
  }
  queue.push(p ? { t: now, n: name, p } : { t: now, n: name })
  if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX)
  save()
  if (queue.length >= BURST) void flush()
}

/** The switch in Settings. Off empties the queue: nothing already counted
 *  goes out after the user said no. */
export function setStatsEnabled(on: boolean): void {
  enabled = on
  if (!on) {
    queue = []
    try {
      localStorage.removeItem(QUEUE_KEY)
    } catch {
      /* nothing to remove */
    }
  }
}

export function statsEnabled(): boolean {
  return enabled
}

/** How many events are waiting for signal — the Settings row says so. */
export function statsQueued(): number {
  return queue.length
}

// ---------- sending ----------

/**
 * Send what is queued, oldest first, one batch per call. Safe to call any
 * time: it returns at once when offline, already sending, or empty. Uses
 * keepalive so the batch fired as the app goes to the background still
 * completes; a text/plain body keeps the request simple (no preflight),
 * which is what keepalive needs from an installed PWA.
 */
export async function flush(): Promise<void> {
  if (!enabled || sending || !queue.length || !navigator.onLine) return
  sending = true
  const events = queue.slice(0, BATCH_MAX)
  try {
    const resp = await fetch(`${API}/stats`, {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ id: installId, build: __BUILD__.sha, events }),
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(SEND_TIMEOUT_MS) : undefined,
    })
    // 2xx: sent. 4xx: the server won't take these, ever — drop rather than
    // resend forever. 5xx and network errors: keep for next time.
    if (resp.ok || (resp.status >= 400 && resp.status < 500)) {
      queue.splice(0, events.length)
      save()
    }
  } catch {
    /* no signal after all — next time */
  } finally {
    sending = false
  }
  if (queue.length >= BATCH_MAX) void flush()
}

let installed = false

/** Wire up storage, the id, and the moments a flush is worth trying. Call
 *  once. Records nothing itself — hooks.ts does the `open` and `close`. */
export function installStats(on: boolean): void {
  if (installed) return
  installed = true
  enabled = on
  try {
    installId = localStorage.getItem(ID_KEY) ?? ''
    if (!/^[a-f0-9]{16}$/.test(installId)) {
      installId = hex(8)
      localStorage.setItem(ID_KEY, installId)
    }
  } catch {
    installId = hex(8) // storage blocked: an id for this session only
  }
  queue = on ? (read<StatEvent[]>(QUEUE_KEY) ?? []).filter((e) => e && typeof e.t === 'number' && typeof e.n === 'string') : []

  window.addEventListener('online', () => void flush())
  // (the app going to the background is the other moment — hooks.ts flushes
  // there, after it has recorded the `close`; keepalive lets the request
  // outlive the page)
  window.setInterval(() => void flush(), FLUSH_EVERY_MS)
  // not at once: the map, the charts and the forecast are all loading
  window.setTimeout(() => void flush(), 8_000)
}

/** The random id this install reports under — for the Settings row, so a
 *  user can see it is not their name. */
export function statsInstallId(): string {
  return installId
}
