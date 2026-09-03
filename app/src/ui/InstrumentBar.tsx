import { useEffect, useState } from 'react'
import { depthAt, formatDepth } from '../map/depthGrid'
import { endTrip } from '../routing/planner'
import { useRouteStore } from '../routing/routeStore'
import { useAppStore } from '../state/appStore'
import { useGpsStore } from '../tracking/gpsStore'
import { stopRecording } from '../tracking/gpsService'
import { distanceUnitFor, knToUnit, runDistance, speedUnitLabel, type SpeedUnit } from '../units'
import { haptic } from './haptics'

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

export default function InstrumentBar() {
  const fix = useGpsStore((s) => s.fix)
  const status = useGpsStore((s) => s.status)
  const recording = useGpsStore((s) => s.recording)
  const distanceNm = useGpsStore((s) => s.recordingDistanceNm)
  const depthUnit = useAppStore((s) => s.depthUnit)
  const speedUnit = useAppStore((s) => s.speedUnit)
  const underWay = useRouteStore((s) => s.tripStartedAt) != null

  const depth = fix ? depthAt(fix.lon, fix.lat) : null
  const hasGps = status === 'on' && fix != null

  // Under way the pill is the ONE control that ends things, and ending a
  // trip is more than stopping a track — it dismisses the subject and
  // clears the dock — so a bump on a bouncing boat must not do it: the
  // first tap arms, names what the second will do, and stands down on its
  // own; the same arm-and-answer grammar as the strip's chips.
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), ARM_MS)
    return () => window.clearTimeout(t)
  }, [armed])
  useEffect(() => {
    if (!underWay) setArmed(false)
  }, [underWay])

  // tied up, the bar is three dashes and a button the trip card already
  // carries — the map gets the room until we're actually moving
  if (!recording && !underWay) return null

  return (
    <div className="instruments glass">
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
      </div>
      {underWay ? (
        // trip running: the recording tell — distance covered, the dot —
        // and the one control there is: tap, then tap again, and the trip
        // and its track end together. The trip card carries no End of its
        // own; a stop that lives in two places reads as two controls.
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
          {armed ? 'End trip · tap again' : `${runDistance(speedUnit, distanceNm)} ${distanceUnitFor(speedUnit)}`}
        </button>
      ) : (
        // plain track recording: here the pill IS the stop — the Tracks
        // panel's stop is behind a sheet, so this is the only one on screen
        <button
          className="rec-btn recording"
          onClick={() => void stopRecording()}
          aria-label="Stop recording track"
        >
          <span className="rec-dot" />
          {runDistance(speedUnit, distanceNm)} {distanceUnitFor(speedUnit)}
        </button>
      )}
    </div>
  )
}
