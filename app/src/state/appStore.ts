import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SpeedUnit } from '../units'

// 'discover' is the trial's sheet (src/discover) — opened from its glyph, not a tab
export type SheetTab = 'places' | 'layers' | 'weather' | 'tracks' | 'offline' | 'discover'
export type DepthUnit = 'm' | 'ft'

interface LayerVisibility {
  depth: boolean
  contours: boolean
  seamarks: boolean
  satellite: boolean
  weather: boolean
  /** Live wind streaming over the chart — particles advected by the forecast
   *  grid at the planning time. The always-on sibling of the briefing. */
  windFlow: boolean
  /** The sea itself: swell fronts marching on the water, foam-white, clipped
   *  to the shoreline by the depth grid. Composes with windFlow — white
   *  water, coloured air. */
  seaFlow: boolean
}

/** The motion layers' tuning knobs, all live-adjustable from Settings so the
 *  look can be dialled in ON THE WATER rather than in code. Persisted. */
export interface FlowTuning {
  windDensity: number // particle count, 200–2500
  windSpeed: number // multiplier on advection speed, 0.3–3
  windTrail: number // per-frame fade 0.86–0.97 — higher = longer streaks
  windHue: number // stroke hue, degrees (195 = just off the app accent, Gavan-tuned)
  windSat: number // stroke saturation %, 0 = white threads
  seaOpacity: number // crest strength 0..1
  seaSpacing: number // px between crest anchors 24–72 — lower = denser
  seaLength: number // crest length multiplier 0.5–2
  seaSpeed: number // multiplier on TRUE phase speed, 1–8 (1 = honest, slow)
  seaCurve: number // crest bow multiplier, 0 = dead straight
  seaHue: number // crest hue, degrees
  seaSat: number // crest saturation %, low = foam
}

/** The sea-state ramp's anchor (see weather/seaState.ts): the wave height at
 *  which "Rough" — the red-orange band — begins. Half a metre, because on
 *  this water that IS a big sea for a small boat; the base ramp's 1.4 m is
 *  a ship's idea of rough and read a whole summer here as calm. */
export const SEA_SCALE_DEFAULT_M = 0.5
export const SEA_SCALE_MIN_M = 0.2
export const SEA_SCALE_MAX_M = 2

export const FLOW_TUNING_DEFAULTS: FlowTuning = {
  windDensity: 1100,
  windSpeed: 1,
  windTrail: 0.92,
  windHue: 195,
  windSat: 100,
  seaOpacity: 0.8,
  seaSpacing: 40,
  seaLength: 1,
  seaSpeed: 4,
  seaCurve: 1.3,
  seaHue: 203,
  seaSat: 60,
}

interface AppState {
  // UI
  sheetTab: SheetTab | null
  setSheetTab: (t: SheetTab | null) => void

  // The dock's two heights (§2.3). 'rest' keeps the chart dominant; 'raised'
  // grows the SAME card to carry the fuller version of whatever it is about —
  // this replaced the separate route drawer that used to open over the card.
  // Transient like armedEnd: a reload lands back at rest, on purpose.
  detent: 'rest' | 'raised'
  setDetent: (v: 'rest' | 'raised') => void

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
  // Quiet land, living water: by default the satellite is heavily desaturated
  // and dimmed so it reads as "shore" and the data layers own the contrast.
  // Vivid restores true colour for reading beaches and anchorages.
  satVivid: boolean
  setSatVivid: (v: boolean) => void
  windFlowOpacity: number // 0..1 wind-flow particle strength
  setWindFlowOpacity: (v: number) => void
  flowTuning: FlowTuning
  setFlowTuning: (t: Partial<FlowTuning>) => void

  // navigation state
  follow: boolean
  setFollow: (v: boolean) => void
  // Heading-up: the flat chart rotated to the course while following. A
  // camera stance toggled from the map (the trip FAB), not a preference —
  // and like helm below, not persisted: a reload starts north-up.
  headingUp: boolean
  setHeadingUp: (v: boolean) => void
  // Helm view: the chart pitched to 60° and course-up, boat low on the
  // screen, the water ahead filling the top. A camera stance layered on
  // follow — deliberately NOT persisted: a reload starts flat, because a
  // pitched chart greeting someone at the kitchen table is the same
  // "how did I get into 3D?" confusion the toggle exists to replace.
  helm: boolean
  setHelm: (v: boolean) => void
  // Low power: stills every ambient animation (wind, sea, run comet) for a
  // long day on one battery. The INFORMATION stays — wave heights read as
  // numbers on the chart instead of moving crests. Persisted: a plotter
  // mounted at the helm shouldn't forget the mode over a refresh.
  lowPower: boolean
  setLowPower: (v: boolean) => void
  // Usage stats: what gets used and how the app performs, counted under a
  // random id (src/stats). On by default; the switch is in Settings and a
  // no is persisted.
  usageStats: boolean
  setUsageStats: (v: boolean) => void

