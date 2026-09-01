import { Fragment, useState } from 'react'
import { FLOW_TUNING_DEFAULTS, useAppStore, type FlowTuning } from '../../state/appStore'
import { SPEED_UNITS } from '../../units'

/** One tuning slider row — the motion layers are dialled in on the water,
 *  not in code, so every parameter that shapes the look gets one of these. */
function Tune({
  label,
  value,
  min,
  max,
  step,
  fmt,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  fmt: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <div className="row layer-opacity">
      <div className="row-text">
        <span className="row-desc">
          {label} · {fmt(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const times = (v: number) => `×${v.toFixed(1)}`

// The panel reads in the order a day on the water asks its questions: the
// modes you grab for first, then what the chart shows, then the weather on
// it, then how numbers are spoken. The motion-tuning sliders — dialled in on
// the water once, defaults now baked — live folded at the bottom.
const CHART_DEFS = [
  { key: 'satellite', name: 'Satellite imagery', desc: 'Sentinel-2, Aug 2023' },
  { key: 'depth', name: 'Depth shading', desc: 'Color-shaded bathymetry (NOAA NCEI)' },
  { key: 'contours', name: 'Depth contours', desc: 'Contour lines with soundings' },
  { key: 'seamarks', name: 'Buoys & lights', desc: 'OpenSeaMap seamarks' },
] as const

const WEATHER_DEFS = [
  { key: 'weather', name: 'Wind & waves', desc: 'Forecast overlay' },
  {
    key: 'windFlow',
    name: 'Wind flow',
    // standing motion exists because it was switched on — coloured air over
    // white water; the full look lives under "Fine-tune the motion"
    desc: 'Live wind streaming over the water',
  },
  {
    key: 'seaFlow',
    name: 'Sea flow',
    desc: 'Swell fronts marching on the water',
  },
] as const

export default function LayersPanel() {
  const layers = useAppStore((s) => s.layers)
  const setLayer = useAppStore((s) => s.setLayer)
  const wxStrip = useAppStore((s) => s.wxStrip)
  const setWxStrip = useAppStore((s) => s.setWxStrip)
  const wavePeriod = useAppStore((s) => s.wavePeriod)
  const setWavePeriod = useAppStore((s) => s.setWavePeriod)
  const depthUnit = useAppStore((s) => s.depthUnit)
  const setDepthUnit = useAppStore((s) => s.setDepthUnit)
  const speedUnit = useAppStore((s) => s.speedUnit)
  const setSpeedUnit = useAppStore((s) => s.setSpeedUnit)
  const windUnit = useAppStore((s) => s.windUnit)
  const setWindUnit = useAppStore((s) => s.setWindUnit)
  const lowPower = useAppStore((s) => s.lowPower)
  const setLowPower = useAppStore((s) => s.setLowPower)
  const satOpacity = useAppStore((s) => s.satOpacity)
  const satVivid = useAppStore((s) => s.satVivid)
  const setSatVivid = useAppStore((s) => s.setSatVivid)
  const setSatOpacity = useAppStore((s) => s.setSatOpacity)
  const windFlowOpacity = useAppStore((s) => s.windFlowOpacity)
  const setWindFlowOpacity = useAppStore((s) => s.setWindFlowOpacity)
  const tune = useAppStore((s) => s.flowTuning)
  const setFlowTuning = useAppStore((s) => s.setFlowTuning)
  // folded by default: the shipped look is the tuned look, and thirteen
  // sliders between the switches and the units buried both
  const [showTuning, setShowTuning] = useState(false)

  const set = (k: keyof FlowTuning) => (v: number) => setFlowTuning({ [k]: v })
  const tuned = (Object.keys(FLOW_TUNING_DEFAULTS) as (keyof FlowTuning)[]).some(
    (k) => tune[k] !== FLOW_TUNING_DEFAULTS[k],
  )

  return (
    <div className="panel">
      <div className="panel-section">On the water</div>

      <label className="row">
        <div className="row-text">
          <span className="row-title">Low power</span>
          <span className="row-desc">Stills the motion — wave heights read as numbers</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={lowPower}
          onChange={(e) => setLowPower(e.target.checked)}
        />
      </label>

      <div className="panel-section">Chart</div>

      {CHART_DEFS.map((l) => (
        <Fragment key={l.key}>
          <label className="row">
            <div className="row-text">
              <span className="row-title">{l.name}</span>
              <span className="row-desc">{l.desc}</span>
            </div>
            <input
              type="checkbox"
              className="switch"
              checked={layers[l.key]}
              onChange={(e) => setLayer(l.key, e.target.checked)}
            />
          </label>
          {l.key === 'satellite' && layers.satellite && (
            <>
              <div className="row layer-opacity">
                <div className="row-text">
                  <span className="row-desc">Opacity · {Math.round(satOpacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={5}
                  value={Math.round(satOpacity * 100)}
                  onChange={(e) => setSatOpacity(Number(e.target.value) / 100)}
                />
              </div>
              <label className="row layer-opacity">
                <div className="row-text">
                  <span className="row-desc">Vivid — true colour for reading beaches</span>
                </div>
                <input
                  type="checkbox"
                  className="switch"
                  checked={satVivid}
                  onChange={(e) => setSatVivid(e.target.checked)}
                />
              </label>
            </>
          )}
        </Fragment>
      ))}

      <div className="panel-section">Weather</div>

      {WEATHER_DEFS.map((l) => (
        <Fragment key={l.key}>
          <label className="row">
            <div className="row-text">
              <span className="row-title">{l.name}</span>
              <span className="row-desc">{l.desc}</span>
            </div>
            <input
              type="checkbox"
              className="switch"
              checked={layers[l.key]}
              onChange={(e) => setLayer(l.key, e.target.checked)}
            />
          </label>
          {l.key === 'windFlow' && layers.windFlow && (
            <Tune
              label="Strength"
              value={windFlowOpacity}
              min={0.1}
              max={1}
              step={0.05}
              fmt={pct}
              onChange={setWindFlowOpacity}
            />
          )}
          {l.key === 'seaFlow' && layers.seaFlow && (
            <Tune
              label="Strength"
              value={tune.seaOpacity}
              min={0.1}
              max={1}
              step={0.05}
              fmt={pct}
              onChange={set('seaOpacity')}
            />
          )}
        </Fragment>
      ))}

      <label className="row">
        <div className="row-text">
          <span className="row-title">Outlook strip</span>
          <span className="row-desc">Week & hours</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={wxStrip}
          onChange={(e) => setWxStrip(e.target.checked)}
        />
      </label>

      <label className="row">
        <div className="row-text">
          <span className="row-title">Wave period</span>
          <span className="row-desc">Seconds beside every height</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={wavePeriod}
          onChange={(e) => setWavePeriod(e.target.checked)}
        />
      </label>

      <div className="panel-section">Units</div>

      <div className="row">
        <div className="row-text">
          <span className="row-title">Depth units</span>
        </div>
        <div className="seg">
          {(['ft', 'm'] as const).map((u) => (
            <button
              key={u}
              className={depthUnit === u ? 'seg-on' : ''}
              onClick={() => setDepthUnit(u)}
            >
              {u}
            </button>
          ))}
        </div>
      </div>

      <div className="row">
        <div className="row-text">
          <span className="row-title">Speed & distance units</span>
          <span className="row-desc">Boat</span>
        </div>
        <div className="seg">
          {SPEED_UNITS.map((u) => (
            <button
              key={u.id}
              className={speedUnit === u.id ? 'seg-on' : ''}
              onClick={() => setSpeedUnit(u.id)}
            >
              {u.label}
            </button>
          ))}
        </div>
      </div>

      <div className="row">
        <div className="row-text">
          <span className="row-title">Wind units</span>
          <span className="row-desc">Forecast</span>
        </div>
        <div className="seg">
          {SPEED_UNITS.map((u) => (
            <button
              key={u.id}
              className={windUnit === u.id ? 'seg-on' : ''}
              onClick={() => setWindUnit(u.id)}
            >
              {u.label}
            </button>
          ))}
        </div>
      </div>

      <button className="row row-action" onClick={() => setShowTuning((v) => !v)}>
        <div className="row-text">
          <span className="row-title">Fine-tune the motion {showTuning ? '▾' : '▸'}</span>
          <span className="row-desc">
            {tuned ? 'Custom — tap to adjust' : 'The shipped wind & sea look'}
          </span>
        </div>
      </button>

      {showTuning && (
        <>
          <div className="panel-section">Wind flow</div>
          <Tune
            label="Particles"
            value={tune.windDensity}
            min={200}
            max={2500}
            step={100}
            fmt={(v) => `${v}`}
            onChange={set('windDensity')}
          />
          <Tune
            label="Speed"
            value={tune.windSpeed}
            min={0.3}
            max={3}
            step={0.1}
            fmt={times}
            onChange={set('windSpeed')}
          />
          <Tune
            label="Trail"
            value={tune.windTrail}
            min={0.86}
            max={0.97}
            step={0.005}
            fmt={(v) => `${Math.round(((v - 0.86) / 0.11) * 100)}%`}
            onChange={set('windTrail')}
          />
          <div className="panel-section">Sea flow</div>
          <Tune
            label="Crest spacing"
            value={tune.seaSpacing}
            min={24}
            max={72}
            step={2}
            fmt={(v) => `${v} px`}
            onChange={set('seaSpacing')}
          />
          <Tune
            label="Crest length"
            value={tune.seaLength}
            min={0.5}
            max={2}
            step={0.1}
            fmt={times}
            onChange={set('seaLength')}
          />
          <Tune
            label="Speed"
            value={tune.seaSpeed}
            min={1}
            max={8}
            step={0.5}
            // ×1 is the sea's TRUE phase speed at chart scale — honest, glacial
            fmt={times}
            onChange={set('seaSpeed')}
          />
          <Tune
            label="Crest curve"
            value={tune.seaCurve}
            min={0}
            max={3}
            step={0.1}
            fmt={times}
            onChange={set('seaCurve')}
          />
          {tuned && (
            <button className="row row-action" onClick={() => setFlowTuning(FLOW_TUNING_DEFAULTS)}>
              <div className="row-text">
                <span className="row-title">Reset motion tuning</span>
                <span className="row-desc">Back to the shipped wind & sea look</span>
              </div>
            </button>
          )}
        </>
      )}
    </div>
  )
}
