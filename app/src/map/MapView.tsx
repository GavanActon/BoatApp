import maplibregl from 'maplibre-gl'
import { useEffect, useRef } from 'react'
import { BUNDLES, HOME } from '../config'
import { listStored } from '../offline/fileStore'
import { useAppStore } from '../state/appStore'
import { loadContours } from './contoursData'
import { depthAt, formatDepth, loadDepthGrid } from './depthGrid'
import { applyLayerVisibility, getMap, setMap } from './mapController'
import { buildMapStyle, depthLabelExpr } from './mapStyle'
import { registerAllDataFiles } from './pmtilesRegistry'

import 'maplibre-gl/dist/maplibre-gl.css'

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let disposed = false
    let map: maplibregl.Map | null = null
    let popup: maplibregl.Popup | null = null

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

      const { layers, depthUnit } = useAppStore.getState()
      map = new maplibregl.Map({
        container: containerRef.current,
        style: buildMapStyle({
          base: import.meta.env.BASE_URL,
          showDepth: layers.depth,
          showContours: layers.contours,
          showSeamarks: layers.seamarks,
          available,
          contoursData,
          depthUnit,
        }),
        center: HOME.center,
        zoom: HOME.zoom,
        maxPitch: 60,
        attributionControl: { compact: true },
        fadeDuration: 150,
      })

      map.addControl(
        new maplibregl.ScaleControl({ maxWidth: 90, unit: 'nautical' }),
        'bottom-left',
      )
      map.touchZoomRotate.enableRotation()

      // tap water → depth readout popup
      map.on('click', (e) => {
        const { depthUnit } = useAppStore.getState()
        const d = depthAt(e.lngLat.lng, e.lngLat.lat)
        popup?.remove()
        if (d == null) return
        popup = new maplibregl.Popup({
          closeButton: false,
          className: 'depth-popup',
          offset: 10,
          maxWidth: 'none',
        })
          .setLngLat(e.lngLat)
          .setHTML(
            `<div class="depth-popup-value">${formatDepth(d, depthUnit)}<span>${depthUnit}</span></div>`,
          )
          .addTo(map!)
      })

      // user gesture breaks follow mode
      map.on('dragstart', () => useAppStore.getState().setFollow(false))

      setMap(map)
    })()

    return () => {
      disposed = true
      setMap(null)
      popup?.remove()
      map?.remove()
    }
  }, [])

  // keep layer visibility + label units in sync with the store
  useEffect(
    () =>
      useAppStore.subscribe((s, prev) => {
        if (s.layers !== prev.layers) {
          for (const k of ['depth', 'contours', 'seamarks'] as const) {
            if (s.layers[k] !== prev.layers[k]) applyLayerVisibility(k, s.layers[k])
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
      }),
    [],
  )

  return <div ref={containerRef} className="map-root" />
}
