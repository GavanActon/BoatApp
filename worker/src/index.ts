/**
 * The Sandies API — circles ("Boats out").
 *
 * No accounts. A circle is an id plus a secret; holding the secret is
 * membership, and the server keeps only its hash. Each boat posts ONE
 * record per circle — its latest position and trip — signed by a device
 * key whose hash is pinned on first post, so one member can't post as
 * another's boat. Everything expires: a silent boat after 12 h, an idle
 * circle after 90 d. There is no trail and no history to leak.
 *
 *   POST   /circle             { name, deviceId, deviceKey }   → { id, secret, name }
 *   GET    /circle/:id         Bearer secret                    → { id, name, boats: [...] }
 *   PUT    /circle/:id/boat    Bearer secret + body             → 204
 *   DELETE /circle/:id/boat    Bearer secret + { deviceId, deviceKey } → 204
 *   GET    /health
 *
 * Usage stats (app/src/stats) share the Worker and the database:
 *
 *   POST   /stats                  { id, build, events: [{ t, n, p? }] } → 204
 *   GET    /stats/summary?days=30  Bearer STATS_TOKEN                   → { ... }
 *
 * The summary is for the person who runs the app; STATS_TOKEN is a Worker
 * secret (`wrangler secret put STATS_TOKEN`) and the route answers 503
 * until it is set. Events keep for 400 days.
 *
 * CORS is open: the secret in the Authorization header is the gate, not
 * the origin.
 */

interface Env {
  DB: D1Database
  STATS_TOKEN?: string
}

// ---------- the small alphabet a person can read back over the phone ----------
// no 0/O, 1/I; 32 symbols → 5 bits each
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ID_LEN = 6
const SECRET_LEN = 12

const BOAT_TTL_MS = 12 * 3600_000
const CIRCLE_TTL_MS = 90 * 86400_000
const MAX_ROUTE_POINTS = 60
const MAX_TEXT = 40

const EVENTS_TTL_MS = 400 * 86400_000
const MAX_EVENTS = 200
const MAX_PROPS_CHARS = 600
/** A phone's clock can be anything; a stamp this far off is replaced by
 *  the server's. */
const CLOCK_SLACK_MS = 15 * 60_000
const EVENT_NAME = /^[a-z][a-z0-9_]{0,31}$/
const INSTALL_ID = /^[a-f0-9]{16}$/
const SUMMARY_DAYS = 30
const MAX_SUMMARY_DAYS = 400
const TIMED = ['boot', 'route', 'wx_fetch']

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-max-age': '86400',
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function err(status: number, message: string): Response {
  return json({ error: true, message }, status)
}

function code(len: number): string {
  const a = new Uint8Array(len)
  crypto.getRandomValues(a)
  let s = ''
  for (const b of a) s += ALPHABET[b % 32]
  return s
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? ''
  const m = /^Bearer\s+([A-Za-z0-9]{6,40})$/i.exec(h)
  return m ? m[1].toUpperCase() : null
}

