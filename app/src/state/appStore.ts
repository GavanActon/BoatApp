import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SpeedUnit } from '../units'

export type SheetTab = 'route' | 'layers' | 'weather' | 'tracks' | 'offline'
export type DepthUnit = 'm' | 'ft'

interface LayerVisibility {
  depth: boolean
  contours: boolean
  seamarks: boolean
  satellite: boolean
  weather: boolean
}

interface AppState {
  // UI
  sheetTab: SheetTab | null
  setSheetTab: (t: SheetTab | null) => void

  // preferences (persisted)
  depthUnit: DepthUnit
  setDepthUnit: (u: DepthUnit) => void
  speedUnit: SpeedUnit // the boat: SOG, cruise, trip and track distances
  setSpeedUnit: (u: SpeedUnit) => void
  windUnit: SpeedUnit // the forecast: set independently of the boat's
  setWindUnit: (u: SpeedUnit) => void
  layers: LayerVisibility
  setLayer: (k: keyof LayerVisibility, v: boolean) => void
  satOpacity: number // 0..1 satellite layer opacity
  setSatOpacity: (v: number) => void

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

  // THE app-wide planning time (ms epoch), null = "now". One clock for
  // everything: the outlook strip sets it, the wind & wave map layer previews
  // it, and a planned trip departs at it. Persisted so a picked departure
  // survives an iOS PWA reload; a time that has already passed loads as null.
  planTimeMs: number | null
  setPlanTime: (ms: number | null) => void

  // 12-hour outlook strip overlaid on the map (persisted)
  wxStrip: boolean
  setWxStrip: (v: boolean) => void

  // show wave period (seconds) beside every wave height (persisted)
  wavePeriod: boolean
  setWavePeriod: (v: boolean) => void
}

/** What actually reaches localStorage: the shape partialize writes, and so
 *  the shape migrate has to hand back. Picked off AppState so the two can't
 *  drift apart. */
type PersistedPrefs = Pick<
  AppState,
  | 'depthUnit'
  | 'speedUnit'
  | 'windUnit'
  | 'layers'
  | 'satOpacity'
  | 'headingUp'
  | 'wxStrip'
  | 'wavePeriod'
  | 'planTimeMs'
>

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      sheetTab: null,
      setSheetTab: (t) => set({ sheetTab: t }),

      depthUnit: 'm',
      setDepthUnit: (u) => set({ depthUnit: u }),
      speedUnit: 'kmh',
      setSpeedUnit: (u) => set({ speedUnit: u }),
      windUnit: 'kmh',
      setWindUnit: (u) => set({ windUnit: u }),
      layers: { depth: true, contours: true, seamarks: true, satellite: true, weather: false },
      setLayer: (k, v) => set((s) => ({ layers: { ...s.layers, [k]: v } })),
      satOpacity: 0.7,
      setSatOpacity: (v) => set({ satOpacity: v }),

      follow: false,
      setFollow: (v) => set({ follow: v }),
      headingUp: false,
      setHeadingUp: (v) => set({ headingUp: v }),

      online: navigator.onLine,
      setOnline: (v) => set({ online: v }),
      offlineReady: false,
      setOfflineReady: (v) => set({ offlineReady: v }),

      planTimeMs: null,
      setPlanTime: (ms) => set({ planTimeMs: ms }),

      wxStrip: true,
      setWxStrip: (v) => set({ wxStrip: v }),

      wavePeriod: true,
      setWavePeriod: (v) => set({ wavePeriod: v }),
    }),
    {
      name: 'sandies-prefs',
      // v1 made metric the default. Prefs saved before it carry the old
      // knots/feet, so drop the unit keys once and let the defaults land.
      version: 1,
      migrate: (persisted, from) => {
        const p = { ...(persisted as Partial<AppState>) }
        if (from < 1) {
          delete p.depthUnit
          delete p.speedUnit
          delete p.windUnit
        }
        // deliberately hands back a PARTIAL — merge below lays it over the
        // current state, so the dropped keys land on the new metric defaults.
        // migrate's signature can't say "partial", hence the cast.
        return p as PersistedPrefs
      },
      partialize: (s): PersistedPrefs => ({
        depthUnit: s.depthUnit,
        speedUnit: s.speedUnit,
        windUnit: s.windUnit,
        layers: s.layers,
        satOpacity: s.satOpacity,
        headingUp: s.headingUp,
        wxStrip: s.wxStrip,
        wavePeriod: s.wavePeriod,
        planTimeMs: s.planTimeMs,
      }),
      // deep-merge layers so prefs saved before a new layer key existed still get its default
      merge: (persisted, current) => {
        const p = persisted as Partial<AppState> | undefined
        return {
          ...current,
          ...p,
          layers: { ...current.layers, ...p?.layers },
          // a planning time from a previous session that has already passed means "now"
          planTimeMs: p?.planTimeMs != null && p.planTimeMs > Date.now() ? p.planTimeMs : null,
        }
      },
    },
  ),
)
