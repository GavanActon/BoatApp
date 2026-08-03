import maplibregl from 'maplibre-gl'
import { useEffect, useRef } from 'react'
import { BUNDLES, HOME } from '../config'
import { listStored } from '../offline/fileStore'
import { useAppStore } from '../state/appStore'
import type { SpeedUnit } from '../units'
import { loadContours } from './contoursData'
import { depthAt, formatDepth, loadDepthGrid } from './depthGrid'
import { applyLayerVisibility, getMap, setMap } from './mapController'
import { buildMapStyle, depthLabelExpr } from './mapStyle'
import { registerAllDataFiles } from './pmtilesRegistry'
import { useMeasureStore } from '../measure/measureStore'
import { routeEditedRecently, sampleDotAt } from '../routing/routeLayer'
import { useRouteStore } from '../routing/routeStore'
import { compass } from '../routing/tripPlan'
import { floorHourMs } from '../time'
import { formatPeriod } from '../weather/openMeteo'
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
    `<div class="depth-popup-wx"><span class="wx-item">${arrow}${wind}</span><span class="wx-item">${wave}</span></div>`
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

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
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
      if (disposed || !containerRef.current) return

      const { layers, depthUnit, satOpacity } = useAppStore.getState()
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
          available,
          contoursData,
          depthUnit,
        }),
        center: saved?.center ?? HOME.center,
        zoom: saved?.zoom ?? HOME.zoom,
        bearing: saved?.bearing ?? 0,
        maxPitch: 60,
        attributionControl: { compact: true },
        fadeDuration: 150,
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
        const routeState = useRouteStore.getState()
        if (routeState.picking) {
          if (routeState.picking === 'start') {
            routeState.setStartPoint({ name: null, lon: e.lngLat.lng, lat: e.lngLat.lat })
          } else {
            routeState.setDestination({ name: null, lon: e.lngLat.lng, lat: e.lngLat.lat })
          }
          // back to the trip card, not the sheet — the whole point of
          // picking on the map is seeing the run drawn on it
          routeState.setCard('trip')
          return
        }
        // taps near route leg dots focus the leg forecast, not the depth popup
        if (sampleDotAt(map!, e.point)) return
        const { depthUnit, planTimeMs, wavePeriod } = useAppStore.getState()
        const d = depthAt(e.lngLat.lng, e.lngLat.lat)
        popup?.remove()
        if (d == null) return
        const { lng, lat } = e.lngLat
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

  return <div ref={containerRef} className="map-root" />
}
