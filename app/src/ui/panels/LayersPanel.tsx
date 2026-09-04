import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useDiscoverStore } from '../../discover/store'
import { useRouteStore } from '../../routing/routeStore'
import { useGpsStore } from '../../tracking/gpsStore'
import {
  FLOW_TUNING_DEFAULTS,
  SEA_SCALE_MAX_M,
  SEA_SCALE_MIN_M,
  useAppStore,
  type FlowTuning,
} from '../../state/appStore'
import { knToUnit, SPEED_UNITS, speedUnitLabel, unitToKn } from '../../units'
import { IconMinus, IconPlus } from '../icons'
import SeaRamp from '../SeaRamp'
import OfflinePanel from './OfflinePanel'
import ReportProblem from './ReportProblem'

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

/** A group of settings folded to one line — its name and what it is set
 *  to now — that opens on touch. The main settings sit above the groups,
 *  open; everything else is a line until it is wanted. */
function Group({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string
  summary: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <>
      <button className="row row-action" onClick={onToggle} aria-expanded={open}>
        <div className="row-text">
          <span className="row-title">
            {title} {open ? '▾' : '▸'}
          </span>
          <span className="row-desc">{summary}</span>
        </div>
      </button>
      {open && <div className="group-body">{children}</div>}
    </>
  )
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const times = (v: number) => `×${v.toFixed(1)}`

const CHART_DEFS = [
  { key: 'satellite', name: 'Satellite imagery', desc: 'Sentinel-2, Aug 2023' },
  { key: 'depth', name: 'Depth shading', desc: 'Color-shaded bathymetry (NOAA NCEI)' },
  { key: 'contours', name: 'Depth contours', desc: 'Contour lines with soundings' },
  { key: 'seamarks', name: 'Buoys & lights', desc: 'OpenSeaMap seamarks' },
] as const

const MOTION_DEFS = [
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

type GroupId = 'chart' | 'motion' | 'weather' | 'units'

/**
 * Settings, in order of importance. The BOAT — cruise speed, the sea-state
 * scale, low power — sits open at the top: these are the settings that
 * describe you, and the ones the first-run path teaches. The rest are
 * groups, folded to a line each, that open on touch.
 */
export default function LayersPanel() {
  const layers = useAppStore((s) => s.layers)
  const setLayer = useAppStore((s) => s.setLayer)
  const wxStrip = useAppStore((s) => s.wxStrip)
  const setWxStrip = useAppStore((s) => s.setWxStrip)
  const wavePeriod = useAppStore((s) => s.wavePeriod)
  const setWavePeriod = useAppStore((s) => s.setWavePeriod)
  const seaScaleM = useAppStore((s) => s.seaScaleM)
  const setSeaScale = useAppStore((s) => s.setSeaScale)
  const depthUnit = useAppStore((s) => s.depthUnit)
  const setDepthUnit = useAppStore((s) => s.setDepthUnit)
  const speedUnit = useAppStore((s) => s.speedUnit)
  const setSpeedUnit = useAppStore((s) => s.setSpeedUnit)
  const windUnit = useAppStore((s) => s.windUnit)
  const setWindUnit = useAppStore((s) => s.setWindUnit)
  const lowPower = useAppStore((s) => s.lowPower)
  const wake = useGpsStore((s) => s.wake)
  const gpsOn = useGpsStore((s) => s.status === 'on')
  const setLowPower = useAppStore((s) => s.setLowPower)
  const recordTrips = useAppStore((s) => s.recordTrips)
  const setRecordTrips = useAppStore((s) => s.setRecordTrips)
  const usageStats = useAppStore((s) => s.usageStats)
  const setUsageStats = useAppStore((s) => s.setUsageStats)
  const satOpacity = useAppStore((s) => s.satOpacity)
  const satVivid = useAppStore((s) => s.satVivid)
  const setSatVivid = useAppStore((s) => s.setSatVivid)
  const setSatOpacity = useAppStore((s) => s.setSatOpacity)
  const windFlowOpacity = useAppStore((s) => s.windFlowOpacity)
  const setWindFlowOpacity = useAppStore((s) => s.setWindFlowOpacity)
  const tune = useAppStore((s) => s.flowTuning)
  const setFlowTuning = useAppStore((s) => s.setFlowTuning)
  const cruiseKn = useRouteStore((s) => s.cruiseKn)
  const setCruiseKn = useRouteStore((s) => s.setCruiseKn)
  const [open, setOpen] = useState<GroupId | null>(null)

  // sent here by a Discover row: its control is unfolded, scrolled into
  // view and lit for a beat, so "it's in Settings" is a place, not a search
  const target = useDiscoverStore((s) => s.target)
  const cruiseRef = useRef<HTMLDivElement>(null)
  const unitsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!target) return
    if (target === 'units') setOpen('units')
    const el = target === 'units' ? unitsRef.current : cruiseRef.current
    // after the group has unfolded
    const raf = requestAnimationFrame(() => el?.scrollIntoView({ block: 'start' }))
    const t = window.setTimeout(() => useDiscoverStore.getState().setTarget(null), 1800)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(t)
    }
  }, [target])
  // folded by default: the shipped look is the tuned look, and thirteen
  // sliders between the switches and the units buried both
  const [showTuning, setShowTuning] = useState(false)

  const toggle = (g: GroupId) => () => setOpen((cur) => (cur === g ? null : g))
  const set = (k: keyof FlowTuning) => (v: number) => setFlowTuning({ [k]: v })
  const tuned = (Object.keys(FLOW_TUNING_DEFAULTS) as (keyof FlowTuning)[]).some(
    (k) => tune[k] !== FLOW_TUNING_DEFAULTS[k],
  )
  const cruiseShown = Math.round(knToUnit(speedUnit, cruiseKn))
  const stepCruise = (d: number) => setCruiseKn(unitToKn(speedUnit, cruiseShown + d))

  const onNames = (defs: readonly { key: keyof typeof layers; name: string }[]) =>
    defs.filter((d) => layers[d.key]).map((d) => d.name)
  const chartSummary = onNames(CHART_DEFS).join(' · ') || 'Nothing shown'
  const motionSummary = [...onNames(MOTION_DEFS), tuned ? 'custom' : null].filter(Boolean).join(' · ') || 'Still'
  const weatherSummary = [layers.weather ? 'Wind & waves' : null, wxStrip ? 'Outlook strip' : null, wavePeriod ? 'Period' : null]
    .filter(Boolean)
    .join(' · ')
  const unitsSummary = `${depthUnit} · ${speedUnitLabel(speedUnit)} boat · ${speedUnitLabel(windUnit)} wind`

  return (
    <div className="panel">
      <div className="panel-section">Boat</div>

      <div className={`row${target === 'cruise' ? ' dv-target' : ''}`} ref={cruiseRef}>
        <div className="row-text">
          <span className="row-title">Cruise speed</span>
          <span className="row-desc">What the run and the ride home are timed at</span>
        </div>
        <span className="speed-step">
          <button className="nudge" onClick={() => stepCruise(-1)} aria-label="Slower">
            <IconMinus size={11} />
          </button>
          <b className="numeral">
            {cruiseShown} {speedUnitLabel(speedUnit)}
          </b>
          <button className="nudge" onClick={() => stepCruise(1)} aria-label="Faster">
            <IconPlus size={11} />
          </button>
        </span>
      </div>

      {/* where the sea-state ramp's bands fall — anchored on the height at
          which Rough begins; the preview underneath is the real ramp with
          the bounds this setting gives it, so the slider is read, not guessed */}
      <div className="row layer-opacity sea-scale-row">
        <div className="row-text">
          <span className="row-title">Sea-state scale</span>
          <span className="row-desc">
            Rough from · <b className="numeral">{seaScaleM.toFixed(1)} m</b>
          </span>
        </div>
        <input
          type="range"
          min={SEA_SCALE_MIN_M}
          max={SEA_SCALE_MAX_M}
          step={0.1}
          value={seaScaleM}
          aria-label="Sea-state scale: the wave height at which Rough begins"
          onChange={(e) => setSeaScale(Number(e.target.value))}
        />
      </div>
      <div className="sea-scale-preview">
        <SeaRamp roughM={seaScaleM} />
      </div>

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

      {/* the screen: iOS suspends the app the moment it locks, and then the
          trip is not being tracked or shared. Said plainly, with the fix. */}
      <div className="row">
        <div className="row-text">
          <span className="row-title">Screen stays on</span>
          <span className="row-desc">
            {wake === 'on'
              ? 'while the chart is up'
              : wake === 'refused'
                ? 'refused by the phone — Low Power Mode? Or set Auto-Lock to Never for the trip'
                : wake === 'unsupported'
                  ? 'not on this iOS — set Auto-Lock to Never for the trip (Settings › Display)'
                  : gpsOn
                    ? 'not held right now — the lock screen would pause the trip'
                    : 'once location is on'}
          </span>
        </div>
        <span className={`wake-dot ${wake}`} aria-hidden="true" />
      </div>

      <div className="panel-section">Log</div>
      <label className="row">
        <div className="row-text">
          <span className="row-title">Record trips</span>
          <span className="row-desc">every trip, cast-off to home · GPX from the log</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={recordTrips}
          onChange={(e) => setRecordTrips(e.target.checked)}
        />
      </label>

      {/* the chart download: a once-a-season chore, so it lives with the
          knobs rather than on the dock */}
      <div className="panel-section">Charts offline</div>
      <OfflinePanel />

      <div className="panel-section">More</div>

      <Group title="Chart" summary={chartSummary} open={open === 'chart'} onToggle={toggle('chart')}>
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
      </Group>

      <Group title="Motion" summary={motionSummary} open={open === 'motion'} onToggle={toggle('motion')}>
        {MOTION_DEFS.map((l) => (
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
      </Group>

      <Group title="Weather" summary={weatherSummary || 'Off'} open={open === 'weather'} onToggle={toggle('weather')}>
        <label className="row">
          <div className="row-text">
            <span className="row-title">Wind & waves</span>
            <span className="row-desc">Forecast overlay</span>
          </div>
          <input
            type="checkbox"
            className="switch"
            checked={layers.weather}
            onChange={(e) => setLayer('weather', e.target.checked)}
          />
        </label>
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
      </Group>

      <div ref={unitsRef} className={target === 'units' ? 'dv-target' : ''}>
      <Group title="Units" summary={unitsSummary} open={open === 'units'} onToggle={toggle('units')}>
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
      </Group>

      {/* last, and outside the groups: a promise is not a setting to hunt for */}
      <label className="row">
        <div className="row-text">
          <span className="row-title">Usage stats</span>
          <span className="row-desc">
            Counts what gets used and how fast, under a random id — never your position
          </span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={usageStats}
          onChange={(e) => setUsageStats(e.target.checked)}
        />
      </label>

      {/* the very last thing: the way to say something went wrong */}
      <ReportProblem />
      </div>
    </div>
  )
}
