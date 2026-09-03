import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '../state/appStore'
import { IconClose } from './icons'

/** The detents promise the chart most of the screen, so the sheet sizes
 *  itself against at most this much viewport — full-screen Safari and the
 *  installed app have taller viewports, and a pure dvh height crept up the
 *  chart with them. */
const VH_CAP_PX = 800

/** A detent as CSS: pct of the viewport, but of no more than VH_CAP_PX of it. */
function heightCss(pct: number) {
  return `calc(min(${pct}dvh, ${(pct * VH_CAP_PX) / 100}px) + var(--sab))`
}

/**
 * iOS-style draggable bottom sheet with half / full snap points.
 * Content scrolls internally when at full height.
 */
export default function BottomSheet({
  title,
  children,
  halfPct = 52,
  openPct,
}: {
  title: string
  children: ReactNode
  /** The half snap: Places rests lower so the chart keeps most of the screen. */
  halfPct?: number
  /** Where the sheet opens, when that is not the half snap: a sheet sent
   *  for by a Discover row opens full, so the control it lands on is in
   *  view without a scroll. Read once, at mount. */
  openPct?: number
}) {
  const setSheetTab = useAppStore((s) => s.setSheetTab)
  // a text field in edit stretches the sheet to full — the keyboard eats the
  // bottom half of the screen, and a half-height sheet vanishes behind it
  const tall = useAppStore((s) => s.sheetTall)
  const [heightPct, setHeightPct] = useState(openPct ?? halfPct)
  const drag = useRef<{ startY: number; startPct: number } | null>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  // the live height during a drag. React state would re-render the whole
  // panel on every pointermove — with the places list inside that recomputes
  // conditions for every spot per frame, which is what made the drag chunky
  const livePct = useRef(openPct ?? halfPct)
  // what the last reset was for — StrictMode runs the effect twice on
  // mount, so "first run" can't be what guards the opening height
  const lastSnap = useRef<[string, number]>([title, halfPct])

  /** Write the height straight to the node: a drag has to track the finger,
   *  and a render per frame cannot. */
  function applyHeight(pct: number) {
    livePct.current = pct
    const el = sheetRef.current
    if (el) el.style.height = heightCss(pct)
  }

  useEffect(() => {
    // the opening height stands; a NEW title or snap resets to the snap
    const [t, h] = lastSnap.current
    if (t === title && h === halfPct) return
    lastSnap.current = [title, halfPct]
    setHeightPct(halfPct)
    applyHeight(halfPct)
  }, [title, halfPct])

  function onPointerDown(e: React.PointerEvent) {
    drag.current = { startY: e.clientY, startPct: livePct.current }
    // the resting height animates to its snap; under the finger it must not,
    // or every frame restarts a 180ms transition and the sheet chases you
    sheetRef.current?.classList.add('sheet-dragging')
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return
    // pct is of the capped viewport, so the drag must divide by the same
    // number or the sheet lags the finger on tall screens
    const vh = Math.min(window.innerHeight, VH_CAP_PX)
    const dyPct = ((drag.current.startY - e.clientY) / vh) * 100
    applyHeight(Math.min(88, Math.max(15, drag.current.startPct + dyPct)))
  }
  function onPointerUp() {
    if (!drag.current) return
    drag.current = null
    sheetRef.current?.classList.remove('sheet-dragging')
    const h = livePct.current
    // dragged well below where it rests: that's a dismiss
    const snap = h < halfPct - 14 ? halfPct : h < 68 ? halfPct : 88
    if (h < halfPct - 14) setSheetTab(null)
    applyHeight(snap)
    setHeightPct(snap)
  }

  return (
    <div
      ref={sheetRef}
      className="sheet glass"
      style={{ height: heightCss(tall ? 88 : heightPct) }}
    >
      <div
        className="sheet-grab"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* a real button, not just a grab strip: a swipe is invisible to a
            keyboard, to VoiceOver, and to anyone who hasn't guessed it — the
            trip dock's handle makes the same argument for the same reason */}
        <button
          className="sheet-handle"
          onClick={() => {
            const next = livePct.current >= 68 ? halfPct : 88
            applyHeight(next)
            setHeightPct(next)
          }}
          aria-expanded={heightPct >= 68}
          aria-label={heightPct >= 68 ? 'Collapse' : 'Expand'}
        />
        <div className="sheet-titlerow">
          <h2>{title}</h2>
          <button className="sheet-close" onClick={() => setSheetTab(null)} aria-label="Close">
            <IconClose size={18} />
          </button>
        </div>
      </div>
      <div className="sheet-body">{children}</div>
    </div>
  )
}
