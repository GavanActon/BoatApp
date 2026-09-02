import { SEA_BANDS, seaBounds } from '../weather/seaState'

/** The bound between two bands, said short: 0.07 · 0.5 · 1 · 1.4 */
function tick(v: number): string {
  return String(Math.round(v * 100) / 100)
}

/**
 * The sea-state ramp as a bar, with the height each band begins at written
 * under its edge. The swatches are the REAL seaState.ts colours and the
 * bounds come from the same seaBounds() the paint uses, so wherever this is
 * drawn — the numbers guide, the preview under the Settings slider — it
 * cannot drift from the water it describes.
 */
export default function SeaRamp({ roughM }: { roughM: number }) {
  const bounds = seaBounds(roughM)
  return (
    <div className="sea-ramp" aria-hidden>
      <div className="sea-ramp-bar">
        {SEA_BANDS.map((b) => (
          <i key={b.name} style={{ background: b.color }} title={b.name} />
        ))}
      </div>
      <div className="sea-ramp-ticks numeral">
        {bounds.slice(0, -1).map((v, i) => (
          <span key={i} style={{ left: `${((i + 1) / SEA_BANDS.length) * 100}%` }}>
            {tick(v)}
          </span>
        ))}
      </div>
    </div>
  )
}
