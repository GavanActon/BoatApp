import maplibregl from 'maplibre-gl'
import { useEffect, useRef, useState } from 'react'
import { BUNDLES, DATA_FILES, HOME, MAX_BOUNDS } from '../config'
import { listStored } from '../offline/fileStore'
import { useAppStore } from '../state/appStore'
import type { SpeedUnit } from '../units'
import { loadContours } from './contoursData'
import { depthAt, formatDepth, loadDepthGrid } from './depthGrid'
import { applyLayerVisibility, getMap, setMap } from './mapController'
import { buildMapStyle, depthLabelExpr, satTreatment } from './mapStyle'
import { registerAllDataFiles } from './pmtilesRegistry'
import { useMeasureStore } from '../measure/measureStore'
import { routeEditedRecently, sampleDotAt } from '../routing/routeLayer'
import { spotBadgeAt } from '../routing/spotBadges'
import { circleBoatAt } from '../circle/circleLayer'
import { useRouteStore } from '../routing/routeStore'
import { compass } from '../routing/tripPlan'
import { floorHourMs } from '../time'
import { formatPeriod } from '../weather/openMeteo'
import { homeCenter, usePlacesStore } from '../state/placesStore'
import { ensureWeatherGrid, gridConditionsAt, type GridConditions } from '../weather/weatherLayer'

import 'maplibre-gl/dist/maplibre-gl.css'

// last camera view, persisted so a refresh resumes exactly where you left off
const VIEW_KEY = 'sandies.lastView'

interface SavedView {
  center: [number, number]
  zoom: number
  bearing: number
}

/** Depth readout plus wind/waves at the tapped point ('–' until the grid arrives). */
function tapPopupHtml(
  depth: number,
  unit: 'm' | 'ft',
  wx: GridConditions | null,
  showPeriod: boolean,
): string {
  const arrow = wx
    ? `<svg width="12" height="12" viewBox="0 0 14 14" style="transform:rotate(${Math.round(wx.windDir + 180) % 360}deg)"><path d="M7 1.5 L10 10 L7 8 L4 10 Z" fill="currentColor"/></svg>`
    : ''
  const wind = wx ? `${Math.round(wx.windKn)}<span>kn ${compass(wx.windDir)}</span>` : '–<span>kn</span>'
  const per = showPeriod ? formatPeriod(wx?.wavePeriodS) : null
  const wave =
    wx?.waveM != null
      ? `${wx.waveM.toFixed(1)}<span>m${per ? ` · ${per}` : ''}</span>`
      : '–<span>m</span>'
  return (
    `<div class="depth-popup-value">${formatDepth(depth, unit)}<span>${unit}</span></div>` +
    `<div class="depth-popup-wx"><span class="wx-item">${arrow}${wind}</span><span class="wx-item">${wave}</span></div>` +
    // Go = the point becomes the subject (explore rules — nothing asks when);
    // Save = it becomes a place: a badge on the chart and a Places row (§0.2)
    `<div class="pp-acts"><button class="pp-go">Go</button><button class="pp-save">Save</button></div>`
  )
}

function loadSavedView(): SavedView | null {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '') as SavedView
    const ok =
      Array.isArray(v.center) &&
      typeof v.center[0] === 'number' &&
      typeof v.center[1] === 'number' &&
      typeof v.zoom === 'number'
    return ok ? v : null
  } catch {
    return null
  }
}

/** The scale bar speaks the same distance the rest of the app does. */
function scaleUnitFor(speed: SpeedUnit): 'nautical' | 'metric' | 'imperial' {
  return speed === 'kmh' ? 'metric' : speed === 'mph' ? 'imperial' : 'nautical'
}

/**
 * MapLibre draws with WebGL and has no other mode: with no context there is
 * no chart at all, just an empty pane the colour of the background — which
 * reads as a broken app rather than a browser that cannot draw.
 *
 * Chrome reports it as "Failed to initialize WebGL" with GL_RENDERER =
 * Disabled when graphics acceleration is off or the GPU process failed to
 * start, and the throw arrives as an unhandled rejection nobody sees.
 */
