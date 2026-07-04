import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '../state/appStore'
import { IconClose } from './icons'

/**
 * iOS-style draggable bottom sheet with half / full snap points.
 * Content scrolls internally when at full height.
 */
export default function BottomSheet({ title, children }: { title: string; children: ReactNode }) {
  const setSheetTab = useAppStore((s) => s.setSheetTab)
  const [heightPct, setHeightPct] = useState(52)
  const drag = useRef<{ startY: number; startPct: number } | null>(null)
  const sheetRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setHeightPct(52)
  }, [title])

  function onPointerDown(e: React.PointerEvent) {
    drag.current = { startY: e.clientY, startPct: heightPct }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return
    const dyPct = ((drag.current.startY - e.clientY) / window.innerHeight) * 100
    setHeightPct(Math.min(88, Math.max(15, drag.current.startPct + dyPct)))
  }
  function onPointerUp() {
    if (!drag.current) return
    drag.current = null
    setHeightPct((h) => {
      if (h < 32) {
        setSheetTab(null)
        return 52
      }
      return h < 68 ? 52 : 88
    })
  }

  return (
    <div
      ref={sheetRef}
      className="sheet glass"
      style={{ height: `calc(${heightPct}dvh + var(--sab))` }}
    >
      <div
        className="sheet-grab"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="sheet-handle" />
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
