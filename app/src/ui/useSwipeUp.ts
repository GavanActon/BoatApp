import { useRef, type TouchEvent } from 'react'

/**
 * Swipe up on the docked card to raise it to its taller detent, and — when a
 * handler is given — swipe down to lower it again. One gesture, so there is
 * exactly one thing to know about getting more — rather than a Details button
 * hiding somewhere different on each card.
 *
 * Two things keep it from misfiring. A gesture only counts if it travels far
 * enough and stays roughly vertical, so a tap on a button inside the card is
 * still a tap and a horizontal drag through a chip row is still a scroll. And
 * it is deliberately NOT the only way in: the grab handle above it is a real
 * button, because a swipe is invisible to a keyboard and to VoiceOver.
 *
 * The downward gesture has one extra guard: the raised card scrolls inside,
 * and a drag down through content that has itself scrolled is the scroll
 * coming back to its top, not a request to lower the card. So a swipe down
 * only counts when nothing between the finger and the card is scrolled.
 *
 * The bottom strip of the screen belongs to the system's own home-indicator
 * swipe on iOS, which is why this lives on the card rather than on the whole
 * bottom bar.
 */

const MIN_TRAVEL_PX = 44
const MAX_DRIFT_RATIO = 0.6 // horizontal drift allowed, as a share of vertical

export function useSwipeUp(onSwipe: () => void, onSwipeDown?: () => void) {
  const from = useRef<{ x: number; y: number } | null>(null)

  return {
    onTouchStart: (e: TouchEvent) => {
      const t = e.touches[0]
      from.current = t ? { x: t.clientX, y: t.clientY } : null
    },
    onTouchMove: (e: TouchEvent) => {
      const start = from.current
      const t = e.touches[0]
      if (!start || !t) return
      const up = start.y - t.clientY
      const across = Math.abs(t.clientX - start.x)
      if (up >= MIN_TRAVEL_PX && across <= up * MAX_DRIFT_RATIO) {
        from.current = null // one gesture, one open
        onSwipe()
        return
      }
      if (!onSwipeDown || -up < MIN_TRAVEL_PX || across > -up * MAX_DRIFT_RATIO) return
      // scrolled content between the finger and the card owns this drag
      for (
        let el = e.target as HTMLElement | null;
        el && el !== e.currentTarget;
        el = el.parentElement
      ) {
        if (el.scrollTop > 0) return
      }
      from.current = null
      onSwipeDown()
    },
    onTouchEnd: () => {
      from.current = null
    },
  }
}
