import { useAppStore } from '../state/appStore'
import { speedUnitLabel, windSpeed } from '../units'
import { IconMinus, IconPlus } from './icons'

/** The skipper's limits. Unset until they say so — see appStore.waveLimitM. */
export default function LimitsRow() {
  const waveLimitM = useAppStore((s) => s.waveLimitM)
  const windLimitKn = useAppStore((s) => s.windLimitKn)
  const setLimits = useAppStore((s) => s.setLimits)
  const windUnit = useAppStore((s) => s.windUnit)

  if (waveLimitM == null || windLimitKn == null) {
    return (
      // §1.4: the app must not choose these. Opening the row at the bottom of
      // the scale means the first ± is the user's, not a value they inherited.
      <button className="limits-set" onClick={() => setLimits(0.1, 4)}>
        Set my limits
      </button>
    )
  }
  const stepWave = (d: number) =>
    setLimits(Math.min(3, Math.max(0.1, Math.round((waveLimitM + d) * 10) / 10)), windLimitKn)
  const stepWind = (d: number) => setLimits(waveLimitM, Math.min(45, Math.max(4, windLimitKn + d)))
  return (
    <div className="limits-row">
      <span className="limits-lab">My limits</span>
      <span className="limits-step">
        <button className="nudge" onClick={() => stepWave(-0.1)} aria-label="Lower the wave limit">
          <IconMinus size={11} />
        </button>
        <b className="numeral">{waveLimitM.toFixed(1)} m</b>
        <button className="nudge" onClick={() => stepWave(0.1)} aria-label="Raise the wave limit">
          <IconPlus size={11} />
        </button>
      </span>
      <span className="limits-step">
        <button className="nudge" onClick={() => stepWind(-1)} aria-label="Lower the wind limit">
          <IconMinus size={11} />
        </button>
        <b className="numeral">
          {windSpeed(windUnit, windLimitKn)} {speedUnitLabel(windUnit)}
        </b>
        <button className="nudge" onClick={() => stepWind(1)} aria-label="Raise the wind limit">
          <IconPlus size={11} />
        </button>
      </span>
    </div>
  )
}
