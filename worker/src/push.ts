/**
 * Web Push from the Worker, with nothing but WebCrypto: the VAPID key pair
 * is made on first use and kept in the `config` table (no secret to set
 * anywhere), the payload is sealed per RFC 8291 (ECDH P-256 → HKDF →
 * AES-128-GCM, aes128gcm framing per RFC 8188), and the request carries a
 * VAPID JWT (RFC 8292). Apple, Google and Mozilla all take exactly this.
 */

export interface PushSub {
  endpoint: string
  p256dh: string
  auth: string
}

interface VapidKeys {
  privJwk: JsonWebKey
  /** The public key, raw uncompressed point, base64url — what the app subscribes with. */
  pub: string
}

interface DbLike {
  DB: D1Database
}

const SUBJECT = 'mailto:info@sandies.app'
const RECORD_SIZE = 4096

const utf8 = (s: string) => new TextEncoder().encode(s)

export function b64u(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function concat(...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** The Worker's own VAPID pair — made once, kept in D1. */
export async function vapidKeys(env: DbLike): Promise<VapidKeys> {
  const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind('vapid').first<{ value: string }>()
  if (row) return JSON.parse(row.value) as VapidKeys
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const keys: VapidKeys = {
    privJwk: await crypto.subtle.exportKey('jwk', kp.privateKey),
    pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)),
  }
  await env.DB.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)').bind('vapid', JSON.stringify(keys)).run()
  // two first calls at once: whichever row won is the pair everyone uses
  const won = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind('vapid').first<{ value: string }>()
  return won ? (JSON.parse(won.value) as VapidKeys) : keys
}

async function vapidAuthorization(endpoint: string, keys: VapidKeys): Promise<string> {
  const aud = new URL(endpoint).origin
  const header = b64u(utf8('{"typ":"JWT","alg":"ES256"}'))
  const claims = b64u(utf8(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })))
  const key = await crypto.subtle.importKey('jwk', keys.privJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(`${header}.${claims}`))
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.pub}`
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, len: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8))
}

/** RFC 8291 + 8188: one aes128gcm record, the whole payload. */
async function seal(sub: PushSub, payload: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const uaPub = fromB64u(sub.p256dh)
  const auth = fromB64u(sub.auth)
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const localPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey))
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256))
  const ikm = await hkdf(auth, shared, concat(utf8('WebPush: info\0'), uaPub, localPub), 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  // the last (only) record ends in a 0x02 delimiter
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(payload, new Uint8Array([2]))))
  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE)
  return concat(salt, rs, new Uint8Array([localPub.length]), localPub, ct)
}

export type PushResult = 'ok' | 'gone' | 'fail'

/** One notification to one subscription. 'gone' means the subscription is
 *  dead and should be dropped. */
export async function sendPush(env: DbLike, sub: PushSub, payload: unknown, ttlS = 3600): Promise<PushResult> {
  try {
    const keys = await vapidKeys(env)
    const body = await seal(sub, utf8(JSON.stringify(payload)))
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
        ttl: String(ttlS),
        urgency: 'normal',
        authorization: await vapidAuthorization(sub.endpoint, keys),
      },
      body,
    })
    if (res.status === 404 || res.status === 410) return 'gone'
    return res.ok ? 'ok' : 'fail'
  } catch {
    return 'fail'
  }
}
