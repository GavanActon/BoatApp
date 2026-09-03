import { useAppStore } from '../state/appStore'
import { usePlacesStore } from '../state/placesStore'
import { RoseRing } from './icons'
import { ACHIEVEMENTS } from './registry'
import { useDiscoverStore } from './store'

/**
 * The glyph on the top bar: the whole notification system. A ring that
 * fills as achievements are earned, around a four-point rose. It appears
 * once the first-voyage card has retired (§10.2 keeps that card's slot),
 * and a tap opens the Discover sheet.
 */
export default function DiscoverGlyph() {
  const onboarded = useAppStore((s) => s.onboarded)
  const setupDone = useAppStore((s) => s.setupDone)
  const firstRouteDone = useAppStore((s) => s.firstRouteDone)
  const numbersSeen = useAppStore((s) => s.numbersSeen)
  const homeName = usePlacesStore((s) => s.homeName)
  const setSheetTab = useAppStore((s) => s.setSheetTab)
  const hidden = useDiscoverStore((s) => s.glyphHidden)
  const earnedN = useDiscoverStore((s) => Object.keys(s.earned).length)
  // the card retires on setupDone, which waits to SEE all four rows done at
  // once — and the route row hands the dock to the trip card before it can
  // look. The three persisted facts are the same milestone without the wait.
  const cardDone = setupDone || (firstRouteDone && numbersSeen && homeName != null)
  if (!onboarded || !cardDone || hidden) return null
  const frac = earnedN / ACHIEVEMENTS.length
  return (
    <button className="dv-glyph" onClick={() => setSheetTab('discover')} aria-label="Discover">
      <RoseRing frac={frac} full={frac >= 1} />
    </button>
  )
}
