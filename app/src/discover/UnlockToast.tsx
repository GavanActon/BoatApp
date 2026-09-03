import { useEffect, useState } from 'react'
import { useAppStore } from '../state/appStore'
import { AchGlyph } from './icons'
import { ACH_BY_ID } from './registry'
import { useDiscoverStore } from './store'

const SHOW_MS = 3800

/**
 * The unlock moment: the tile pops in mid-screen, rings twice, and goes.
 * A tap opens the sheet on it. Never while the welcome is up, never a
 * sentence — the name and the word Earned.
 */
export default function UnlockToast() {
  const id = useDiscoverStore((s) => s.queue[0])
  const shiftQueue = useDiscoverStore((s) => s.shiftQueue)
  const onboarded = useAppStore((s) => s.onboarded)
  const [out, setOut] = useState(false)

  useEffect(() => {
    if (!id || !onboarded) return
    setOut(false)
    const t1 = window.setTimeout(() => setOut(true), SHOW_MS)
    const t2 = window.setTimeout(() => shiftQueue(), SHOW_MS + 320)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [id, onboarded, shiftQueue])

  const def = id ? ACH_BY_ID.get(id) : undefined
  if (!def || !onboarded) return null
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
