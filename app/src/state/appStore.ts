import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type SheetTab = 'layers' | 'weather' | 'tracks' | 'offline'
export type DepthUnit = 'm' | 'ft'

interface LayerVisibility {
  depth: boolean
  contours: boolean
  seamarks: boolean
  weather: boolean
}

interface AppState {
  // UI
  sheetTab: SheetTab | null
  setSheetTab: (t: SheetTab | null) => void

  // preferences (persisted)
  depthUnit: DepthUnit
  setDepthUnit: (u: DepthUnit) => void
  layers: LayerVisibility
  setLayer: (k: keyof LayerVisibility, v: boolean) => void

  // navigation state
  follow: boolean
  setFollow: (v: boolean) => void
  headingUp: boolean
  setHeadingUp: (v: boolean) => void

  // live data (not persisted)
  online: boolean
  setOnline: (v: boolean) => void
  offlineReady: boolean // all region files present in local storage
  setOfflineReady: (v: boolean) => void

  // weather time scrubber: hour offset from now (0..48)
  weatherHour: number
  setWeatherHour: (h: number) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      sheetTab: null,
      setSheetTab: (t) => set({ sheetTab: t }),

      depthUnit: 'ft',
      setDepthUnit: (u) => set({ depthUnit: u }),
      layers: { depth: true, contours: true, seamarks: true, weather: false },
      setLayer: (k, v) => set((s) => ({ layers: { ...s.layers, [k]: v } })),

      follow: false,
      setFollow: (v) => set({ follow: v }),
      headingUp: false,
      setHeadingUp: (v) => set({ headingUp: v }),

      online: navigator.onLine,
      setOnline: (v) => set({ online: v }),
      offlineReady: false,
      setOfflineReady: (v) => set({ offlineReady: v }),

      weatherHour: 0,
      setWeatherHour: (h) => set({ weatherHour: h }),
    }),
    {
      name: 'sandies-prefs',
      partialize: (s) => ({
        depthUnit: s.depthUnit,
        layers: s.layers,
        headingUp: s.headingUp,
      }),
    },
  ),
)
