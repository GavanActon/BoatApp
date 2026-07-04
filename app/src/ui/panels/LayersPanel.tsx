import { useAppStore } from '../../state/appStore'

const LAYER_DEFS = [
  { key: 'depth', name: 'Depth shading', desc: 'Color-shaded bathymetry (NOAA NCEI)' },
  { key: 'contours', name: 'Depth contours', desc: 'Contour lines with soundings' },
  { key: 'seamarks', name: 'Buoys & lights', desc: 'OpenSeaMap seamarks (needs internet once)' },
  { key: 'weather', name: 'Wind & waves', desc: 'Forecast overlay — set the time in Weather' },
] as const

export default function LayersPanel() {
  const layers = useAppStore((s) => s.layers)
  const setLayer = useAppStore((s) => s.setLayer)
  const depthUnit = useAppStore((s) => s.depthUnit)
  const setDepthUnit = useAppStore((s) => s.setDepthUnit)
  const headingUp = useAppStore((s) => s.headingUp)
  const setHeadingUp = useAppStore((s) => s.setHeadingUp)

  return (
    <div className="panel">
      {LAYER_DEFS.map((l) => (
        <label key={l.key} className="row">
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
      ))}

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
