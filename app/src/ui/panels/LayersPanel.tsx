import { Fragment } from 'react'
import { getMap } from '../../map/mapController'
import { useAppStore } from '../../state/appStore'
import { SPEED_UNITS } from '../../units'
import { playBriefing } from '../../weather/windFlow'
import { IconWind } from '../icons'

const LAYER_DEFS = [
  { key: 'satellite', name: 'Satellite imagery', desc: 'Sentinel-2, Aug 2023' },
  { key: 'depth', name: 'Depth shading', desc: 'Color-shaded bathymetry (NOAA NCEI)' },
  { key: 'contours', name: 'Depth contours', desc: 'Contour lines with soundings' },
  { key: 'seamarks', name: 'Buoys & lights', desc: 'OpenSeaMap seamarks' },
  { key: 'weather', name: 'Wind & waves', desc: 'Forecast overlay' },
  {
    key: 'windFlow',
    name: 'Wind flow',
    // the one sanctioned piece of standing motion on the chart — it exists
    // because it was switched on, and its strength is the user's to set
    desc: 'Live wind streaming over the water',
  },
  {
    key: 'rake',
    name: 'Wave rake',
    // adds to the coloured lanes rather than replacing them: they carry how
    // big, this carries which way
    desc: 'Sea direction along the run',
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
  const setSheetTab = useAppStore((s) => s.setSheetTab)

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
            <div className="row layer-opacity">
              <div className="row-text">
                <span className="row-desc">Strength · {Math.round(windFlowOpacity * 100)}%</span>
              </div>
              <input
                type="range"
                min={10}
                max={100}
                step={5}
                value={Math.round(windFlowOpacity * 100)}
                onChange={(e) => setWindFlowOpacity(Number(e.target.value) / 100)}
              />
            </div>
          )}
        </Fragment>
      ))}

      <button
        className="row row-action"
        onClick={() => {
          // the performance needs the chart, so the sheet steps aside first
          setSheetTab(null)
          const map = getMap()
          if (map) void playBriefing(map)
        }}
      >
        <div className="row-text">
          <span className="row-title">Play briefing</span>
          <span className="row-desc">Ten seconds of wind and sea over your run, then quiet</span>
        </div>
        <IconWind size={20} />
      </button>

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
