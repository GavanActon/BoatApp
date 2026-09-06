import { useEffect, useState } from 'react'
import { depthAt, formatDepth } from '../map/depthGrid'
import { endTrip } from '../routing/planner'
import { useRouteStore } from '../routing/routeStore'
import { useAppStore } from '../state/appStore'
import { useGpsStore } from '../tracking/gpsStore'
import { stopRecording } from '../tracking/gpsService'
import { useLookAhead } from '../tracking/lookahead'
import { addMark, initMarks } from '../tracking/marks'
import { distanceUnitFor, knToUnit, runDistance, speedUnitLabel, type SpeedUnit } from '../units'
import { haptic } from './haptics'
import { IconPin } from './icons'

/** How long the first tap's "End trip · tap again" stands. */
const ARM_MS = 4000

function fmtSog(sogKn: number | null, unit: SpeedUnit): string {
  if (sogKn == null) return '—'
  const v = knToUnit(unit, sogKn)
  return v < 10 ? v.toFixed(1) : v.toFixed(0)
}

function fmtCog(cog: number | null): string {
  if (cog == null) return '—'
  return `${Math.round(cog).toString().padStart(3, '0')}°`
}

/**
 * The recording pill: the dot, the distance, and under way the ONE control
 * that ends things. Ending a trip is more than stopping a track — it
 * dismisses the subject and clears the dock — so a bump on a bouncing boat
 * must not do it: the first tap arms, names what the second will do, and
 * stands down on its own; the same arm-and-answer grammar as the strip's
 * chips. A plain track stops at once.
 */
export function RecPill() {
  const distanceNm = useGpsStore((s) => s.recordingDistanceNm)
  const speedUnit = useAppStore((s) => s.speedUnit)
  const underWay = useRouteStore((s) => s.tripStartedAt) != null
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), ARM_MS)
    return () => window.clearTimeout(t)
  }, [armed])
  useEffect(() => {
    if (!underWay) setArmed(false)
  }, [underWay])
  const dist = `${runDistance(speedUnit, distanceNm)} ${distanceUnitFor(speedUnit)}`
  if (!underWay) {
    // plain track recording: the pill IS the stop — the Tracks panel's stop
    // is behind a sheet, so this is the only one on screen
    return (
      <button className="rec-btn recording" onClick={() => void stopRecording()} aria-label="Stop recording track">
        <span className="rec-dot" />
        {dist}
      </button>
    )
  }
  return (
    <button
      className={`rec-btn recording${armed ? ' rec-arm' : ''}`}
      onClick={() => {
        if (!armed) {
          setArmed(true)
          return
        }
        setArmed(false)
        haptic('confirm')
        endTrip()
      }}
      aria-label={armed ? 'End trip — tap again' : 'Recording — tap to end the trip'}
    >
      <span className="rec-dot" />
      {armed ? 'End trip · tap again' : dist}
    </button>
  )
}

/**
 * SOG, COG, depth and the pill. On its own glass while a plain track
 * records; under way the live trip card hosts it (`embedded`), so the
 * dock is one card, not two.
 */
export default function InstrumentBar({ embedded = false }: { embedded?: boolean }) {
  const fix = useGpsStore((s) => s.fix)
  const status = useGpsStore((s) => s.status)
  const recording = useGpsStore((s) => s.recording)
  const depthUnit = useAppStore((s) => s.depthUnit)
  const speedUnit = useAppStore((s) => s.speedUnit)
  const underWay = useRouteStore((s) => s.tripStartedAt) != null

  const depth = fix ? depthAt(fix.lon, fix.lat) : null
  const hasGps = status === 'on' && fix != null

  // tied up, the bar is three dashes and a button the trip card already
  // carries — the map gets the room until we're actually moving
  if (!embedded && !recording && !underWay) return null

  return (
    <div className={`instruments${embedded ? ' inst-embedded' : ' glass'}`}>
      <div className="inst">
        <span className="inst-label">SOG</span>
        <span className="inst-value numeral">{hasGps ? fmtSog(fix.sogKn, speedUnit) : '—'}</span>
        <span className="inst-unit">{speedUnitLabel(speedUnit)}</span>
      </div>
      <div className="inst-divider" />
      <div className="inst">
        <span className="inst-label">COG</span>
        <span className="inst-value numeral">{hasGps ? fmtCog(fix.cog) : '—'}</span>
        <span className="inst-unit">true</span>
      </div>
      <div className="inst-divider" />
      <div className="inst">
        <span className="inst-label">DEPTH</span>
        <span className="inst-value numeral">{hasGps ? formatDepth(depth, depthUnit) : '—'}</span>
        <span className="inst-unit">{depthUnit}</span>
        <AheadLine depthUnit={depthUnit} />
      </div>
      {recording && <MarkButton />}
      <RecPill />
    </div>
  )
}

/** The cone ahead, under the depth: the shallowest charted water over the
 *  next two minutes of course — and, amber, the nearest sounding under the
 *  skipper's own shallow figure with its distance and side. Nothing while
 *  stopped or without a course. Numbers, not a verdict. */
function AheadLine({ depthUnit }: { depthUnit: 'm' | 'ft' }) {
  const ahead = useLookAhead((s) => s.ahead)
  if (!ahead || ahead.minM == null) return null
  const s = ahead.shallow
  if (s) {
    const side = s.side === 'port' ? '◀' : s.side === 'starboard' ? '▶' : '▲'
    return (
      <span className="inst-ahead shallow numeral" aria-label={`Shallow ahead: ${formatDepth(s.depthM, depthUnit)} ${depthUnit} in ${Math.round(s.distM)} metres`}>
        {side} {formatDepth(s.depthM, depthUnit)} · {Math.round(s.distM)} m
      </span>
    )
  }
  return (
    <span className="inst-ahead numeral" aria-label={`Shallowest ahead ${formatDepth(ahead.minM, depthUnit)} ${depthUnit}`}>
      ahead {formatDepth(ahead.minM, depthUnit)}
    </span>
  )
}

/** One tap: a mark at the boat, with the time and the depth — the pin
 *  rings on the chart at once, and the log entry keeps it. */
function MarkButton() {
  const [flash, setFlash] = useState(false)
  useEffect(() => {
    initMarks()
  }, [])
  return (
    <button
      className={`mark-btn${flash ? ' mark-hit' : ''}`}
      aria-label="Mark this spot"
      onClick={() => {
        void addMark().then((m) => {
          if (!m) return
          haptic('confirm')
          setFlash(true)
          setTimeout(() => setFlash(false), 600)
        })
      }}
    >
      <IconPin size={20} />
    </button>
  )
}
