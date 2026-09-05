import { useAppStore } from '../state/appStore'
import { SEA_BANDS } from '../weather/seaState'
import { setSeaFelt } from './engine'
import { useDiscoverStore } from './store'

/**
 * The arrival strip on the live trip card, from the moment the boat reaches
 * the destination: the one question — what did the water feel like, one tap
 * on the ramp — and only for those who asked for it (Settings › Sea felt).
 * Asked here, on the ride home, because END at the ramp closes the card; a
 * trip ended before it was answered gets asked once more (UnlockToast).
 *
 * What the trip earned is NOT here any more: the moments play over the
 * chart as they land, and the card at arrival is for the arrival (Gavan,
 * 2026-09-04).
 */
export default function ArrivalStrip() {
  const trip = useDiscoverStore((s) => s.trip)
  const ask = useAppStore((s) => s.askSeaFelt)
  if (!trip || trip.arrivedAt == null || !ask) return null
  return (
    <div className="dv-arrive">
      <div className="dv-felt">
        <span className="dv-felt-lab">Sea felt</span>
        <div className={`dv-felt-bar${trip.feltBand != null ? ' picked' : ''}`} role="radiogroup" aria-label="Sea felt">
          {SEA_BANDS.map((b, i) => (
            <button
              key={b.name}
              className={trip.feltBand === i ? 'on' : ''}
              style={{ background: b.color }}
              role="radio"
              aria-checked={trip.feltBand === i}
              aria-label={b.name}
              onClick={() => setSeaFelt(trip.feltBand === i ? null : i)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
