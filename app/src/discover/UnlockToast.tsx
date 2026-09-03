import { useEffect, useState } from 'react'
import { useAppStore } from '../state/appStore'
import { SEA_BANDS } from '../weather/seaState'
import { dismissSeaFelt, setSeaFelt } from './engine'
import { AchGlyph, RoseRing } from './icons'
import { ACH_BY_ID } from './registry'
import { levelName } from './setup'
import { useDiscoverStore } from './store'

const SHOW_MS = 3200

/**
 * The moments over the chart: an unlock or a level-up (a small glass pill
 * drops in under the strip, the tile rings, sparks fly, a shine sweeps the
 * glass, and it goes; a tap opens the sheet), and the sea-felt question
 * asked once more when a trip ended before it was answered. Never while
 * the welcome is up, never a sentence.
 */
export default function UnlockToast() {
  const onboarded = useAppStore((s) => s.onboarded)
  if (!onboarded) return null
  return (
    <>
      <Moment />
      <FeltAsk />
    </>
  )
}

const SPARKS = [0, 45, 90, 135, 180, 225, 270, 315]

function Moment() {
  const id = useDiscoverStore((s) => s.queue[0])
  const shiftQueue = useDiscoverStore((s) => s.shiftQueue)
  const [out, setOut] = useState(false)

  useEffect(() => {
    if (!id) return
    setOut(false)
    // a nudge in the hand on phones that allow it (iOS PWAs ignore this)
    try {
      navigator.vibrate?.([12, 40, 18])
    } catch {
      /* no haptics here */
    }
    const t1 = window.setTimeout(() => setOut(true), SHOW_MS)
    const t2 = window.setTimeout(() => shiftQueue(), SHOW_MS + 280)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [id, shiftQueue])

  if (!id) return null
  const level = id.startsWith('level:') ? Number(id.slice(6)) : null
  const def = level == null ? ACH_BY_ID.get(id) : undefined
  if (level == null && !def) return null
  const label = level != null ? `Level ${level}` : 'Earned'
  const name = level != null ? levelName(level) : def!.name
  return (
    <button
      className={`dv-moment glass${out ? ' out' : ''}${level != null ? ' dv-moment-level' : ''}`}
      onClick={() => {
        shiftQueue()
        useAppStore.getState().setSheetTab('discover')
      }}
      aria-label={`${label}: ${name}`}
    >
      <span className="dv-moment-tile">
        {level != null ? <RoseRing frac={1} size={30} level={level} /> : <AchGlyph icon={def!.icon} size={22} />}
        {SPARKS.map((deg) => (
          <i key={deg} className="dv-spark" style={{ transform: `rotate(${deg}deg)` }} />
        ))}
      </span>
      <span className="dv-moment-text">
        <span className="dv-moment-k">{label}</span>
        <span className="dv-moment-name">{name}</span>
      </span>
      <i className="dv-shine" aria-hidden />
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
