import { Fragment } from 'react'
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

const LAYER_DEFS = [
  { key: 'satellite', name: 'Satellite imagery', desc: 'Sentinel-2, Aug 2023' },
  { key: 'depth', name: 'Depth shading', desc: 'Color-shaded bathymetry (NOAA NCEI)' },
  { key: 'contours', name: 'Depth contours', desc: 'Contour lines with soundings' },
  { key: 'seamarks', name: 'Buoys & lights', desc: 'OpenSeaMap seamarks' },
  { key: 'weather', name: 'Wind & waves', desc: 'Forecast overlay' },
  {
    key: 'windFlow',
    name: 'Wind flow',
    // standing motion exists because it was switched on, and every knob of
    // its look is the user's to set — coloured air over white water
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
  const headingUp = useAppStore((s) => s.headingUp)
  const setHeadingUp = useAppStore((s) => s.setHeadingUp)
  const satOpacity = useAppStore((s) => s.satOpacity)
  const setSatOpacity = useAppStore((s) => s.setSatOpacity)
  const windFlowOpacity = useAppStore((s) => s.windFlowOpacity)
  const setWindFlowOpacity = useAppStore((s) => s.setWindFlowOpacity)
  const tune = useAppStore((s) => s.flowTuning)
  const setFlowTuning = useAppStore((s) => s.setFlowTuning)

  const set = (k: keyof FlowTuning) => (v: number) => setFlowTuning({ [k]: v })
  const tuned = (Object.keys(FLOW_TUNING_DEFAULTS) as (keyof FlowTuning)[]).some(
    (k) => tune[k] !== FLOW_TUNING_DEFAULTS[k],
  )

  return (
    <div className="panel">
      {LAYER_DEFS.map((l) => (
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
          )}
          {l.key === 'windFlow' && layers.windFlow && (
            <>
              <Tune
                label="Strength"
                value={windFlowOpacity}
                min={0.1}
                max={1}
                step={0.05}
                fmt={pct}
                onChange={setWindFlowOpacity}
              />
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
              <Tune
                label="Hue"
                value={tune.windHue}
                min={0}
                max={360}
                step={5}
                fmt={(v) => `${v}°`}
                onChange={set('windHue')}
              />
              <Tune
                label="Colour"
                value={tune.windSat}
                min={0}
                max={100}
                step={5}
                fmt={(v) => `${v}%`}
                onChange={set('windSat')}
              />
            </>
          )}
          {l.key === 'seaFlow' && layers.seaFlow && (
            <>
              <Tune
                label="Strength"
                value={tune.seaOpacity}
                min={0.1}
                max={1}
                step={0.05}
                fmt={pct}
                onChange={set('seaOpacity')}
              />
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
              <Tune
                label="Hue"
                value={tune.seaHue}
                min={0}
                max={360}
                step={5}
                fmt={(v) => `${v}°`}
                onChange={set('seaHue')}
              />
              <Tune
                label="Colour"
                value={tune.seaSat}
                min={0}
                max={100}
                step={5}
                fmt={(v) => `${v}%`}
                onChange={set('seaSat')}
              />
            </>
          )}
        </Fragment>
      ))}

      {tuned && (
        <button className="row row-action" onClick={() => setFlowTuning(FLOW_TUNING_DEFAULTS)}>
          <div className="row-text">
            <span className="row-title">Reset motion tuning</span>
            <span className="row-desc">Back to the shipped wind & sea look</span>
          </div>
        </button>
      )}

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

      <div className="panel-section">Preferences</div>

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

      <label className="row">
        <div className="row-text">
          <span className="row-title">Heading-up when following</span>
          <span className="row-desc">Map rotates to your course over ground</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={headingUp}
          onChange={(e) => setHeadingUp(e.target.checked)}
        />
      </label>

    </div>
  )
}
