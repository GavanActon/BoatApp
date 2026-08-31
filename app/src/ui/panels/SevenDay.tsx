import { useMemo } from 'react'
import { useAppStore } from '../../state/appStore'
import { dateShort, dayLabel, hourOfDayLabel, isToday } from '../../time'
import { speedUnitLabel, windSpeed } from '../../units'
import { dailyOutlook, skyLabel, type DayOutlook, type PointForecast } from '../../weather/openMeteo'
import { seaColor, seaName } from '../../weather/seaState'
import { IconSky, IconWindArrow } from '../icons'

/**
 * The week at a glance — the weather tab's headline, and the thing most
 * often being asked of it: which of the next seven days is worth going out.
 *
 * One row per day, each a whole answer on its own line: how the day rates
 * for a small boat (the colored edge), the sky and temperature, the wind
 * range with the direction it blows from, the biggest wave, and underneath,
 * the hours that earned the rating. Everything is rolled up over daytime
 * hours only — see dailyOutlook.
 *
 * Tapping a day sets the app-wide planning time, so the hourly table below
 * (and the map's wind & wave preview) drops straight into it.
 */

/** "7 AM – 1 PM" from a half-open window. */
function windowLabel(w: { fromMs: number; toMs: number }): string {
  const from = hourOfDayLabel(new Date(w.fromMs).getHours())
  const to = hourOfDayLabel(new Date(w.toMs).getHours())
  return `${from} – ${to}`
}

/** Gusts worth calling out on their own: well above the day's peak sustained
 *  wind is the squally afternoon a rolled-up average hides. */
function gustNote(d: DayOutlook): number | null {
  if (d.gustMaxKn == null || d.windMaxKn == null) return null
  return d.gustMaxKn >= d.windMaxKn + 8 ? d.gustMaxKn : null
}

export default function SevenDay({ forecast }: { forecast: PointForecast }) {
  const planTimeMs = useAppStore((s) => s.planTimeMs)
  const setPlanTime = useAppStore((s) => s.setPlanTime)
  const windUnit = useAppStore((s) => s.windUnit)

  const days = useMemo(() => dailyOutlook(forecast), [forecast])
  const selDay = planTimeMs == null ? null : new Date(planTimeMs).setHours(0, 0, 0, 0)

  return (
    <div className="sevenday">
      {days.map((d) => {
        const today = isToday(d.dayStartMs)
        const sel = selDay == null ? today : d.dayStartMs === selDay
        // beyond the forecast there is nothing to drop into; today is always
        // reachable, since picking it just means "now"
        const dead = d.cond == null && !today

        const lo = d.windMinKn == null ? null : windSpeed(windUnit, d.windMinKn)
        const hi = d.windMaxKn == null ? null : windSpeed(windUnit, d.windMaxKn)
        // late in the day there are only a couple of hours left to roll up,
        // and a high sitting beside an identical low reads as a misprint
        const tHi = d.tempMaxC == null ? null : Math.round(d.tempMaxC)
        const tLo = d.tempMinC == null ? null : Math.round(d.tempMinC)
        const gust = gustNote(d)
        const verdict =
          d.waveMaxM != null ? seaName(d.waveMaxM) : null

        const windText =
          lo == null ? 'no wind data' : `wind ${lo === hi ? lo : `${lo} to ${hi}`} ${speedUnitLabel(windUnit)}`
        const label =
          `${dayLabel(d.dayStartMs)}: ` +
          (verdict == null
            ? today
              ? 'no hours left today'
              : 'beyond the forecast'
            : `${verdict ?? ''}` +
              (d.window ? `, ${windowLabel(d.window)}` : '') +
              `, ${windText}` +
              (d.waveMaxM != null ? `, waves to ${d.waveMaxM.toFixed(1)} metres` : '') +
              (gust != null ? `, gusts to ${windSpeed(windUnit, gust)}` : '') +
              (d.weatherCode != null ? `, ${skyLabel(d.weatherCode)}` : ''))

        return (
          <button
            key={d.dayStartMs}
            className={`sd-row${sel ? ' sd-on' : ''}`}
            style={{ borderLeftColor: seaColor(d.waveMaxM) }}
            onClick={() => {
              if (today) setPlanTime(null)
              else setPlanTime(d.window ? d.window.fromMs : d.dayStartMs + 9 * 3600_000)
            }}
            disabled={dead}
            aria-pressed={sel}
            aria-label={label}
          >
            <span className="sd-day">
              <b>{dayLabel(d.dayStartMs)}</b>
              <em className="numeral">{dateShort(d.dayStartMs)}</em>
            </span>

            <span className="sd-sky">
              {d.weatherCode != null && <IconSky code={d.weatherCode} size={17} />}
              {tHi != null && <b className="numeral">{tHi}°</b>}
              {tLo != null && tLo !== tHi && <em className="numeral">{tLo}°</em>}
            </span>

            <span className="sd-wind">
              {d.windDir != null && <IconWindArrow deg={d.windDir + 180} size={13} />}
              <b className="numeral">{lo == null ? '—' : lo === hi ? lo : `${lo}–${hi}`}</b>
              <em>{speedUnitLabel(windUnit)}</em>
            </span>

            <span className="sd-wave">
              <b className="numeral">{d.waveMaxM != null ? d.waveMaxM.toFixed(1) : '—'}</b>
              {d.waveMaxM != null && <em> m</em>}
            </span>

            <span className="sd-note">
              {verdict == null ? (
                today ? (
                  'No hours left today'
                ) : (
                  'Beyond the forecast'
                )
              ) : (
                <>
                  <b className="sd-verdict" style={{ color: seaColor(d.waveMaxM) }}>{verdict}</b>
                  {' · '}
                  {d.window ? windowLabel(d.window) : 'no usable window'}
                  {gust != null && ` · gusts ${windSpeed(windUnit, gust)}`}
                </>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