  // First run (DESIGN-SPEC §10). `onboarded`: the welcome card has been
  // answered (Get set up or Later) — either way it never shows again.
  // `setupDone`: kept for installs that had the retired first-voyage card;
  // setup now lives in Discover's First voyage chapter, which is computed
  // from the facts and never retires. Offline charts are deliberately NOT a
  // requirement — the Offline tab advertises itself. All persisted.
  onboarded: boolean
  setOnboarded: (v: boolean) => void
  setupDone: boolean
  setSetupDone: (v: boolean) => void
  // The first run has been plotted — by the checklist's Sandies row or by
  // the user finding their own way to any destination. Persisted.
  firstRouteDone: boolean
  setFirstRouteDone: (v: boolean) => void
  // The read-the-water guide was opened and dismissed. Persisted.
  numbersSeen: boolean
  setNumbersSeen: (v: boolean) => void
  // The guide overlay is on screen. Transient.
  showNumbersGuide: boolean
  setShowNumbersGuide: (v: boolean) => void
  // The first-voyage card's home pick: the next chart tap saves the point
  // as the starred home base (§10.3). Same arm-then-answer grammar as
  // armedSlot. Transient.
  pickingHome: boolean
  setPickingHome: (v: boolean) => void
  // The user has asked for GPS at least once (locate FAB, the checklist's
  // location row, recording, helm view) — so future launches may start it
  // without waiting to be asked again. Persisted. Until this is true, a
  // launch only starts GPS when the OS says permission is already granted:
  // the FIRST location prompt belongs to the onboarding row, never to a
  // cold open (§10.2).
  gpsWanted: boolean
  setGpsWanted: (v: boolean) => void

  // live data (not persisted)
  online: boolean
  setOnline: (v: boolean) => void

  // The forecast-shift alert (forecastWatch.ts): non-null when a fresh model
  // run disagrees substantially with what the user last saw for the hours
  // they care about. Transient — a reload re-derives it from the persisted
  // baseline, so an overnight shift still greets the morning open.
  wxShift: string | null
  setWxShift: (v: string | null) => void

  // The sheet stretched to full height because a text field inside it is
  // being edited — the phone keyboard covers the bottom half of the screen,
  // and a half-height sheet disappears entirely behind it. Transient.
  sheetTall: boolean
  setSheetTall: (v: boolean) => void
  /** Chart archives that would not open — a blank chart with a reason.
   *  Empty is the normal case. */
  missingCharts: string[]
  setMissingCharts: (v: string[]) => void
  offlineReady: boolean // all region files present in local storage
  setOfflineReady: (v: boolean) => void

  // THE app-wide planning time (ms epoch), null = "now". One clock for
  // everything: the outlook strip sets it, the wind & wave map layer previews
  // it, and a planned trip departs at it. Persisted so a picked departure
  // survives an iOS PWA reload; a time that has already passed loads as null.
  planTimeMs: number | null
  setPlanTime: (ms: number | null) => void

  // The far end of the trip window: when you want to be back. Together with
  // planTimeMs this is the whole trip input — you say the hours you're free
  // and the time at the destination falls out of it, rather than being a
  // setting of its own. Null = no window, so the old "minimum stay" applies.
  planEndMs: number | null
  setPlanWindow: (startMs: number | null, endMs: number | null) => void

  // How long an outing usually runs, used only to place a fresh window so it
  // arrives with a sensible answer already in it.
  usualOutingMin: number
  setUsualOuting: (min: number) => void

  // Has the user PICKED a time at all? Place taps explore; time taps plan —
  // and "leaving now" is also a pick (the strip's Now cell), not a default.
  // Until this is true the trip surface shows facts only: no window chips, no
  // Start. Deliberately not persisted: a fresh open starts at exploring.
  planPicked: boolean
  setPlanPicked: (v: boolean) => void

  // Which end of the window the next tap on an hour cell sets. Transient UI
  // state shared between the card (which holds the chips) and the strip
  // (which is their keypad) — deliberately not persisted.
  armedEnd: 'out' | 'back' | null
  setArmedEnd: (v: 'out' | 'back' | null) => void

