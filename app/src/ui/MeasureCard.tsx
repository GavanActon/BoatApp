import { useEffect } from 'react'
import { formatBearing, formatDistance, legsOf, totalNm } from '../measure/measureMath'
import { useMeasureStore } from '../measure/measureStore'
import { useRouteStore } from '../routing/routeStore'
import { useAppStore } from '../state/appStore'
import { durationLabel } from '../time'
import { knToUnit, speedUnitLabel } from '../units'
import { IconClose, IconUndo } from './icons'

/**
 * The measuring tool's readout, docked where the trip card sits: total range,
 * the last leg's range and bearing, and how long that distance takes at
 * cruise speed. The legs label themselves on the map; this is the sum.
 */
export default function MeasureCard() {
  const points = useMeasureStore((s) => s.points)
  const undo = useMeasureStore((s) => s.undo)
  const clear = useMeasureStore((s) => s.clear)
  const stop = useMeasureStore((s) => s.stop)
  const depthUnit = useAppStore((s) => s.depthUnit)
  const speedUnit = useAppStore((s) => s.speedUnit)
  const cruiseKn = useRouteStore((s) => s.cruiseKn)

  // desktop: Escape puts the ruler away
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stop])

  const legs = legsOf(points)
  const last = legs[legs.length - 1]
  const total = totalNm(points)

  return (
    <div className="tripbuilder glass measure-card">
      <div className="tb-head">
        <span className="tb-title">Measure</span>
        <button className="linklike" onClick={() => clear()} disabled={points.length === 0}>
          Clear
        </button>
        <button
          className="icon-btn"
          onClick={() => undo()}
          disabled={points.length === 0}
          aria-label="Undo last point"
        >
          <IconUndo size={16} />
        </button>
        <button className="icon-btn" onClick={() => stop()} aria-label="Close measuring tool">
          <IconClose size={16} />
        </button>
      </div>
      {legs.length === 0 ? (
        <div className="tb-hint">
          {points.length === 0 ? 'Tap two points' : 'Tap again'}
        </div>
      ) : (
        <>
          <div className="tb-facts">
            <span className="numeral">
              <b className="measure-total">{formatDistance(total, speedUnit, depthUnit)}</b>
              {legs.length > 1 ? ` total · ${legs.length} legs` : ' total'}
            </span>
            <span className="numeral">
              {legs.length > 1 ? 'last leg ' : ''}
              <b>{formatDistance(last.nm, speedUnit, depthUnit)}</b> · <b>{formatBearing(last.deg)}</b>
            </span>
            <span className="numeral">
              about <b>{durationLabel(Math.max(1, Math.round((total / cruiseKn) * 60)))}</b> at{' '}
              {Math.round(knToUnit(speedUnit, cruiseKn))} {speedUnitLabel(speedUnit)}
            </span>
          </div>
          <div className="tb-hint">
          </div>
        </>
      )}
    </div>
  )
}
