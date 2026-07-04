import { depthAt, formatDepth } from '../map/depthGrid'
import { useAppStore } from '../state/appStore'
import { useGpsStore } from '../tracking/gpsStore'
import { startRecording, stopRecording } from '../tracking/gpsService'

function fmtSog(sogKn: number | null): string {
  if (sogKn == null) return '—'
  return sogKn < 10 ? sogKn.toFixed(1) : sogKn.toFixed(0)
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

  const depth = fix ? depthAt(fix.lon, fix.lat) : null
  const hasGps = status === 'on' && fix != null

  return (
    <div className="instruments glass">
      <div className="inst">
        <span className="inst-label">SOG</span>
        <span className="inst-value numeral">{hasGps ? fmtSog(fix.sogKn) : '—'}</span>
        <span className="inst-unit">kn</span>
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
      <button
        className={`rec-btn ${recording ? 'recording' : ''}`}
        onClick={() => (recording ? void stopRecording() : void startRecording())}
        aria-label={recording ? 'Stop recording track' : 'Record track'}
      >
        <span className="rec-dot" />
        {recording ? `${distanceNm.toFixed(1)} nm` : 'REC'}
      </button>
    </div>
  )
}
