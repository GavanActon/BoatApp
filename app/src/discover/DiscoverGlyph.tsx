import { useEffect, useState } from 'react'
import { useAppStore } from '../state/appStore'
import { usePlacesStore } from '../state/placesStore'
import { useGpsStore } from '../tracking/gpsStore'
import { RoseRing } from './icons'
import { ACHIEVEMENTS } from './registry'
import { chapters, levelName, nextChunk } from './setup'
import { useDiscoverStore } from './store'

const GLOW_MS = 1400

/**
 * The glyph on the top bar: the whole notification system. A ring in as
 * many segments as the current chapter has rows, lit as they are done —
 * 1/4 at a glance — around a four-point rose that wears the colour of the
 * level reached — and from level 1 the rose gives way to the level's own
 * numeral in that colour, one mark rather than a badge on a mark. Every
 * chapter done, the ring fills with achievements. It is there from the first launch —
 * Discover is where setup lives, so the way back to it is always on
 * screen. A level reached glows here for a beat (the sheet closes so it
 * can be seen). A warning dot means the app can't do its job yet: no
 * location and no home dock is a chart with nowhere to stand. A tap
 * opens the Discover sheet. Beside it, after Later on the welcome card, a
 * chip counts what is left — the same arm-and-answer grammar as the home
 * pick's banner.
 */
export default function DiscoverGlyph() {
  const onboarded = useAppStore((s) => s.onboarded)
  const setSheetTab = useAppStore((s) => s.setSheetTab)
  const earnedN = useDiscoverStore((s) => Object.keys(s.earned).length)
  const level = useDiscoverStore((s) => s.level)
  const { left, warn, segs } = useProgress()
  const glowing = useGlow()
  if (!onboarded) return null
  const frac = earnedN / ACHIEVEMENTS.length
  const label =
    `Discover · ${levelName(level)}` +
    (warn ? ' — allow location and star your home dock' : left > 0 ? ` — ${left} set-up ${left === 1 ? 'step' : 'steps'} left` : '')
  return (
    <>
      <button
        className={`dv-glyph${warn ? ' dv-glyph-warn' : ''}${glowing ? ' dv-glyph-glow' : ''}`}
        onClick={() => setSheetTab('discover')}
        aria-label={label}
      >
        <RoseRing frac={frac} full={frac >= 1} level={level} segs={segs} numeral />
      </button>
      <NudgeChip left={left} />
    </>
  )
}

/** First voyage's undone rows, whether the two the app can't run without —
 *  a location, a home dock — are among them, and the current chapter's
 *  count for the ring. Subscribes to each input so the mark and the ring
 *  move the moment a row is done, wherever it was done. */
function useProgress(): { left: number; warn: boolean; segs?: { n: number; done: number } } {
  useAppStore((s) => s.gpsWanted)
  useAppStore((s) => s.numbersSeen)
  useAppStore((s) => s.firstRouteDone)
  useAppStore((s) => s.waveLimitM)
  useAppStore((s) => s.offlineReady)
  usePlacesStore((s) => s.homeName)
  usePlacesStore((s) => s.saved)
  usePlacesStore((s) => s.notes)
  useGpsStore((s) => s.status)
  useDiscoverStore((s) => s.touched)
  const ch = chapters()
  const first = ch[0]
  const undone = first ? first.rows.filter((r) => !r.done) : []
  const next = nextChunk(ch)
  return {
    left: undone.length,
    warn: undone.some((r) => r.id === 'location' || r.id === 'home'),
    segs: next ? { n: next.rows.length, done: next.rows.filter((r) => r.done).length } : undefined,
  }
}

/** True for a beat after a level is reached. */
function useGlow(): boolean {
  const glow = useDiscoverStore((s) => s.glow)
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!glow) return
    setOn(true)
    const t = window.setTimeout(() => setOn(false), GLOW_MS)
    return () => window.clearTimeout(t)
  }, [glow])
  return on
}

function NudgeChip({ left }: { left: number }) {
  const nudge = useDiscoverStore((s) => s.nudge)
  const setSheetTab = useAppStore((s) => s.setSheetTab)
  if (!nudge || left === 0) return null
  return (
    <button
      className="chip chip-accent dv-guide"
      onClick={() => setSheetTab('discover')}
    >
      Set up · {left} left
    </button>
  )
}