function text(v: unknown, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function num(v: unknown, lo: number, hi: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null
}

const STATES = new Set(['out', 'coming', 'there', 'heading-home', 'home'])

interface TripIn {
  dest: { name: string | null; lon: number; lat: number } | null
  etaMs: number | null
  homeMs: number | null
  /** When the boat reached the destination, for "at … since". */
  sinceMs: number | null
  state: string
  route: [number, number][] | null
}

/** A trip as the phone describes it, checked field by field; null when the
 *  boat is simply out. */
function trip(v: unknown): TripIn | null {
  if (!v || typeof v !== 'object') return null
  const t = v as Record<string, unknown>
  const state = typeof t.state === 'string' && STATES.has(t.state) ? t.state : 'out'
  let dest: TripIn['dest'] = null
  if (t.dest && typeof t.dest === 'object') {
    const d = t.dest as Record<string, unknown>
    const lon = num(d.lon, -180, 180)
    const lat = num(d.lat, -90, 90)
    if (lon != null && lat != null) dest = { name: text(d.name) || null, lon, lat }
  }
  let route: [number, number][] | null = null
  if (Array.isArray(t.route)) {
    route = []
    for (const p of t.route.slice(0, MAX_ROUTE_POINTS)) {
      if (!Array.isArray(p)) continue
      const lon = num(p[0], -180, 180)
      const lat = num(p[1], -90, 90)
      if (lon != null && lat != null) route.push([Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4])
    }
    if (route.length < 2) route = null
  }
  return {
    dest,
    etaMs: num(t.etaMs, 0, 4e12),
    homeMs: num(t.homeMs, 0, 4e12),
    sinceMs: num(t.sinceMs, 0, 4e12),
    state,
    route,
  }
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = (await req.json()) as unknown
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function deviceOf(b: Record<string, unknown>): { id: string; key: string } | null {
  const id = typeof b.deviceId === 'string' && /^[a-f0-9]{16,64}$/.test(b.deviceId) ? b.deviceId : null
  const key = typeof b.deviceKey === 'string' && /^[a-f0-9]{32,128}$/.test(b.deviceKey) ? b.deviceKey : null
  return id && key ? { id, key } : null
}

// ---------- handlers ----------

async function createCircle(req: Request, env: Env): Promise<Response> {
  const b = await readBody(req)
  if (!b) return err(400, 'body must be JSON')
  const name = text(b.name)
  if (!name) return err(400, 'a circle needs a name')
  if (!deviceOf(b)) return err(400, 'deviceId and deviceKey required')
  const id = code(ID_LEN)
  const secret = code(SECRET_LEN)
  const now = Date.now()
  await env.DB.prepare('INSERT INTO circles (id, name, secret_hash, created, last_post) VALUES (?, ?, ?, ?, ?)')
    .bind(id, name, await sha256(secret), now, now)
    .run()
  return json({ id, secret, name }, 201)
}

interface CircleRow {
  id: string
  name: string
  secret_hash: string
}

async function getCircle(env: Env, circle: CircleRow): Promise<Response> {
  const since = Date.now() - BOAT_TTL_MS
  const rows = await env.DB.prepare(
    'SELECT device_id, name, boat, lon, lat, sog_kn, cog, fix_ts, trip, updated FROM boats WHERE circle_id = ? AND updated > ? ORDER BY updated DESC',
  )
    .bind(circle.id, since)
    .all<{
      device_id: string
      name: string
      boat: string
      lon: number | null
      lat: number | null
      sog_kn: number | null
      cog: number | null
      fix_ts: number | null
      trip: string | null
      updated: number
    }>()
  const boats = (rows.results ?? []).map((r) => ({
    deviceId: r.device_id,
    name: r.name,
    boat: r.boat,
    lon: r.lon,
    lat: r.lat,
    sogKn: r.sog_kn,
    cog: r.cog,
    fixTs: r.fix_ts,
    trip: r.trip ? (JSON.parse(r.trip) as TripIn) : null,
    updated: r.updated,
  }))
  return json({ id: circle.id, name: circle.name, boats, now: Date.now() })
}

async function putBoat(req: Request, env: Env, circleId: string): Promise<Response> {
  const b = await readBody(req)
  if (!b) return err(400, 'body must be JSON')
  const dev = deviceOf(b)
  if (!dev) return err(400, 'deviceId and deviceKey required')
  const keyHash = await sha256(dev.key)
  const existing = await env.DB.prepare('SELECT device_key_hash FROM boats WHERE circle_id = ? AND device_id = ?')
    .bind(circleId, dev.id)
    .first<{ device_key_hash: string }>()
  if (existing && existing.device_key_hash !== keyHash) return err(403, 'this boat belongs to another device')

  const name = text(b.name) || 'A boat'
  const boat = text(b.boat)
  const fix = b.fix && typeof b.fix === 'object' ? (b.fix as Record<string, unknown>) : {}
  const lon = num(fix.lon, -180, 180)
  const lat = num(fix.lat, -90, 90)
  const sogKn = num(fix.sogKn, 0, 200)
  const cog = num(fix.cog, 0, 360)
  const fixTs = num(fix.ts, 0, 4e12)
  const t = trip(b.trip)
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO boats (circle_id, device_id, device_key_hash, name, boat, lon, lat, sog_kn, cog, fix_ts, trip, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (circle_id, device_id) DO UPDATE SET
         name = excluded.name, boat = excluded.boat, lon = excluded.lon, lat = excluded.lat,
         sog_kn = excluded.sog_kn, cog = excluded.cog, fix_ts = excluded.fix_ts,
         trip = excluded.trip, updated = excluded.updated`,
    ).bind(circleId, dev.id, keyHash, name, boat, lon, lat, sogKn, cog, fixTs, t ? JSON.stringify(t) : null, now),
    env.DB.prepare('UPDATE circles SET last_post = ? WHERE id = ?').bind(now, circleId),
  ])
  return new Response(null, { status: 204, headers: CORS })
}

async function deleteBoat(req: Request, env: Env, circleId: string): Promise<Response> {
  const b = await readBody(req)
  const dev = b ? deviceOf(b) : null
  if (!dev) return err(400, 'deviceId and deviceKey required')
  const keyHash = await sha256(dev.key)
  const res = await env.DB.prepare('DELETE FROM boats WHERE circle_id = ? AND device_id = ? AND device_key_hash = ?')
    .bind(circleId, dev.id, keyHash)
    .run()
  if (!res.meta.changes) {
    const any = await env.DB.prepare('SELECT 1 FROM boats WHERE circle_id = ? AND device_id = ?')
      .bind(circleId, dev.id)
      .first()
    if (any) return err(403, 'this boat belongs to another device')
  }
  return new Response(null, { status: 204, headers: CORS })
}

// ---------- usage stats ----------

interface EventRow {
  install: string
  build: string | null
  at: number
  received: number
  name: string
  props: string | null
}

/** Check a batch field by field; a bad event is skipped, not the batch. */
function eventsOf(b: Record<string, unknown>, install: string, build: string | null): EventRow[] {
  if (!Array.isArray(b.events)) return []
  const now = Date.now()
  const rows: EventRow[] = []
  for (const e of b.events.slice(0, MAX_EVENTS)) {
    if (!e || typeof e !== 'object') continue
    const ev = e as Record<string, unknown>
    const name = typeof ev.n === 'string' && EVENT_NAME.test(ev.n) ? ev.n : null
    if (!name) continue
    let at = num(ev.t, 0, 4e12) ?? now
    if (at > now + CLOCK_SLACK_MS || at < now - EVENTS_TTL_MS) at = now
    let props: string | null = null
    if (ev.p && typeof ev.p === 'object' && !Array.isArray(ev.p)) {
      const clean: Record<string, string | number | boolean> = {}
      for (const [k, v] of Object.entries(ev.p as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') clean[k] = v
      }
      const str = JSON.stringify(clean)
      props = str.length <= MAX_PROPS_CHARS ? str : null
    }
    rows.push({ install, build, at, received: now, name, props })
  }
  return rows
}

async function postStats(req: Request, env: Env): Promise<Response> {
  const b = await readBody(req)
  if (!b) return err(400, 'body must be JSON')
  const install = typeof b.id === 'string' && INSTALL_ID.test(b.id) ? b.id : null
  if (!install) return err(400, 'an install id is required')
  const build = text(b.build, 12) || null
  const rows = eventsOf(b, install, build)
  // one statement per row; D1 batches take a couple of hundred happily
  const stmt = env.DB.prepare(
    'INSERT INTO events (install, build, at, received, name, props) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (let i = 0; i < rows.length; i += 100) {
    await env.DB.batch(
      rows.slice(i, i + 100).map((r) => stmt.bind(r.install, r.build, r.at, r.received, r.name, r.props)),
    )
  }
  return new Response(null, { status: 204, headers: CORS })
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

/** The numbers behind "is anyone using it, and does it work": installs by
 *  day and by week, every event counted, the timings, the errors — all
 *  over one window of days. */
async function statsSummary(env: Env, days: number): Promise<Response> {
  const now = Date.now()
  const since = now - days * 86400_000
  const day = now - 86400_000
  const week = now - 7 * 86400_000

  const q = <T>(sql: string, ...bind: unknown[]) =>
    env.DB.prepare(sql)
      .bind(...bind)
      .all<T>()
      .then((r) => r.results ?? [])

  const [active, daily, byName, builds, platforms, timings, errors, trips, firstSeen] = await Promise.all([
    q<{ window: string; n: number }>(
      `SELECT 'day' AS window, COUNT(DISTINCT install) AS n FROM events WHERE at > ?
       UNION ALL SELECT 'week', COUNT(DISTINCT install) FROM events WHERE at > ?
       UNION ALL SELECT 'period', COUNT(DISTINCT install) FROM events WHERE at > ?`,
      day,
      week,
      since,
    ),
    q<{ d: string; installs: number; opens: number }>(
      `SELECT date(at / 1000, 'unixepoch') AS d, COUNT(DISTINCT install) AS installs,
              SUM(name = 'open') AS opens
       FROM events WHERE at > ? GROUP BY d ORDER BY d`,
      since,
    ),
    q<{ name: string; n: number; installs: number }>(
      `SELECT name, COUNT(*) AS n, COUNT(DISTINCT install) AS installs
       FROM events WHERE at > ? GROUP BY name ORDER BY n DESC`,
      since,
    ),
    q<{ build: string | null; installs: number; last: number }>(
      `SELECT build, COUNT(DISTINCT install) AS installs, MAX(at) AS last
       FROM events WHERE at > ? GROUP BY build ORDER BY last DESC`,
      since,
    ),
    q<{ platform: string | null; installed: number | null; installs: number }>(
      `SELECT json_extract(props, '$.platform') AS platform, json_extract(props, '$.installed') AS installed,
              COUNT(DISTINCT install) AS installs
       FROM events WHERE name = 'open' AND at > ? GROUP BY platform, installed ORDER BY installs DESC`,
      since,
    ),
    q<{ name: string; ms: number }>(
      `SELECT name, json_extract(props, '$.ms') AS ms FROM events
       WHERE at > ? AND name IN ('boot', 'route', 'wx_fetch') AND json_extract(props, '$.ms') IS NOT NULL
       LIMIT 20000`,
      since,
    ),
    q<{ name: string; text: string | null; n: number; installs: number; last: number }>(
      `SELECT name, COALESCE(json_extract(props, '$.text'), json_extract(props, '$.reason')) AS text,
              COUNT(*) AS n, COUNT(DISTINCT install) AS installs, MAX(at) AS last
       FROM events WHERE name IN ('error', 'wx_fail') AND at > ?
       GROUP BY name, text ORDER BY n DESC LIMIT 30`,
      since,
    ),
    q<{ n: number; min: number | null; nm: number | null; arrived: number | null }>(
      `SELECT COUNT(*) AS n, AVG(json_extract(props, '$.min')) AS min, AVG(json_extract(props, '$.nm')) AS nm,
              AVG(json_extract(props, '$.arrived')) AS arrived
       FROM events WHERE name = 'trip_end' AND at > ?`,
      since,
    ),
    q<{ install: string; first: number }>('SELECT install, MIN(at) AS first FROM events GROUP BY install'),
  ])

  const perf: Record<string, { n: number; p50: number | null; p90: number | null; max: number | null }> = {}
  for (const name of TIMED) {
    const ms = timings
      .filter((t) => t.name === name && typeof t.ms === 'number')
      .map((t) => t.ms)
      .sort((a, b) => a - b)
    perf[name] = {
      n: ms.length,
      p50: percentile(ms, 0.5),
      p90: percentile(ms, 0.9),
      max: ms.length ? ms[ms.length - 1] : null,
    }
  }

  return json({
    now,
    days,
    installs: {
      total: firstSeen.length,
      new: firstSeen.filter((r) => r.first > since).length,
      active: Object.fromEntries(active.map((r) => [r.window, r.n])),
    },
    daily,
    events: byName,
    builds,
    platforms,
    perf,
    trips: trips[0] ?? null,
    errors,
  })
}

async function purge(env: Env): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM events WHERE at < ?').bind(now - EVENTS_TTL_MS),
    env.DB.prepare('DELETE FROM boats WHERE updated < ?').bind(now - BOAT_TTL_MS),
    env.DB.prepare('DELETE FROM boats WHERE circle_id IN (SELECT id FROM circles WHERE last_post < ?)').bind(
      now - CIRCLE_TTL_MS,
    ),
    env.DB.prepare('DELETE FROM circles WHERE last_post < ?').bind(now - CIRCLE_TTL_MS),
  ])
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    const url = new URL(req.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    try {
      if (path === '/health') return json({ ok: true, now: Date.now() })
      if (path === '/stats' && req.method === 'POST') return await postStats(req, env)
      if (path === '/stats/summary' && req.method === 'GET') {
        if (!env.STATS_TOKEN) return err(503, 'STATS_TOKEN is not set on the Worker')
        if (req.headers.get('authorization') !== `Bearer ${env.STATS_TOKEN}`) return err(403, 'not the stats token')
        const days = Math.min(MAX_SUMMARY_DAYS, Math.max(1, Number(url.searchParams.get('days')) || SUMMARY_DAYS))
        return await statsSummary(env, days)
      }
      if (path === '/circle' && req.method === 'POST') return await createCircle(req, env)
      const m = /^\/circle\/([A-Za-z0-9]{6})(\/boat)?$/.exec(path)
      if (m) {
        const id = m[1].toUpperCase()
        const secret = bearer(req)
        if (!secret) return err(401, 'the circle secret goes in the Authorization header')
        const circle = await env.DB.prepare('SELECT id, name, secret_hash FROM circles WHERE id = ?')
          .bind(id)
          .first<CircleRow>()
        if (!circle || circle.secret_hash !== (await sha256(secret))) return err(403, 'not a member of this circle')
        if (!m[2] && req.method === 'GET') return await getCircle(env, circle)
        if (m[2] && req.method === 'PUT') return await putBoat(req, env, id)
        if (m[2] && req.method === 'DELETE') return await deleteBoat(req, env, id)
      }
      return err(404, 'no such route')
    } catch (e) {
      return err(500, e instanceof Error ? e.message : 'unexpected error')
    }
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    await purge(env)
  },
}
