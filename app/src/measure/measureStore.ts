import { create } from 'zustand'

/** The measuring tool's points, in the order they were dropped. Deliberately
 *  not persisted — a measurement is a question you ask and answer on the spot. */
interface MeasureState {
  active: boolean
  points: [number, number][]
  start: () => void
  /** Leave the tool; the measurement goes with it. */
  stop: () => void
  addPoint: (p: [number, number]) => void
  movePoint: (idx: number, p: [number, number]) => void
  removePoint: (idx: number) => void
  undo: () => void
  clear: () => void
}

export const useMeasureStore = create<MeasureState>((set) => ({
  active: false,
  points: [],
  start: () => set({ active: true }),
  stop: () => set({ active: false, points: [] }),
  addPoint: (p) => set((s) => ({ points: [...s.points, p] })),
  movePoint: (idx, p) => set((s) => ({ points: s.points.map((q, i) => (i === idx ? p : q)) })),
  removePoint: (idx) => set((s) => ({ points: s.points.filter((_, i) => i !== idx) })),
  undo: () => set((s) => ({ points: s.points.slice(0, -1) })),
  clear: () => set({ points: [] }),
}))
