import { SEA_BANDS } from '../weather/seaState'
import { setSeaFelt } from './engine'
import { AchGlyph } from './icons'
import { ACH_BY_ID } from './registry'
import { useDiscoverStore } from './store'

/**
 * The arrival card's strip, on the live trip card from the moment the boat
 * reaches the destination: the one question — what did the water feel
 * like, one tap on the ramp — and the tiles earned since cast-off. Asked
 * here, on the ride home, because END at the ramp closes the card; a trip
 * ended before it was answered gets asked once more (UnlockToast).
 */
export default function ArrivalStrip() {
  const trip = useDiscoverStore((s) => s.trip)
  if (!trip || trip.arrivedAt == null) return null
  const earned = trip.earnedIds.map((id) => ACH_BY_ID.get(id)).filter((a) => a != null)
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
      {earned.length > 0 && (
        <div className="dv-earned">
          {earned.map((a) => (
            <span key={a.id} className="dv-ach fresh">
              <AchGlyph icon={a.icon} />
              <span>
                <b>{a.name}</b>
                <i>today</i>
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
