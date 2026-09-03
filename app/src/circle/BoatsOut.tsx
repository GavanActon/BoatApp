import { useEffect, useState } from 'react'
import { useAppStore } from '../state/appStore'
import { agoLabel } from '../time'
import { boatAgeMs, describeBoat, showBoat } from './circleLayer'
import { friendBoats, useCircleStore } from './store'
import { onCirclePoll } from './sync'

/**
 * "Boats out" at the top of Places: every friend the circles know about,
 * most recent first, with what they're doing and how old the news is.
 * Tapping one shows them on the chart. Empty circles say so.
 */
export default function BoatsOut() {
  const circles = useCircleStore((s) => s.circles)
  const boats = useCircleStore((s) => s.boats)
  const fetchedAt = useCircleStore((s) => s.fetchedAt)
  const fetchError = useCircleStore((s) => s.fetchError)
  const online = useAppStore((s) => s.online)
  const setSheetTab = useAppStore((s) => s.setSheetTab)
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    const off = onCirclePoll(() => setTick((n) => n + 1))
    return () => {
      clearInterval(t)
      off()
    }
  }, [])
  if (!circles.length) return null
  void boats // the store's list re-renders this; friendBoats() reads the same
  const friends = friendBoats().filter((b) => b.trip?.state !== 'home')
  const now = Date.now()

  return (
    <div className="boats-out">
      <div className="bo-head">
        <span>Boats out</span>
        <span className="bo-meta">
          {fetchError && online
            ? 'can’t reach the circle'
            : fetchedAt
              ? `checked ${agoLabel(now - fetchedAt)}`
              : online
                ? 'checking…'
                : 'offline'}
        </span>
      </div>
      {friends.length === 0 ? (
        <div className="bo-empty">Nobody out.</div>
      ) : (
        friends.map((b) => (
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
            <span className="bo-name">{b.boat ? `${b.name} · ${b.boat}` : b.name}</span>
            <span className="bo-what">{describeBoat(b)}</span>
            <span className="bo-age numeral">{agoLabel(boatAgeMs(b, now))}</span>
          </button>
        ))
      )}
    </div>
  )
}
