import { useEffect, useState } from 'react'
import { useAppStore } from '../state/appStore'
import { agoLabel, timeLabel } from '../time'
import CircleSettings from './CircleSettings'
import { boatAgeMs, describeBoat, showBoat } from './circleLayer'
import { disablePush, enablePush, pushState, type PushState } from './push'
import { friendBoats, friendMembers, useCircleStore, type Boat, type Member, type Plan } from './store'
import { onCirclePoll } from './sync'

/**
 * The Crew sheet: everyone in the crews, in three groups — out now (a
 * position, cast-off to home), planning (where and when, no position),
 * ashore (home, or just joined) — then the crews themselves: the code,
 * the skipper card, the doors. Replaces Boats out (top of Places) and
 * Settings › Trip sharing. Facts in fragments, no verdicts (§1.5).
 */

const DAY_MS = 86400_000
const GONE_MS = 2 * 3600_000

/** "10:00" today, "tomorrow 10:00", "Sat 10:00", else "Sep 20 10:00". */
function whenLabel(ms: number, now: number): string {
  const d = new Date(ms)
  const today = new Date(now)
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(d) - startOf(today)) / DAY_MS)
  const t = timeLabel(ms)
  if (days === 0) return t
  if (days === 1) return `tomorrow ${t}`
  if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${t}`
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${t}`
}

/** A day, the way a person says it: "today", "Sat", "Aug 12". */
function dayLabel(ms: number, now: number): string {
  const d = new Date(ms)
  const days = Math.floor((now - ms) / DAY_MS)
  if (days < 1 && new Date(now).getDate() === d.getDate()) return 'today'
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function describePlan(p: Plan, now: number): string {
  const parts = [p.dest.name ?? 'a pinned spot', whenLabel(p.outMs, now)]
  if (p.backMs != null) parts.push(`back ${timeLabel(p.backMs)}`)
  return parts.join(' · ')
}

function who(m: { name: string; boat: string }): string {
  return m.boat ? `${m.name} · ${m.boat}` : m.name
}

export default function CrewPanel() {
  const circles = useCircleStore((s) => s.circles)
  const members = useCircleStore((s) => s.members)
  const boats = useCircleStore((s) => s.boats)
  const fetchedAt = useCircleStore((s) => s.fetchedAt)
  const fetchError = useCircleStore((s) => s.fetchError)
  const markCrewSeen = useCircleStore((s) => s.markCrewSeen)
  const online = useAppStore((s) => s.online)
  const setSheetTab = useAppStore((s) => s.setSheetTab)
  const [, setTick] = useState(0)
  useEffect(() => {
    markCrewSeen()
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    const off = onCirclePoll(() => {
      markCrewSeen()
      setTick((n) => n + 1)
    })
    return () => {
      clearInterval(t)
      off()
    }
  }, [markCrewSeen])
  void members
  void boats

  const now = Date.now()
  // out now: a position under the chart's own two-hour rule, not yet home
  const outNow = friendBoats().filter((b) => b.trip?.state !== 'home' && boatAgeMs(b, now) < GONE_MS)
  const outIds = new Set(outNow.map((b) => b.deviceId))
  const planning = friendMembers().filter((m) => m.plan && !outIds.has(m.deviceId))
  const planIds = new Set(planning.map((m) => m.deviceId))
  const ashore = friendMembers().filter((m) => !outIds.has(m.deviceId) && !planIds.has(m.deviceId))
  const lastRecord = (m: Member): Boat | undefined => friendBoats().find((b) => b.deviceId === m.deviceId)

  const checked = fetchError && online ? 'no answer' : fetchedAt ? `checked ${agoLabel(now - fetchedAt)}` : online ? 'checking…' : 'offline'

  return (
    <div className="panel crew">
      {circles.length > 0 && (
        <>
          <div className="panel-section panel-section-first">
            <span>Out now</span>
            <span className="meta">{checked}</span>
          </div>
          {outNow.length === 0 ? (
            <div className="bo-empty">Nobody out</div>
          ) : (
            outNow.map((b) => (
              <button
                key={b.deviceId}
                className="bo-row"
                disabled={b.lon == null}
                onClick={() => {
                  showBoat(b)
                  setSheetTab(null)
                }}
                aria-label={`${b.name}: ${describeBoat(b)}, position ${agoLabel(boatAgeMs(b, now))}`}
              >
                <span className="bo-name">{who(b)}</span>
                <span className="bo-what">{describeBoat(b)}</span>
                <span className="bo-age numeral">{agoLabel(boatAgeMs(b, now))}</span>
              </button>
            ))
          )}

          {planning.length > 0 && (
            <>
              <div className="panel-section">
                <span>Planning</span>
              </div>
              {planning.map((m) => (
                <div key={m.deviceId} className="bo-row">
                  <span className="bo-name">{who(m)}</span>
                  <span className="bo-what">{describePlan(m.plan!, now)}</span>
                  <span className="bo-age numeral">{agoLabel(now - m.updated)}</span>
                </div>
              ))}
            </>
          )}

          {ashore.length > 0 && (
            <>
              <div className="panel-section">
                <span>Ashore</span>
              </div>
              {ashore.map((m) => {
                const last = lastRecord(m)
                const what =
                  last?.trip?.state === 'home'
                    ? `home · ${dayLabel(last.updated, now)}`
                    : `joined ${dayLabel(m.joined, now)}`
                return (
                  <div key={m.deviceId} className="bo-row ashore">
                    <span className="bo-name">{who(m)}</span>
                    <span className="bo-what">{what}</span>
                  </div>
                )
              })}
            </>
          )}
        </>
      )}

      {circles.length > 0 && <NotifyRow />}
      <CircleSettings />
    </div>
  )
}

/** The Notify switch: the browser's permission and the wish, as one. Where
 *  push can't exist (a Safari tab) the row says what would make it. */
function NotifyRow() {
  const notify = useCircleStore((s) => s.notify)
  const [state, setState] = useState<PushState>(pushState)
  const [busy, setBusy] = useState(false)
  useEffect(() => setState(pushState()), [notify])
  const desc =
    state === 'unsupported'
      ? 'joined · planning · departed · arrived · home · needs the Home Screen app'
      : state === 'denied'
        ? 'blocked for this site in the phone’s settings'
        : 'joined · planning · departed · arrived · home'
  return (
    <label className="row">
      <div className="row-text">
        <span className="row-title">Notify</span>
        <span className="row-desc">{desc}</span>
      </div>
      <input
        type="checkbox"
        className="switch"
        checked={state === 'on'}
        disabled={busy || state === 'unsupported' || state === 'denied'}
        onChange={(e) => {
          setBusy(true)
          void (e.target.checked ? enablePush() : disablePush().then(pushState))
            .then((s) => setState(s ?? pushState()))
            .finally(() => setBusy(false))
        }}
      />
    </label>
  )
}