  // The SPACE twin of armedEnd: which end of the sentence the next tap on a
  // badge, the open water, or a Places row fills. Chips arm, surfaces answer
  // — one grammar for time and place. Transient, never persisted.
  armedSlot: 'from' | 'to' | null
  setArmedSlot: (v: 'from' | 'to' | null) => void

  // 12-hour outlook strip overlaid on the map (persisted)
  wxStrip: boolean
  setWxStrip: (v: boolean) => void

  // show wave period (seconds) beside every wave height (persisted)
  wavePeriod: boolean
  setWavePeriod: (v: boolean) => void

  // The skipper's own limits — the water and wind THEY are happy in, used to
  // mark which spots currently sit inside them.
  //
  // Both start null and stay null until set, on purpose. A default here would
  // quietly turn every mark in the app into the app's opinion about your boat,
  // which is the one thing this is meant not to be. Null means no marks are
  // drawn at all; it does not mean zero.
  waveLimitM: number | null
  windLimitKn: number | null
  setLimits: (waveM: number | null, windKn: number | null) => void

  // Where the sea-state ramp's bands fall (persisted): the wave height at
  // which Rough begins; every band scales with it. Unlike the limits above
  // this is a display scale, not a judgement about the boat, so it has a
  // default — the ramp has to be drawn from the first launch.
  seaScaleM: number
  setSeaScale: (m: number) => void
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
  | 'satVivid'
  | 'windFlowOpacity'
  | 'flowTuning'
  | 'lowPower'
  | 'usageStats'
  | 'onboarded'
  | 'setupDone'
  | 'firstRouteDone'
  | 'numbersSeen'
  | 'gpsWanted'
  | 'wxStrip'
  | 'wavePeriod'
  | 'planTimeMs'
  | 'planEndMs'
  | 'usualOutingMin'
  | 'waveLimitM'
  | 'windLimitKn'
  | 'seaScaleM'
>

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      sheetTab: null,
      setSheetTab: (t) => set({ sheetTab: t }),

      detent: 'rest',
      setDetent: (detent) => set({ detent }),

      depthUnit: 'm',
      setDepthUnit: (u) => set({ depthUnit: u }),
      speedUnit: 'kmh',
      setSpeedUnit: (u) => set({ speedUnit: u }),
      windUnit: 'kmh',
      setWindUnit: (u) => set({ windUnit: u }),
      layers: {
        depth: true,
        contours: true,
        seamarks: true,
        satellite: true,
        weather: false,
        windFlow: true, // the moving air is the app's face — on unless turned off
        seaFlow: true, // and the moving water beside it
      },
      setLayer: (k, v) => set((s) => ({ layers: { ...s.layers, [k]: v } })),
      satOpacity: 0.7,
      setSatOpacity: (v) => set({ satOpacity: v }),
      satVivid: true,
      setSatVivid: (v) => set({ satVivid: v }),
      windFlowOpacity: 0.8,
      setWindFlowOpacity: (v) => set({ windFlowOpacity: v }),
      flowTuning: FLOW_TUNING_DEFAULTS,
      setFlowTuning: (t) => set((s) => ({ flowTuning: { ...s.flowTuning, ...t } })),

      follow: false,
      setFollow: (v) => set({ follow: v }),
      headingUp: false,
      setHeadingUp: (v) => set({ headingUp: v }),
      helm: false,
      setHelm: (v) => set({ helm: v }),
      lowPower: false,
      setLowPower: (v) => set({ lowPower: v }),
      usageStats: true,
      setUsageStats: (v) => set({ usageStats: v }),

      onboarded: false,
      setOnboarded: (v) => set({ onboarded: v }),
      setupDone: false,
      setSetupDone: (v) => set({ setupDone: v }),
      firstRouteDone: false,
      setFirstRouteDone: (v) => set({ firstRouteDone: v }),
      numbersSeen: false,
      setNumbersSeen: (v) => set({ numbersSeen: v }),
      showNumbersGuide: false,
      setShowNumbersGuide: (v) => set({ showNumbersGuide: v }),
      pickingHome: false,
      setPickingHome: (v) => set({ pickingHome: v }),
      gpsWanted: false,
      setGpsWanted: (v) => set({ gpsWanted: v }),

      online: navigator.onLine,
      setOnline: (v) => set({ online: v }),

      wxShift: null,
      setWxShift: (v) => set({ wxShift: v }),

      sheetTall: false,
      setSheetTall: (v) => set({ sheetTall: v }),
      missingCharts: [],
      setMissingCharts: (missingCharts) => set({ missingCharts }),
      offlineReady: false,
      setOfflineReady: (v) => set({ offlineReady: v }),

