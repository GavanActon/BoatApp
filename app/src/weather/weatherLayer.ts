import type { FeatureCollection } from 'geojson'
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import { withMap } from '../map/mapController'
import { useAppStore } from '../state/appStore'
import { fetchGridForecast, timeIndexFor, type GridForecast } from './openMeteo'

/**
 * Wind + wave map layer. One fixed forecast grid over the cruising region,
 * rendered as soft wave-height blobs with wind arrows on top, stepped through
 * time by the scrubber in the Weather panel.
 */

let grid: GridForecast | null = null
let gridStale = false
let layersAdded = false

const ARROW_BUCKETS = [
  { id: 'wx-arrow-0', color: '#7fd4e8', max: 8 }, // light
  { id: 'wx-arrow-1', color: '#8be08f', max: 12 }, // moderate
  { id: 'wx-arrow-2', color: '#ffd166', max: 16 }, // fresh
  { id: 'wx-arrow-3', color: '#ff9f43', max: 22 }, // strong
  { id: 'wx-arrow-4', color: '#ff6b6b', max: Infinity }, // very strong
]

function makeArrowImage(color: string): ImageData {
  const size = 44
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.translate(size / 2, size / 2)
  // arrow pointing up (rotated by wind direction at render time)
  ctx.beginPath()
  ctx.moveTo(0, -15)
  ctx.lineTo(8, 11)
  ctx.lineTo(0, 6)
  ctx.lineTo(-8, 11)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.strokeStyle = 'rgba(8, 20, 34, 0.9)'
  ctx.lineWidth = 2
  ctx.fill()
  ctx.stroke()
  return ctx.getImageData(0, 0, size, size)
}

function addLayers(map: MlMap) {
  if (layersAdded || !map.getStyle()) return

  for (const b of ARROW_BUCKETS) {
    if (!map.hasImage(b.id)) map.addImage(b.id, makeArrowImage(b.color), { pixelRatio: 2 })
  }

  map.addSource('wx', { type: 'geojson', data: emptyFc() })

  map.addLayer({
    id: 'wx-wave',
    type: 'circle',
    source: 'wx',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 26, 11, 64],
      'circle-blur': 1.1,
      'circle-opacity': 0.55,
      'circle-color': [
        'interpolate',
        ['linear'],
        ['coalesce', ['get', 'wave'], 0],
        0,
        'rgba(30, 90, 140, 0.0)',
        0.3,
        'rgba(63, 160, 220, 0.45)',
        0.8,
        'rgba(120, 220, 170, 0.5)',
        1.5,
        'rgba(255, 209, 102, 0.55)',
        2.5,
        'rgba(255, 107, 107, 0.6)',
      ],
    },
  })

  map.addLayer({
    id: 'wx-wind',
    type: 'symbol',
    source: 'wx',
    layout: {
      visibility: 'none',
      'icon-image': [
        'step',
        ['get', 'wind'],
        'wx-arrow-0',
        ARROW_BUCKETS[0].max,
        'wx-arrow-1',
        ARROW_BUCKETS[1].max,
        'wx-arrow-2',
        ARROW_BUCKETS[2].max,
        'wx-arrow-3',
        ARROW_BUCKETS[3].max,
        'wx-arrow-4',
      ],
      'icon-rotate': ['get', 'arrowDir'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 7, 0.8, 11, 1.25],
      'text-field': ['concat', ['to-string', ['round', ['get', 'wind']]], ' kn'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10,
      'text-offset': [0, 1.6],
      'text-allow-overlap': true,
      'text-optional': true,
    },
    paint: {
      'text-color': 'rgba(220, 240, 255, 0.9)',
      'text-halo-color': 'rgba(8, 20, 34, 0.85)',
      'text-halo-width': 1.2,
    },
  })

  layersAdded = true
}

function emptyFc(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] }
}

function fcForHour(g: GridForecast, hourOffset: number): FeatureCollection {
  const i = timeIndexFor(g, hourOffset)
  return {
    type: 'FeatureCollection',
    features: g.cells.map((c) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
      properties: {
        wind: c.windKn[i] ?? 0,
        gust: c.gustKn[i] ?? 0,
        // wind_direction is where wind comes FROM; arrow points where it blows TO
        arrowDir: ((c.windDir[i] ?? 0) + 180) % 360,
        wave: c.waveM[i],
      },
    })),
  }
}

function render(map: MlMap) {
  if (!layersAdded) return
  const { layers, weatherHour } = useAppStore.getState()
  const src = map.getSource('wx') as GeoJSONSource | undefined
  if (!src) return
  src.setData(grid && layers.weather ? fcForHour(grid, weatherHour) : emptyFc())
  const vis = layers.weather ? 'visible' : 'none'
  map.setLayoutProperty('wx-wave', 'visibility', vis)
  map.setLayoutProperty('wx-wind', 'visibility', vis)
}

export async function refreshWeatherGrid(): Promise<{ fetchedAt: number; stale: boolean } | null> {
  try {
    const { grid: g, stale } = await fetchGridForecast()
    grid = g
    gridStale = stale
    withMap((map) => {
      addLayers(map)
      render(map)
    })
    return { fetchedAt: g.fetchedAt, stale }
  } catch {
    return null
  }
}

export function weatherGridInfo(): { fetchedAt: number; stale: boolean } | null {
  return grid ? { fetchedAt: grid.fetchedAt, stale: gridStale } : null
}

/** Wire the layer into the map + store. Call once at startup. */
export function initWeatherLayer() {
  withMap((map) => {
    addLayers(map)
    render(map)
  })

  useAppStore.subscribe((s, prev) => {
    if (s.layers.weather !== prev.layers.weather || s.weatherHour !== prev.weatherHour) {
      withMap(render)
      // first enable → fetch if we have nothing yet
      if (s.layers.weather && !grid) void refreshWeatherGrid()
    }
  })
}
