import { useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../state/appStore'
import type { PointForecast } from '../../weather/openMeteo'

/**
 * Wind + wave forecast charts across the full 7 days. One SVG, two stacked
 * plots sharing an x axis and a touch-scrub crosshair with a readout row
 * (mobile "tooltip"). The crosshair starts on the app-wide planning time.
 * Series colors validated for the dark navy surface:
 *   wind #2b9fdb · gust #c98500 · wave #1fae7c
 */

const HOURS = 168
const W = 360
const PAD_L = 34
const PAD_R = 10
const WIND_TOP = 16
const WIND_H = 92
const GAP = 34
const WAVE_TOP = WIND_TOP + WIND_H + GAP
const WAVE_H = 72
const AXIS_H = 20
const TOTAL_H = WAVE_TOP + WAVE_H + AXIS_H

const PLOT_W = W - PAD_L - PAD_R

const COL_WIND = '#2b9fdb'
const COL_GUST = '#c98500'
const COL_WAVE = '#1fae7c'
const COL_GRID = 'rgba(126, 178, 224, 0.12)'
const COL_AXIS = 'rgba(143, 169, 191, 0.9)'

function niceCeil(v: number, step: number): number {
  return Math.max(step, Math.ceil(v / step) * step)
}

function linePath(
  vals: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
): string {
  let d = ''
  let pen = false
  vals.forEach((v, i) => {
    if (v == null) {
      pen = false
      return
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    pen = true
  })
  return d
}

function areaPath(
  vals: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
  y0: number,
): string {
  // build closed segments for non-null runs
  let d = ''
  let run: number[] = []
  const flush = () => {
    if (run.length < 2) {
      run = []
      return
    }
    d += `M${x(run[0]).toFixed(1)},${y0}`
    for (const i of run) d += `L${x(i).toFixed(1)},${y(vals[i] as number).toFixed(1)}`
    d += `L${x(run[run.length - 1]).toFixed(1)},${y0}Z`
    run = []
  }
  vals.forEach((v, i) => {
    if (v == null) flush()
    else run.push(i)
  })
  flush()
  return d
}

export default function ForecastCharts({ forecast }: { forecast: PointForecast }) {
  const h = forecast.hourly
  const nowIdx = useMemo(() => {
    const now = Date.now()
    let best = 0
    for (let i = 0; i < h.time.length; i++) {
      if (Math.abs(Date.parse(h.time[i]) - now) < Math.abs(Date.parse(h.time[best]) - now)) best = i
    }
    return best
  }, [h.time])

  const i0 = Math.max(0, nowIdx - 1)
  const n = Math.min(HOURS, h.time.length - i0)
  const wind = h.windKn.slice(i0, i0 + n)
  const gust = h.gustKn.slice(i0, i0 + n)
  const wave = h.waveM.slice(i0, i0 + n)
  const times = h.time.slice(i0, i0 + n)

  const [scrub, setScrub] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // crosshair defaults to the app-wide planning time when one is picked
  const planTimeMs = useAppStore((s) => s.planTimeMs)
  const planIdx = useMemo(() => {
    if (planTimeMs == null) return null
    let best: number | null = null
    let bestDiff = 90 * 60_000 // must land within the plotted range
    for (let i = 0; i < times.length; i++) {
      const diff = Math.abs(Date.parse(times[i]) - planTimeMs)
      if (diff < bestDiff) {
        bestDiff = diff
        best = i
      }
    }
    return best
  }, [planTimeMs, times])

  const idx = scrub ?? planIdx ?? nowIdx - i0

  const windMax = niceCeil(Math.max(...gust.map((v) => v ?? 0), 10) * 1.1, 5)
  const waveMax = Math.max(0.5, Math.ceil(Math.max(...wave.map((v) => v ?? 0)) * 1.25 * 2) / 2)

  const x = (i: number) => PAD_L + (i / (n - 1)) * PLOT_W
  const yWind = (v: number) => WIND_TOP + WIND_H - (v / windMax) * WIND_H
  const yWave = (v: number) => WAVE_TOP + WAVE_H - (v / waveMax) * WAVE_H

  const dayMarks = useMemo(() => {
    const marks: { i: number; label: string }[] = []
    for (let i = 1; i < n; i++) {
      const d = new Date(times[i])
      if (d.getHours() === 0) {
        marks.push({ i, label: d.toLocaleDateString(undefined, { weekday: 'short' }) })
      }
    }
    return marks
  }, [times, n])

  function onPointer(e: React.PointerEvent<SVGSVGElement>) {
    if (e.type === 'pointerdown') (e.target as Element).setPointerCapture?.(e.pointerId)
    const rect = svgRef.current!.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    const i = Math.round(((px - PAD_L) / PLOT_W) * (n - 1))
    setScrub(Math.min(n - 1, Math.max(0, i)))
  }

  const t = new Date(times[idx])
  const timeLabel = t.toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })

  return (
    <div className="fc-charts">
      <div className="fc-readout">
        <span className="fc-time numeral">{timeLabel}</span>
        <span className="fc-chip">
          <i style={{ background: COL_WIND }} /> Wind{' '}
          <b className="numeral">{Math.round(wind[idx] ?? 0)}</b> kn
        </span>
        <span className="fc-chip">
          <i style={{ background: COL_GUST }} /> Gust{' '}
          <b className="numeral">{Math.round(gust[idx] ?? 0)}</b>
        </span>
        <span className="fc-chip">
          <i style={{ background: COL_WAVE }} /> Waves{' '}
          <b className="numeral">{wave[idx] != null ? (wave[idx] as number).toFixed(1) : '—'}</b> m
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${TOTAL_H}`}
        style={{ width: '100%', touchAction: 'pan-y' }}
        onPointerDown={onPointer}
        onPointerMove={(e) => e.buttons > 0 && onPointer(e)}
      >
        {/* wind plot */}
        <text x={PAD_L} y={WIND_TOP - 5} className="fc-title">
          WIND · kn
        </text>
        {[0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yWind(windMax * f)}
              y2={yWind(windMax * f)}
              stroke={COL_GRID}
            />
            <text x={PAD_L - 5} y={yWind(windMax * f) + 3} className="fc-tick" textAnchor="end">
              {Math.round(windMax * f)}
            </text>
          </g>
        ))}
        <line x1={PAD_L} x2={W - PAD_R} y1={yWind(0)} y2={yWind(0)} stroke={COL_GRID} />

        {dayMarks.map((m) => (
          <line
            key={m.i}
            x1={x(m.i)}
            x2={x(m.i)}
            y1={WIND_TOP}
            y2={WAVE_TOP + WAVE_H}
            stroke={COL_GRID}
          />
        ))}

        <path d={linePath(gust, x, yWind)} fill="none" stroke={COL_GUST} strokeWidth="1.6" strokeDasharray="4 3" />
        <path d={linePath(wind, x, yWind)} fill="none" stroke={COL_WIND} strokeWidth="2" />

        {/* wave plot */}
        <text x={PAD_L} y={WAVE_TOP - 5} className="fc-title">
          WAVES · m
        </text>
        {[0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yWave(waveMax * f)}
              y2={yWave(waveMax * f)}
              stroke={COL_GRID}
            />
            <text x={PAD_L - 5} y={yWave(waveMax * f) + 3} className="fc-tick" textAnchor="end">
              {(waveMax * f).toFixed(1)}
            </text>
          </g>
        ))}
        <line x1={PAD_L} x2={W - PAD_R} y1={yWave(0)} y2={yWave(0)} stroke={COL_GRID} />
        <path d={areaPath(wave, x, yWave, yWave(0))} fill={COL_WAVE} opacity="0.18" />
        <path d={linePath(wave, x, yWave)} fill="none" stroke={COL_WAVE} strokeWidth="2" />

        {/* x axis day labels */}
        {dayMarks.map((m) => (
          <text key={m.i} x={x(m.i) + 4} y={WAVE_TOP + WAVE_H + 14} className="fc-tick">
            {m.label}
          </text>
        ))}

        {/* now marker */}
        <line
          x1={x(nowIdx - i0)}
          x2={x(nowIdx - i0)}
          y1={WIND_TOP}
          y2={WAVE_TOP + WAVE_H}
          stroke={COL_AXIS}
          strokeDasharray="2 3"
          opacity="0.5"
        />

        {/* crosshair */}
        <line
          x1={x(idx)}
          x2={x(idx)}
          y1={WIND_TOP - 2}
          y2={WAVE_TOP + WAVE_H}
          stroke="rgba(234, 243, 251, 0.65)"
          strokeWidth="1"
        />
        {wind[idx] != null && <circle cx={x(idx)} cy={yWind(wind[idx])} r="3.5" fill={COL_WIND} stroke="#0e1b2a" strokeWidth="1.5" />}
        {gust[idx] != null && <circle cx={x(idx)} cy={yWind(gust[idx])} r="3" fill={COL_GUST} stroke="#0e1b2a" strokeWidth="1.5" />}
        {wave[idx] != null && <circle cx={x(idx)} cy={yWave(wave[idx] as number)} r="3.5" fill={COL_WAVE} stroke="#0e1b2a" strokeWidth="1.5" />}
      </svg>
    </div>
  )
}
