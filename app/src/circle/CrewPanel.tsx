import { useEffect, useState } from 'react'
import { useAppStore } from '../state/appStore'
import { agoLabel, timeLabel } from '../time'
import CircleSettings from './CircleSettings'
import { boatAgeMs, describeBoat, showBoat } from './circleLayer'
import Mark from './Mark'
import { disablePush, enablePush, pushState, type PushState } from './push'
import { flairSummary, type Flair } from './marks'
import { boatColor, friendBoats, friendMembers, useCircleStore, type Boat, type Member, type Plan } from './store'
import { onCirclePoll } from './sync'

/**
 * The Crew sheet: everyone in the crews, in three groups — out now (a
 * position, cast-off to home), planning (where and when, no position),
 * ashore (home, or just joined) — then the crews themselves: the code,
 * the doors — and last, your own skipper card. Replaces Boats out (top of Places) and
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

/** "Name · Boat" */
function who(m: { name: string; boat: string }) {
  return m.boat ? `${m.name} · ${m.boat}` : m.name
}

/** The boat's mark in its own colour — the same glyph the chart wears —
 *  down the row's left. A wake only under way. */
function markCell(m: { deviceId: string; mark: string; flair: Flair | null }, wake = false) {
  return (
    <span className="bo-ic">
      <Mark size={26} mark={m.mark} color={boatColor(m.deviceId)} flair={m.flair} wake={wake} />
    </span>
  )
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
                {markCell(b, b.sogKn != null && b.sogKn >= 1)}
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
                  {markCell(m)}
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
                    {markCell(m)}
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
      <OwnCardRow />
    </div>
  )
}

/** The last row: your own card, the way the crew sees it, and the way to
 *  it — under the crews, never above them. The whole row is the tap. */
function OwnCardRow() {
  const skipper = useCircleStore((s) => s.skipper)
  const deviceId = useCircleStore((s) => s.deviceId)
  const cardDone = useCircleStore((s) => s.cardDone)
  const setCardOpen = useCircleStore((s) => s.setCardOpen)
  const title = who(skipper) || 'Your skipper card'
  const desc = cardDone ? ['your skipper card', flairSummary(skipper.flair)].filter(Boolean).join(' · ') : 'a mark · your name · your boat'
  return (
    <button className="row sk-row" onClick={() => setCardOpen({ then: null })} aria-label="Edit your skipper card">
      <Mark size={30} mark={skipper.mark} color={boatColor(deviceId)} flair={skipper.flair} />
      <div className="row-text">
        <span className="row-title">{title}</span>
        <span className="row-desc">{desc}</span>
      </div>
      <svg className="sk-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
    </button>
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
