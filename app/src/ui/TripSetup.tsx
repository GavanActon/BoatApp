import { useRouteStore } from '../routing/routeStore'
import { useAppStore } from '../state/appStore'
import { durationLabel, hourOfDayLabel } from '../time'
import { knToUnit, speedUnitLabel, unitToKn } from '../units'
import { IconClose, IconMinus, IconPlus } from './icons'

/**
 * Boat & family configuration — round trip, cruise speed, minimum stay,
 * back-by. Rarely touched, so it lives behind the trip card's sliders button
 * as a small card of its own rather than taking permanent space anywhere.
 */

const STAY_CHOICES = [
  { min: 30, label: '30m' },
  { min: 60, label: '1h' },
  { min: 120, label: '2h' },
  { min: 180, label: '3h' },
]

const BACKBY_MIN_H = 11 // stepping below 11 AM makes no trip; above 11 PM means "any"
const BACKBY_MAX_H = 23

export default function TripSetup({ onClose }: { onClose: () => void }) {
  const speedUnit = useAppStore((s) => s.speedUnit)
  const roundTrip = useRouteStore((s) => s.roundTrip)
  const setRoundTrip = useRouteStore((s) => s.setRoundTrip)
  const cruiseKn = useRouteStore((s) => s.cruiseKn)
  const setCruiseKn = useRouteStore((s) => s.setCruiseKn)
  const stayMin = useRouteStore((s) => s.stayMin)
  const setStayMin = useRouteStore((s) => s.setStayMin)
  const plannedStayMin = useRouteStore((s) => s.plannedStayMin)
  const backByHour = useRouteStore((s) => s.backByHour)
  const setBackBy = useRouteStore((s) => s.setBackBy)

  // cruise speed is stored in knots; step by whole units of the chosen display unit
  const shownSpeed = Math.round(knToUnit(speedUnit, cruiseKn))
  const stepSpeed = (delta: number) => setCruiseKn(unitToKn(speedUnit, shownSpeed + delta))

  // step the back-by hour; past 11 PM it means "no limit" ("Any" sits one
  // notch above the max, so − from Any lands back on 11 PM)
  const stepBackBy = (delta: number) => {
    const base = backByHour ?? BACKBY_MAX_H + 1
    const next = base + delta
    setBackBy(next > BACKBY_MAX_H ? null : Math.max(BACKBY_MIN_H, next))
  }

  return (
    <div className="tripbuilder glass tripsetup">
      <div className="tb-head">
        <span className="tb-title">Trip setup</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close trip setup">
          <IconClose size={16} />
        </button>
      </div>

      <label className="row">
        <div className="row-text">
          <span className="row-title">Round trip</span>
          <span className="row-desc">Rates the weather for the ride back too</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={roundTrip}
          onChange={(e) => setRoundTrip(e.target.checked)}
        />
      </label>

      <div className="row">
        <div className="row-text">
          <span className="row-title">Cruise speed</span>
          <span className="row-desc">Used to time the trip and the forecast</span>
        </div>
        <div className="stepper">
          <button className="icon-btn" onClick={() => stepSpeed(-1)} aria-label="Slower">
            <IconMinus size={16} />
          </button>
          <b className="numeral">
            {shownSpeed}
            <span> {speedUnitLabel(speedUnit)}</span>
          </b>
          <button className="icon-btn" onClick={() => stepSpeed(1)} aria-label="Faster">
            <IconPlus size={16} />
          </button>
        </div>
      </div>

      {roundTrip && (
        <div className="row">
          <div className="row-text">
            <span className="row-title">Time there</span>
            <span className="row-desc">
              {plannedStayMin != null
                ? `At least ${durationLabel(stayMin)} · planned ${durationLabel(plannedStayMin)} from the picked hour`
                : 'At least — a picked hour stretches it while the weather holds'}
            </span>
          </div>
          <div className="seg">
            {STAY_CHOICES.map((c) => (
              <button
                key={c.min}
                className={stayMin === c.min ? 'seg-on' : ''}
                onClick={() => setStayMin(c.min)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="row">
        <div className="row-text">
          <span className="row-title">Back by</span>
          <span className="row-desc">
            {roundTrip ? 'Latest you want to be home' : 'Latest you want to arrive'}
          </span>
        </div>
        <div className="stepper">
          <button className="icon-btn" onClick={() => stepBackBy(-1)} aria-label="Back an hour earlier">
            <IconMinus size={16} />
          </button>
          <b className="numeral">{backByHour == null ? 'Any' : hourOfDayLabel(backByHour)}</b>
          <button
            className="icon-btn"
            onClick={() => stepBackBy(1)}
            disabled={backByHour == null}
            aria-label="Back an hour later"
          >
            <IconPlus size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
