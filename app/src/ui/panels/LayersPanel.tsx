import { Fragment } from 'react'
import { useAppStore } from '../../state/appStore'
import { SPEED_UNITS } from '../../units'

const LAYER_DEFS = [
  { key: 'satellite', name: 'Satellite imagery', desc: 'Esri World Imagery' },
  { key: 'depth', name: 'Depth shading', desc: 'Color-shaded bathymetry (NOAA NCEI)' },
  { key: 'contours', name: 'Depth contours', desc: 'Contour lines with soundings' },
  { key: 'seamarks', name: 'Buoys & lights', desc: 'OpenSeaMap seamarks (needs internet once)' },
  { key: 'weather', name: 'Wind & waves', desc: 'Forecast overlay — pick the hour on the outlook strip' },
] as const

export default function LayersPanel() {
  const layers = useAppStore((s) => s.layers)
  const setLayer = useAppStore((s) => s.setLayer)
  const wxStrip = useAppStore((s) => s.wxStrip)
  const setWxStrip = useAppStore((s) => s.setWxStrip)
  const depthUnit = useAppStore((s) => s.depthUnit)
  const setDepthUnit = useAppStore((s) => s.setDepthUnit)
  const speedUnit = useAppStore((s) => s.speedUnit)
  const setSpeedUnit = useAppStore((s) => s.setSpeedUnit)
  const headingUp = useAppStore((s) => s.headingUp)
  const setHeadingUp = useAppStore((s) => s.setHeadingUp)
  const satOpacity = useAppStore((s) => s.satOpacity)
  const setSatOpacity = useAppStore((s) => s.setSatOpacity)

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
        </Fragment>
      ))}

      <label className="row">
        <div className="row-text">
          <span className="row-title">Outlook strip</span>
          <span className="row-desc">Week & hours at the top of the map — sets the planning time</span>
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

      <div className="row">
        <div className="row-text">
          <span className="row-title">Speed units</span>
          <span className="row-desc">Boat speed & cruise speed in trips</span>
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
