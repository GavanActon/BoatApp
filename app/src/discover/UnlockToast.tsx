import { useEffect, useState } from 'react'
import { useAppStore } from '../state/appStore'
import { SEA_BANDS } from '../weather/seaState'
import { dismissSeaFelt, setSeaFelt } from './engine'
import { AchGlyph } from './icons'
import { ACH_BY_ID } from './registry'
import { useDiscoverStore } from './store'

const SHOW_MS = 3800

/**
 * The moments over the chart: an unlock (the tile pops in, rings twice,
 * and goes; a tap opens the sheet on it), and the sea-felt question asked
 * once more when a trip ended before it was answered. Never while the
 * welcome is up, never a sentence.
 */
export default function UnlockToast() {
  const onboarded = useAppStore((s) => s.onboarded)
  if (!onboarded) return null
  return (
    <>
      <Unlock />
      <FeltAsk />
    </>
  )
}

function Unlock() {
  const id = useDiscoverStore((s) => s.queue[0])
  const shiftQueue = useDiscoverStore((s) => s.shiftQueue)
  const [out, setOut] = useState(false)

  useEffect(() => {
    if (!id) return
    setOut(false)
    const t1 = window.setTimeout(() => setOut(true), SHOW_MS)
    const t2 = window.setTimeout(() => shiftQueue(), SHOW_MS + 320)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [id, shiftQueue])

  const def = id ? ACH_BY_ID.get(id) : undefined
  if (!def) return null
  return (
    <button
      className={`dv-toast glass${out ? ' out' : ''}`}
      onClick={() => {
        shiftQueue()
        useAppStore.getState().setSheetTab('discover')
      }}
      aria-label={`Earned: ${def.name}`}
    >
      <span className="dv-toast-tile">
        <AchGlyph icon={def.icon} size={32} />
      </span>
      <span className="dv-toast-k">Earned</span>
      <span className="dv-toast-name">{def.name}</span>
    </button>
  )
}

/** The trip ended at the ramp before the ramp was tapped: ask once, here. */
function FeltAsk() {
  const pf = useDiscoverStore((s) => s.pendingFelt)
  const underWay = useDiscoverStore((s) => s.trip != null)
  if (!pf || underWay) return null
  return (
    <div className="dv-toast dv-felt-ask glass" role="group" aria-label="Sea felt">
      <span className="dv-toast-k">Sea felt · {pf.destName ?? 'the run'}</span>
      <div className="dv-felt-bar">
        {SEA_BANDS.map((b, i) => (
          <button key={b.name} style={{ background: b.color }} aria-label={b.name} onClick={() => setSeaFelt(i)} />
        ))}
      </div>
      <button className="dv-hide" onClick={dismissSeaFelt}>
        skip
      </button>
    </div>
  )
}
