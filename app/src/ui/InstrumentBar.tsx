import { depthAt, formatDepth } from '../map/depthGrid'
import { endTrip, startTrip } from '../routing/planner'
import { useRouteStore } from '../routing/routeStore'
import { useAppStore } from '../state/appStore'
import { useGpsStore } from '../tracking/gpsStore'
import { startRecording, stopRecording } from '../tracking/gpsService'
import { knToUnit, speedUnitLabel, type SpeedUnit } from '../units'
import { IconRoute } from './icons'

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
  const plan = useRouteStore((s) => s.plan)
  const underWay = useRouteStore((s) => s.tripStartedAt) != null

  const depth = fix ? depthAt(fix.lon, fix.lat) : null
  const hasGps = status === 'on' && fix != null

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
        // trip running: shows distance covered; tap to end the trip
        <button className="rec-btn recording" onClick={() => endTrip()} aria-label="End trip">
          <span className="rec-dot" />
          {distanceNm.toFixed(1)} nm
        </button>
      ) : plan ? (
        // trip loaded and ready: one tap casts off
        <button className="rec-btn go" onClick={() => startTrip()} aria-label="Start trip">
          <IconRoute size={15} />
          GO
        </button>
      ) : (
        // no trip — plain track recording
        <button
          className={`rec-btn ${recording ? 'recording' : ''}`}
          onClick={() => (recording ? void stopRecording() : void startRecording())}
          aria-label={recording ? 'Stop recording track' : 'Record track'}
        >
          <span className="rec-dot" />
          {recording ? `${distanceNm.toFixed(1)} nm` : 'REC'}
        </button>
      )}
    </div>
  )
}