      planTimeMs: null,
      // moving the departure on its own drags the whole window with it, so the
      // hours you're out stay the hours you asked for
      setPlanTime: (ms) =>
        set((st) => {
          if (ms == null) return { planTimeMs: null, planEndMs: null }
          const span =
            st.planTimeMs != null && st.planEndMs != null
              ? st.planEndMs - st.planTimeMs
              : st.usualOutingMin * 60_000
          return { planTimeMs: ms, planEndMs: ms + span }
        }),

      planEndMs: null,
      setPlanWindow: (planTimeMs, planEndMs) => set({ planTimeMs, planEndMs }),

      usualOutingMin: 180,
      setUsualOuting: (usualOutingMin) => set({ usualOutingMin }),

      planPicked: false,
      setPlanPicked: (planPicked) => set({ planPicked }),

      armedEnd: null,
      setArmedEnd: (armedEnd) => set({ armedEnd }),

      armedSlot: null,
      setArmedSlot: (armedSlot) => set({ armedSlot }),

      wxStrip: true,
      setWxStrip: (v) => set({ wxStrip: v }),

      wavePeriod: true,
      setWavePeriod: (v) => set({ wavePeriod: v }),

      waveLimitM: null,
      windLimitKn: null,
      setLimits: (waveLimitM, windLimitKn) => set({ waveLimitM, windLimitKn }),

      seaScaleM: SEA_SCALE_DEFAULT_M,
      setSeaScale: (m) =>
        set({ seaScaleM: Math.min(SEA_SCALE_MAX_M, Math.max(SEA_SCALE_MIN_M, m)) }),
    }),
    {
      name: 'sandies-prefs',
      // v1 made metric the default. Prefs saved before it carry the old
      // knots/feet, so drop the unit keys once and let the defaults land.
      version: 3,
      migrate: (persisted, from) => {
        const p = { ...(persisted as Partial<AppState>) }
        // versionless storage arrives as `undefined`, and `undefined < 1` is
        // false — so this has to normalise before comparing or prefs saved
        // before v1 never get migrated at all
        const was = typeof from === 'number' ? from : 0
        if (was < 1) {
          delete p.depthUnit
          delete p.speedUnit
          delete p.windUnit
        }
        // v2 turns wind flow and depth shading on by default; installs that
        // stored the old values get the new defaults once (turning either
        // off after this sticks)
        if (was < 2 && p.layers) {
          const l = { ...p.layers } as Partial<AppState['layers']>
          delete l.windFlow
          delete l.depth
          p.layers = l as AppState['layers']
        }
        // v3 made vivid satellite the default; the stored quiet-era value
        // gets lifted once (switching after this sticks)
        if (was < 3) delete p.satVivid
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
        satVivid: s.satVivid,
        windFlowOpacity: s.windFlowOpacity,
        flowTuning: s.flowTuning,
        lowPower: s.lowPower,
        usageStats: s.usageStats,
        onboarded: s.onboarded,
        setupDone: s.setupDone,
        firstRouteDone: s.firstRouteDone,
        numbersSeen: s.numbersSeen,
        gpsWanted: s.gpsWanted,
        wxStrip: s.wxStrip,
        wavePeriod: s.wavePeriod,
        planTimeMs: s.planTimeMs,
        planEndMs: s.planEndMs,
        usualOutingMin: s.usualOutingMin,
        waveLimitM: s.waveLimitM,
        windLimitKn: s.windLimitKn,
        seaScaleM: s.seaScaleM,
      }),
      // deep-merge layers so prefs saved before a new layer key existed still get its default
      merge: (persisted, current) => {
        const p = persisted as Partial<AppState> | undefined
        return {
          ...current,
          ...p,
          layers: { ...current.layers, ...p?.layers },
          // same deep-merge: a knob added after prefs were saved keeps its default
          flowTuning: { ...current.flowTuning, ...p?.flowTuning },
          // a planning time from a previous session that has already passed means "now"
          planTimeMs: p?.planTimeMs != null && p.planTimeMs > Date.now() ? p.planTimeMs : null,
          planEndMs: p?.planTimeMs != null && p.planTimeMs > Date.now() ? (p.planEndMs ?? null) : null,
        }
      },
    },
  ),
)

// dev-only handle, the same convention as MapView's window.__map and the
// route store's window.__route — lets the verify harness move the planning
// clock, which has no other seam from outside the UI
if (import.meta.env.DEV) {
  ;(window as unknown as { __app?: unknown }).__app = useAppStore
}
