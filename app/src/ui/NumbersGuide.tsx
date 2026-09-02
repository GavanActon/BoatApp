import { useAppStore } from '../state/appStore'
import { SEA_BANDS } from '../weather/seaState'
import { speedUnitLabel } from '../units'
import { IconWindArrow } from './icons'

/**
 * Read-the-water (DESIGN-SPEC §10.4): one card that decodes the app's whole
 * numeric language — the strip cell's anatomy, the sea-state ramp, the
 * depth soundings. A first-run surface (exempt from §1.5 with the welcome),
 * opened from the first-voyage card and dismissable in one tap; the ramp
 * swatches are the REAL `seaState.ts` colours, so the legend can never
 * drift from the water it describes.
 */

export default function NumbersGuide() {
  const show = useAppStore((s) => s.showNumbersGuide)
  const setShow = useAppStore((s) => s.setShowNumbersGuide)
  const setSeen = useAppStore((s) => s.setNumbersSeen)
  const windUnit = useAppStore((s) => s.windUnit)
  const depthUnit = useAppStore((s) => s.depthUnit)

  if (!show) return null
  const close = () => {
    setSeen(true)
    setShow(false)
  }

  return (
    <div className="welcome" role="dialog" aria-label="Reading the water">
      <div className="welcome-card ng-card">
        <h2>Reading the water</h2>

        <div className="ng-anatomy">
          <div className="ng-cell" aria-hidden>
            <span className="ng-cell-h">2P</span>
            <IconWindArrow deg={225} size={13} />
            <span className="ng-cell-w numeral">12</span>
            <span className="ng-cell-s numeral">0.4·3s</span>
          </div>
          <div className="ng-legend">
            <div className="ng-lr">
              <span className="ng-k">2P</span>
              <span>the hour — tap it and the whole app plans for that moment</span>
            </div>
            <div className="ng-lr">
              <span className="ng-k">
                <IconWindArrow deg={225} size={12} />
              </span>
              <span>where the wind blows toward</span>
            </div>
            <div className="ng-lr">
              <span className="ng-k numeral">12</span>
              <span>wind speed · {speedUnitLabel(windUnit)}</span>
            </div>
            <div className="ng-lr">
              <span className="ng-k numeral">0.4·3s</span>
              <span>wave height (m) · seconds between crests — short and steep beats up a small boat</span>
            </div>
          </div>
        </div>

        <div className="ng-ramp" aria-hidden>
          {SEA_BANDS.map((b) => (
            <i key={b.name} style={{ background: b.color }} title={b.name} />
          ))}
        </div>
        <div className="ng-ramp-labels">
          <span>{SEA_BANDS[0].name}</span>
          <span>sea-state colour — the same language on the strip, the lanes and the badges</span>
          <span>{SEA_BANDS[SEA_BANDS.length - 1].name}</span>
        </div>

        <div className="ng-lr ng-depth">
          <span className="ng-k numeral">41</span>
          <span>plain numbers on the chart — depth · {depthUnit}</span>
        </div>

        <button className="welcome-next" onClick={close}>
          Got it
        </button>
      </div>
    </div>
  )
}