function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'))
  } catch {
    return false
  }
}

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [noWebgl, setNoWebgl] = useState(false)
  const scaleRef = useRef<maplibregl.ScaleControl | null>(null)

  useEffect(() => {
    let disposed = false
    let map: maplibregl.Map | null = null
    let popup: maplibregl.Popup | null = null
    let unsubMeasure: (() => void) | null = null

    ;(async () => {
      const [available, contoursData] = await Promise.all([
        registerAllDataFiles(),
        loadContours(),
        loadDepthGrid(),
      ])
      const storedNames = new Set(listStored().map((s) => s.name))
      useAppStore
        .getState()
        .setOfflineReady(BUNDLES[0].files.every((f) => storedNames.has(f)))
      // An archive that will not open is dropped from the style, and its
      // layers simply are not drawn — which looks exactly like a chart that
      // never arrived, with nothing to say why. Name them instead: a stale or
      // half-written offline copy is the usual cause, and re-downloading is
      // the cure.
      useAppStore
        .getState()
        .setMissingCharts(DATA_FILES.filter((d) => !available.has(d.key)).map((d) => d.label))
      if (disposed || !containerRef.current) return
      // ask before building: a failed constructor throws into a promise and
      // leaves a blank pane with the reason only in the console
      if (!webglAvailable()) {
        setNoWebgl(true)
        return
      }

      const { layers, depthUnit, satOpacity, satVivid } = useAppStore.getState()
      const saved = loadSavedView()
      map = new maplibregl.Map({
        container: containerRef.current,
        style: buildMapStyle({
          base: import.meta.env.BASE_URL,
          showDepth: layers.depth,
          showContours: layers.contours,
          showSeamarks: layers.seamarks,
          showSatellite: layers.satellite,
          satOpacity,
          satVivid,
          available,
          contoursData,
          depthUnit,
        }),
        center: saved?.center ?? homeCenter() ?? HOME.center,
        zoom: saved?.zoom ?? HOME.zoom,
        bearing: saved?.bearing ?? 0,
        maxBounds: MAX_BOUNDS,
        maxPitch: 60,
        attributionControl: { compact: true },
        fadeDuration: 150,
        // iOS gives a web app a fixed memory budget and kills the page when
        // it is spent — the app "closes on its own". The chart is the big
        // spender: a 3× canvas is 2.25× the pixels of a 2× one for no
        // legible gain on a chart, and every cached tile is a texture. The
        // flow canvases already cap at 2×.
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        maxTileCacheSize: 48,
      })

      const scale = new maplibregl.ScaleControl({
        maxWidth: 90,
        unit: scaleUnitFor(useAppStore.getState().speedUnit),
      })
      scaleRef.current = scale
      map.addControl(scale, 'bottom-left')
      map.touchZoomRotate.enableRotation()

      // tap water → depth + wind/waves popup (or set route destination in pick mode)
      map.on('click', (e) => {
        if (routeEditedRecently()) return // the click that ends a route edit
        if (useMeasureStore.getState().active) return // taps belong to the ruler
        // first-run home pick (§10.3): stand down — the pick is CONSUMED in
        // spotBadges' click handler, the last one registered on the map.
        // Every click handler fires on the same event in registration
        // order, so whoever consumes the pick must run last, or the
        // handlers after it see the pick already disarmed and treat the
        // same tap as their own (the badge handler used to route on it).
        if (useAppStore.getState().pickingHome) return
        const routeState = useRouteStore.getState()
        // chips arm, surfaces answer: with a slot armed, ANY tap on the
        // water is its keypad — fill the slot, disarm, done
        const slot = useAppStore.getState().armedSlot
        if (slot) {
          const { lng, lat } = e.lngLat
          if (slot === 'from') {
            routeState.setStartPoint({ name: null, lon: lng, lat })
          } else {
            useAppStore.getState().setPlanPicked(false)
            routeState.setDestination({ name: null, lon: lng, lat })
            routeState.setFocusPoint({ lon: lng, lat, label: 'Pinned spot' })
            routeState.setCard('trip')
          }
          useAppStore.getState().setArmedSlot(null)
          return
        }
        // taps near route leg dots focus the leg forecast, not the depth popup
        if (sampleDotAt(map!, e.point)) return
        // taps near a spot badge change the subject, not the depth readout
        if (spotBadgeAt(map!, e.point)) return
        // taps on a friend's boat open its card (the circle layer's own handler)
        if (circleBoatAt(map!, e.point)) return
        const { depthUnit, planTimeMs, wavePeriod } = useAppStore.getState()
        const d = depthAt(e.lngLat.lng, e.lngLat.lat)
        popup?.remove()
        if (d == null) return
        const { lng, lat } = e.lngLat
        // anywhere you tap, the strip follows: the tapped point becomes the
        // forecast focus — the chip's ✕ brings the strip back to the boat
        routeState.setFocusPoint({ lon: lng, lat, label: 'Tapped point' })
        // same app-wide moment the weather layer and outlook strip show
        const wxTime = planTimeMs ?? floorHourMs()
        const p = new maplibregl.Popup({
          closeButton: false,
          className: 'depth-popup',
          offset: 10,
          maxWidth: 'none',
        })
          .setLngLat(e.lngLat)
          .setHTML(tapPopupHtml(d, depthUnit, gridConditionsAt(lng, lat, wxTime), wavePeriod))
          .addTo(map!)
        popup = p
        // the tap's focus lives and dies with its popup: dismissing the
        // details clears the dot and hands the strip back — but only the
        // TRANSIENT tap focus. A deliberate focus (Go's pinned spot, a badge,
        // a Places look) has its own label and its own ✕, and survives.
        p.once('close', () => {
          const rs = useRouteStore.getState()
          if (rs.focusPoint?.label === 'Tapped point') rs.setFocusPoint(null)
        })
        // one delegated listener on the container — it survives the setHTML
        // refresh below, where listeners on the buttons themselves would not
        p.getElement().addEventListener('click', (ev) => {
          const t = ev.target as HTMLElement
          const rs = useRouteStore.getState()
          if (t.closest('.pp-go')) {
            // tap-anywhere, go-anywhere: the same ladder a badge tap walks —
            // subject set, lanes plot, strip retargets, still exploring (§0.4)
            useAppStore.getState().setPlanPicked(false)
            rs.setDestination({ name: null, lon: lng, lat })
            rs.setFocusPoint({ lon: lng, lat, label: 'Pinned spot' })
            rs.setCard('trip')
            useAppStore.getState().setDetent('rest')
            p.remove()
          } else if (t.closest('.pp-save')) {
            // a saved pin is a place like any other from here on. Save opens
            // the Places sheet with the new name in edit — you name the spot
            // while you still remember why you tapped it.
            const place = usePlacesStore.getState().addPlace(lng, lat)
            usePlacesStore.getState().setPendingEdit(place.name)
            useAppStore.getState().setSheetTab('places')
            p.remove()
          } else {
            // a tap on the panel itself is "never mind" — it has no close
            // button, so its own body is the dismiss target. The strip keeps
            // pointing at the tapped spot; its chip's ✕ is the way back.
            p.remove()
          }
        })
        // grid may be absent (weather layer off) or stale — fill in once it lands
        void ensureWeatherGrid().then(() => {
          if (popup !== p || !p.isOpen()) return
          const wx = gridConditionsAt(lng, lat, wxTime)
          if (wx) p.setHTML(tapPopupHtml(d, depthUnit, wx, wavePeriod))
        })
      })

      // user gesture breaks follow mode
      map.on('dragstart', () => useAppStore.getState().setFollow(false))

      // a depth popup left open would sit on top of the measurement
      unsubMeasure = useMeasureStore.subscribe((s) => {
        if (s.active) popup?.remove()
      })

      map.on('moveend', () => {
        const c = map!.getCenter()
        localStorage.setItem(
          VIEW_KEY,
          JSON.stringify({ center: [c.lng, c.lat], zoom: map!.getZoom(), bearing: map!.getBearing() }),
        )
      })

      setMap(map)
      // dev-only handle for driving the map in automated verification
      if (import.meta.env.DEV) (window as unknown as { __map?: unknown }).__map = map

      // Compact attribution ships OPEN until the first interaction — three
      // lines of licence text floating over the chart — and re-asserts the
      // open state when the control attaches, so folding once at init raced
      // it and lost (screenshots kept catching it expanded). Fold now, after
      // load, and once more a beat later; the ⓘ still opens it on demand.
      const foldAttribution = () => {
        map!
          .getContainer()
          .querySelector('.maplibregl-ctrl-attrib')
          ?.classList.remove('maplibregl-compact-show')
      }
      foldAttribution()
      map!.once('load', foldAttribution)
      window.setTimeout(foldAttribution, 1600)
    })()

    return () => {
      disposed = true
      setMap(null)
      unsubMeasure?.()
      popup?.remove()
      map?.remove()
    }
  }, [])

  // keep layer visibility + label units in sync with the store
  useEffect(
    () =>
      useAppStore.subscribe((s, prev) => {
        if (s.layers !== prev.layers) {
          for (const k of ['depth', 'contours', 'seamarks', 'satellite'] as const) {
            if (s.layers[k] !== prev.layers[k]) applyLayerVisibility(k, s.layers[k])
          }
        }
        if (s.satOpacity !== prev.satOpacity) {
          const map = getMap()
          if (map?.getLayer('satellite')) {
            map.setPaintProperty('satellite', 'raster-opacity', s.satOpacity)
          }
        }
        if (s.satVivid !== prev.satVivid) {
          const map = getMap()
          if (map?.getLayer('satellite')) {
            const t = satTreatment(s.satVivid)
            for (const [k, v] of Object.entries(t)) map.setPaintProperty('satellite', k, v)
          }
        }
        if (s.depthUnit !== prev.depthUnit) {
          const map = getMap()
          if (map?.getLayer('contour-labels')) {
            map.setLayoutProperty('contour-labels', 'text-field', depthLabelExpr(s.depthUnit, false))
          }
          if (map?.getLayer('soundings')) {
            map.setLayoutProperty('soundings', 'text-field', depthLabelExpr(s.depthUnit, true))
          }
        }
        if (s.speedUnit !== prev.speedUnit) {
          scaleRef.current?.setUnit(scaleUnitFor(s.speedUnit))
        }
      }),
    [],
  )

  if (noWebgl) {
    return (
      <div className="map-root map-nogl">
        <div className="nogl">
          <h2>The chart can't draw here</h2>
          <p>
            This browser couldn't create a WebGL context, and the chart has no other way
            to draw. Everything else — the forecast, your places, the trip — still works.
          </p>
          <p>
            <b>Restart the browser first.</b> Chrome turns all acceleration off after its
            GPU process crashes a few times — <b>chrome://gpu</b> shows the count and says
            "unable to boot" — and a restart usually brings it back.
          </p>
          <p>
            If that doesn't do it, check <b>Settings → System → Use graphics acceleration
            when available</b> is on, and update your graphics drivers.
          </p>
        </div>
      </div>
    )
  }
  return <div ref={containerRef} className="map-root" />
}
