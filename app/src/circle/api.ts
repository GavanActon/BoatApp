import { fetchTimeout } from '../weather/openMeteo'
import type { Boat, BoatTrip, Circle, Member, Plan } from './store'

/**
 * The circle API client. One Worker at api.sandies.app (see /worker); the
 * circle secret rides in the Authorization header and the device key in
 * the body, so a stray script can neither read a circle nor post as
 * someone else's boat. Every call carries the app's usual fetch timeout.
 */

const API = (import.meta.env.VITE_API as string | undefined) ?? 'https://api.sandies.app'
const SITE = 'https://sandies.app'

async function call(path: string, init: RequestInit & { secret?: string } = {}): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.secret) headers.authorization = `Bearer ${init.secret}`
  const resp = await fetch(`${API}${path}`, { ...init, headers, signal: fetchTimeout(15_000) })
  if (resp.status === 204) return null
  const text = await resp.text()
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    /* an error page */
  }
  if (!resp.ok) {
    const reason = (body as { message?: string } | null)?.message ?? text.slice(0, 80)
    throw new Error(reason || `HTTP ${resp.status}`)
  }
  return body
}

export async function createCircle(name: string, deviceId: string, deviceKey: string): Promise<Circle> {
  const r = (await call('/circle', {
    method: 'POST',
    body: JSON.stringify({ name, deviceId, deviceKey }),
  })) as { id: string; secret: string; name: string }
  return { id: r.id, secret: r.secret, name: r.name }
}

/** The circle's name, everyone in it, and every boat out in it (the server
 *  already drops boats silent for 12 h and plans two hours past their
 *  out-time). */
export async function fetchCircle(c: Circle): Promise<{ name: string; boats: Boat[]; members: Member[] }> {
  const r = (await call(`/circle/${c.id}`, { secret: c.secret })) as {
    name: string
    boats: Omit<Boat, 'circleId'>[]
    members?: Omit<Member, 'circleId'>[]
  }
  return {
    name: r.name,
    boats: r.boats.map((b) => ({ ...b, circleId: c.id })),
    members: (r.members ?? []).map((m) => ({ ...m, circleId: c.id })),
  }
}

export interface MemberRecord {
  deviceId: string
  deviceKey: string
  name: string
  boat: string
  plan: Plan | null
}

/** Join, restate the skipper card, or post (or clear) a plan. */
export async function postMember(c: Circle, record: MemberRecord): Promise<void> {
  await call(`/circle/${c.id}/member`, { method: 'PUT', secret: c.secret, body: JSON.stringify(record) })
}

export interface OwnRecord {
  deviceId: string
  deviceKey: string
  name: string
  boat: string
  fix: { lon: number; lat: number; sogKn: number | null; cog: number | null; ts: number }
  trip: BoatTrip | null
}

export async function postBoat(c: Circle, record: OwnRecord): Promise<void> {
  await call(`/circle/${c.id}/boat`, { method: 'PUT', secret: c.secret, body: JSON.stringify(record) })
}

export async function removeBoat(c: Circle, deviceId: string, deviceKey: string): Promise<void> {
  await call(`/circle/${c.id}/boat`, {
    method: 'DELETE',
    secret: c.secret,
    body: JSON.stringify({ deviceId, deviceKey }),
  })
}

// ---------- invites ----------
//
// The invite is a code a person can read out or paste: six letters of
// circle id, a dash, twelve of secret, from an alphabet without 0/O or
// 1/I. It travels inside a link too — but on iPhone a link opens in Safari,
// whose storage is NOT the home-screen app's, so the code, pasted into
// the app, is the path that always works.

export function joinCode(c: Circle): string {
  return `${c.id}-${c.secret}`
}

export function inviteLink(c: Circle): string {
  return `${SITE}/#join=${c.id}.${c.secret}`
}

export function inviteText(c: Circle, from: string): string {
  const who = from.trim() || 'A friend'
  return (
    `${who} invited you to share trips with "${c.name}" on Sandies — see each other's boats on the chart.\n` +
    `Open the app → Settings → Trip sharing → Join, and paste this code: ${joinCode(c)}\n` +
    `${inviteLink(c)}`
  )
}

/** A code, with or without the dash, or an invite link — as typed. */
export function parseJoinCode(s: string): { id: string; secret: string } | null {
  const t = s.trim()
  const fromLink = /#join=([A-Za-z0-9]{6})[.-]([A-Za-z0-9]{12})/.exec(t)
  const m = fromLink ?? /^([A-Za-z0-9]{6})[\s.-]?([A-Za-z0-9]{12})$/.exec(t.replace(/\s+/g, ''))
  if (!m) return null
  return { id: m[1].toUpperCase(), secret: m[2].toUpperCase() }
}
