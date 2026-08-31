/**
 * Shared time helpers — one clock vocabulary for the whole app.
 *
 * The app has a single "planning time" (appStore.planTimeMs, null = now).
 * These helpers format and bucket moments consistently everywhere it shows:
 * the outlook strip, the trip chip, the verdict card and the timeline.
 */

/** Local midnight of the day containing `ms`. */
export function startOfDayMs(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Local midnight `days` days after today (DST-safe). */
export function dayStartAfter(days: number): number {
  const t = new Date()
  return new Date(t.getFullYear(), t.getMonth(), t.getDate() + days).getTime()
}

export function isToday(ms: number): boolean {
  return startOfDayMs(ms) === startOfDayMs(Date.now())
}

/** "9:45 AM" */
export function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** "Aug 24" */
export function dateShort(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** "Sat" */
export function dayShort(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'short' })
}

/** "Today" for today, otherwise "Sat". */
export function dayLabel(ms: number): string {
  return isToday(ms) ? 'Today' : dayShort(ms)
}

/** "9:45 AM" today, "Sat 9:45 AM" any other day. */
export function dayTimeLabel(ms: number): string {
  return isToday(ms) ? timeLabel(ms) : `${dayShort(ms)} ${timeLabel(ms)}`
}

/** Compact hour: "8a", "1p". */
export function hourShort(ms: number): string {
  const h = new Date(ms).getHours()
  return `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`
}

/** Top of the current hour. */
export function floorHourMs(ms = Date.now()): number {
  const d = new Date(ms)
  d.setMinutes(0, 0, 0)
  return d.getTime()
}

/** Hour-of-day label: 17 → "5 PM", 12 → "12 PM". */
export function hourOfDayLabel(h: number): string {
  return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`
}

/** Compact duration: "30m", "1h", "1½h", "2h". */
export function durationLabel(min: number): string {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  return `${h}${min % 60 >= 30 ? '½' : ''}h`
}

/** "just now", "12 min ago", "3 h ago", "2 d ago" — for data-freshness rows. */
export function agoLabel(ms: number): string {
  if (!Number.isFinite(ms)) return 'never'
  const min = Math.round(ms / 60_000)
  if (min < 2) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}
