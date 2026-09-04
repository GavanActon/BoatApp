/**
 * Report a problem. A bug report from the bay is "the wind thing was wrong",
 * so the app fills in everything the user can't be expected to type: which
 * build, which phone, where they were, how old every cached forecast was,
 * and the last few errors the console saw. The report goes out as a
 * prefilled email — no backend, no account, and the phone's mail app queues
 * it until there is signal again, which is exactly the offline case this
 * app is built for.
 *
 * Nothing here phones home on its own. The report is assembled only when
 * the user taps the button, and they see it before it is sent. (Usage
 * stats — src/stats — is the one thing in the app that does. Uncaught
 * errors go there too, as a level and a line, and Settings switches it off.)
 */
import { listStored, storageEstimate } from './offline/fileStore'
import { useAppStore } from './state/appStore'
import { track } from './stats/core'
import { agoLabel } from './time'
import { useGpsStore } from './tracking/gpsStore'
import { windOverlayInfo, windOverlayStatus } from './weather/hrdps'
import { cachedGridForecast, openMeteoLastError } from './weather/openMeteo'
import { waveOverlayInfo, waveOverlayStatus } from './weather/rdwps'

export const REPORT_EMAIL = 'info@sandies.app'

/** Short git sha and build time, stamped in by vite.config.ts. */
export const BUILD: { sha: string; at: string } = __BUILD__

// ---------- error ring buffer ----------

type Level = 'error' | 'warn' | 'uncaught' | 'rejection'
interface LogEntry {
  at: number
  level: Level
  text: string
}

const LOG_MAX = 20 // kept in memory
const REPORT_MAX = 8 // included in the email — mailto bodies have limits
const ENTRY_CHARS = 160
const log: LogEntry[] = []

function describe(v: unknown): string {
  if (v instanceof Error) {
    const where = v.stack?.split('\n')[1]?.trim()
    return `${v.name}: ${v.message}${where ? ` @ ${where}` : ''}`
  }
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function push(level: Level, args: unknown[]) {
  const text = args.map(describe).join(' ').slice(0, ENTRY_CHARS)
  log.push({ at: Date.now(), level, text })
  if (log.length > LOG_MAX) log.shift()
  // the crash nobody emailed about: once per session per line
  if (level === 'uncaught' || level === 'rejection') track('error', { level, text }, { every: 3600_000 })
}

let installed = false

/** Wire the window's uncaught errors and the console's error/warn calls
 *  into the ring buffer. Call once, before the app renders. */
export function installErrorLog() {
  if (installed) return
  installed = true
  window.addEventListener('error', (e) =>
    push('uncaught', [e.message, e.filename ? `${e.filename}:${e.lineno}` : '']),
  )
  window.addEventListener('unhandledrejection', (e) => push('rejection', [e.reason]))
  const error = console.error.bind(console)
  const warn = console.warn.bind(console)
  console.error = (...a: unknown[]) => {
    push('error', a)
    error(...a)
  }
  console.warn = (...a: unknown[]) => {
    push('warn', a)
    warn(...a)
  }
}

// ---------- the report ----------

function yn(v: boolean): string {
  return v ? 'yes' : 'no'
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`
  return `${(n / 1e3).toFixed(0)} KB`
}

function overlayLine(
  s: { state: string; runAgeMs: number; checkedAgoMs: number },
  info: { model: string; run: string } | null,
): string {
  const run = info ? `${info.model} ${info.run}` : 'none'
  return `${s.state} · run ${run} (${agoLabel(s.runAgeMs)}) · checked ${agoLabel(s.checkedAgoMs)}`
}

function standalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean }
  return nav.standalone === true || matchMedia('(display-mode: standalone)').matches
}

/** Everything a bug email needs, as plain text. Async only for the two
 *  disk reads (grid cache age, storage estimate). */
export async function buildReport(): Promise<string> {
  const app = useAppStore.getState()
  const gps = useGpsStore.getState()
  const now = Date.now()

  const [grid, quota] = await Promise.all([
    cachedGridForecast().catch(() => null),
    storageEstimate().catch(() => null),
  ])

  const fix = gps.fix
  const gpsLine = fix
    ? `${gps.status} · ${fix.lat.toFixed(4)}, ${fix.lon.toFixed(4)} ±${Math.round(fix.accuracy)} m` +
      ` · SOG ${fix.sogKn?.toFixed(1) ?? '–'} kn · COG ${fix.cog?.toFixed(0) ?? '–'}°` +
      ` · fix ${agoLabel(now - fix.ts)}`
    : `${gps.status} · no fix`

  const layersOn = Object.entries(app.layers)
    .filter(([, on]) => on)
    .map(([k]) => k)
    .join(', ')

  const stored = listStored()
  const charts = stored.length ? stored.map((s) => s.name).join(', ') : 'none downloaded'

  const om = openMeteoLastError()
  const recent = log.slice(-REPORT_MAX)

  const lines = [
    `Sandies problem report`,
    `Build: ${BUILD.sha} · ${BUILD.at}`,
    `Page: ${location.origin}${location.pathname} · installed ${yn(standalone())}`,
    `Device: ${navigator.userAgent}`,
    `Screen: ${screen.width}×${screen.height} @${devicePixelRatio} · viewport ${innerWidth}×${innerHeight}`,
    `Time: ${new Date(now).toString()}`,
    `Online: ${yn(app.online)} · service worker ${yn(!!navigator.serviceWorker?.controller)}`,
    ``,
    `GPS: ${gpsLine}${gps.lastError ? ` · last error: ${gps.lastError}` : ''}`,
    `View: helm ${yn(app.helm)} · low power ${yn(app.lowPower)} · heading-up ${yn(app.headingUp)} · follow ${yn(app.follow)}`,
    `Layers: ${layersOn || 'none'}`,
    `Units: depth ${app.depthUnit} · boat ${app.speedUnit} · wind ${app.windUnit}`,
    `Plan time: ${app.planTimeMs ? new Date(app.planTimeMs).toString() : 'now'}`,
    ``,
    `Charts: ${charts}`,
    `Missing charts: ${app.missingCharts.length ? app.missingCharts.join(', ') : 'none'} · offline ready ${yn(app.offlineReady)}`,
    `Storage: ${quota ? `${fmtBytes(quota.usage)} of ${fmtBytes(quota.quota)}` : 'unknown'}`,
    ``,
    `Forecast grid: ${grid ? `cached ${agoLabel(grid.ageMs)}` : 'no cache'}`,
    `HRDPS wind: ${overlayLine(windOverlayStatus(), windOverlayInfo())}`,
    `RDWPS waves: ${overlayLine(waveOverlayStatus(), waveOverlayInfo())}`,
    `Open-Meteo: ${om ? `error ${agoLabel(now - om.at)}: ${om.reason}` : 'no recent error'}`,
    ``,
    `Recent errors (${log.length} logged, last ${recent.length}):`,
    ...(recent.length
      ? recent.map((e) => `  ${agoLabel(now - e.at)} [${e.level}] ${e.text}`)
      : ['  none']),
  ]
  return lines.join('\n')
}

/** A mailto: link that opens the phone's mail app with the report filled
 *  in below a space for the user's own words. */
export function reportMailto(report: string): string {
  const subject = `Sandies problem (${BUILD.sha})`
  const body =
    `What happened?\n\n\n\n` +
    `What did you expect to see?\n\n\n\n` +
    `---- details for Gavan (please leave these in) ----\n${report}\n`
  return `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}
