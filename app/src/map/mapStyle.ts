import { DARK, layers as basemapLayers } from '@protomaps/basemaps'
import type {
  ExpressionSpecification,
  LayerSpecification,
  StyleSpecification,
} from 'maplibre-gl'
import { SATELLITE_URL, SEAMARKS_URL } from '../config'
import type { DepthUnit } from '../state/appStore'

/** Depth label expression: contour levels / soundings are metres; format per unit. */
export function depthLabelExpr(unit: DepthUnit, decimals: boolean): ExpressionSpecification {
  if (unit === 'm') {
    return decimals
      ? [
          'to-string',
          [
            'case',
            ['<', ['get', 'depth'], 10],
            ['/', ['round', ['*', ['get', 'depth'], 10]], 10],
            ['round', ['get', 'depth']],
          ],
        ]
      : ['to-string', ['get', 'depth']]
  }
  return ['to-string', ['round', ['*', ['get', 'depth'], 3.28084]]]
}

/** Marine-tuned flavor: deep navy water so the depth shading reads as one surface. */
const MARINE = {
  ...DARK,
  background: '#0a1522',
  earth: '#182635',
  water: '#0b2033',
  wood_a: '#1a2d38',
  wood_b: '#1a2d38',
  park_a: '#1a2d34',
  park_b: '#1a2d34',
  sand: '#2a3547',
  beach: '#2a3547',
  glacier: '#223040',
}

export interface StyleOpts {
  base: string // import.meta.env.BASE_URL
  showDepth: boolean
  showContours: boolean
  showSeamarks: boolean
  showSatellite: boolean
  satOpacity: number
  satVivid: boolean
  /** which pmtiles sources are reachable (from registerAllDataFiles) */
  available: Set<string>
  /** where the contour + sounding GeoJSON is (a URL the source loads itself), if anywhere */
  contours: string | null
  depthUnit: DepthUnit
}

export function buildMapStyle(opts: StyleOpts): StyleSpecification {
  const base = opts.available.has('basemap')
    ? basemapLayers('basemap', MARINE, { lang: 'en' })
    : ([
        {
          id: 'background',
          type: 'background',
          paint: { 'background-color': MARINE.background },
        },
      ] as LayerSpecification[])

  // Depth raster + contours slot in directly above the water fill, so the
  // crisp vector shoreline (earth/landcover fills) covers the raster's ragged
  // 90 m data edge. Fallback: below the first symbol layer.
  const waterIdx = base.findIndex((l) => l.id === 'water')
  const firstSymbolIdx = base.findIndex((l) => l.type === 'symbol')
  const insertAt =
    waterIdx !== -1 ? waterIdx + 1 : firstSymbolIdx === -1 ? base.length : firstSymbolIdx

  const depthLayers: LayerSpecification[] = [
    {
      id: 'depth-shade',
      type: 'raster',
      source: 'depth',
      layout: { visibility: opts.showDepth ? 'visible' : 'none' },
      paint: {
        'raster-opacity': 0.9,
        'raster-resampling': 'linear',
      },
    },
    {
      id: 'contour-lines',
      type: 'line',
      source: 'contours',
      filter: ['==', ['get', 'kind'], 'contour'],
      layout: { visibility: opts.showContours ? 'visible' : 'none' },
      paint: {
        'line-color': [
          'case',
          ['<=', ['get', 'depth'], 3],
          'rgba(255, 138, 128, 0.55)', // shallow-water warning tint
          'rgba(148, 209, 245, 0.35)',
        ],
        'line-width': ['case', ['==', ['%', ['get', 'depth'], 10], 0], 1.4, 0.7],
      },
    },
    {
      id: 'contour-labels',
      type: 'symbol',
      source: 'contours',
      filter: ['==', ['get', 'kind'], 'contour'],
      minzoom: 10,
      layout: {
        visibility: opts.showContours ? 'visible' : 'none',
        'symbol-placement': 'line',
        'text-field': depthLabelExpr(opts.depthUnit, false),
        'text-font': ['Noto Sans Regular'],
        'text-size': 10,
        'symbol-spacing': 350,
      },
      paint: {
        'text-color': 'rgba(190, 226, 250, 0.85)',
        'text-halo-color': 'rgba(8, 24, 40, 0.9)',
        'text-halo-width': 1.2,
      },
    },
    {
      id: 'soundings',
      type: 'symbol',
      source: 'contours',
      filter: ['==', ['get', 'kind'], 'sounding'],
      minzoom: 12,
      layout: {
        visibility: opts.showContours ? 'visible' : 'none',
        'text-field': depthLabelExpr(opts.depthUnit, true),
        'text-font': ['Noto Sans Italic'],
        'text-size': 10.5,
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': 'rgba(170, 214, 242, 0.75)',
        'text-halo-color': 'rgba(8, 24, 40, 0.75)',
        'text-halo-width': 1,
      },
    },
  ]

  // Satellite sits above every vector fill (real imagery of land and water) but
  // below contours, soundings, basemap labels and seamarks, so chart info stays
  // readable on top. Opacity is user-adjustable to blend imagery with the chart.
  //
  // Quiet land, living water: the default treatment desaturates and dims the
  // imagery hard, so land reads as "shore" and the contrast budget belongs to
  // the layers that carry decisions — depth, sea state, the run. Vivid mode
  // restores true colour for reading a beach or an anchorage.
  const satelliteLayer: LayerSpecification = {
    id: 'satellite',
    type: 'raster',
    source: 'satellite',
    layout: { visibility: opts.showSatellite ? 'visible' : 'none' },
    paint: {
      'raster-opacity': opts.satOpacity,
      'raster-resampling': 'linear',
      ...satTreatment(opts.satVivid),
    },
  }

  const seamarkLayer: LayerSpecification = {
    id: 'seamarks',
    type: 'raster',
    source: 'seamarks',
    minzoom: 9,
    layout: { visibility: opts.showSeamarks ? 'visible' : 'none' },
    paint: { 'raster-opacity': 1 },
  }

  const symbolsAt = firstSymbolIdx === -1 ? base.length : Math.max(firstSymbolIdx, insertAt)
  const allLayers = [
    ...base.slice(0, insertAt),
    ...(opts.available.has('depth') ? [depthLayers[0]] : []),
    ...base.slice(insertAt, symbolsAt),
    satelliteLayer,
    ...(opts.contours ? depthLayers.slice(1) : []),
    ...base.slice(symbolsAt),
    seamarkLayer,
    // track + weather layers are added at runtime on top
  ]

  const sources: StyleSpecification['sources'] = {
    // baked regional archive when reachable (offline-capable), else live Esri
    // tiles — different sources, so each carries its own credit
    satellite: opts.available.has('satellite')
      ? {
          type: 'raster',
          url: 'pmtiles://satellite',
          tileSize: 256,
          // The archive goes to z14, but z14 is Sentinel-2's 10 m pixels
          // upsampled — it carries nothing z13 lacks. Stopping at 13 draws
          // the same picture from a quarter of the tiles: at a pitched helm
          // view that is the difference between 35 satellite textures in
          // flight and about a dozen.
          maxzoom: 13,
          attribution: 'Contains modified Copernicus Sentinel data 2023',
        }
      : {
          type: 'raster',
          tiles: [SATELLITE_URL],
          tileSize: 256,
          maxzoom: 19,
          attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
        },
  }
  if (opts.available.has('basemap')) {
    sources.basemap = {
      type: 'vector',
      url: 'pmtiles://basemap',
      attribution: '© OpenStreetMap · Bathymetry: NOAA NCEI',
    }
  }
  if (opts.available.has('depth')) {
    sources.depth = { type: 'raster', url: 'pmtiles://depth', tileSize: 256 }
  }
  if (opts.contours) {
    // a URL, not the parsed object: the source fetches and parses the 2.4 MB
    // itself once the map exists, so the chart no longer waits on it
    sources.contours = { type: 'geojson', data: opts.contours }
  }
  // Last on purpose: MapLibre asks sources for tiles in this order through
  // one small image queue, and the seamarks come over the network. Behind
  // the local archives, a slow cell link can no longer hold the chart's
  // own imagery back. (The layer order is set above and does not change.)
  sources.seamarks = {
    type: 'raster',
    tiles: [SEAMARKS_URL],
    tileSize: 256,
    attribution: 'Seamarks © OpenSeaMap',
  }

  return {
    version: 8,
    glyphs: `${opts.base}fonts/{fontstack}/{range}.pbf`,
    sprite: `${new URL(opts.base + 'sprites/v4/dark', window.location.href)}`,
    sources,
    layers: allLayers,
  }
}

/** The satellite's two moods — quiet chart furniture, or true colour. */
export function satTreatment(vivid: boolean): {
  'raster-saturation': number
  'raster-brightness-max': number
  'raster-contrast': number
} {
  return vivid
    ? { 'raster-saturation': 0, 'raster-brightness-max': 1, 'raster-contrast': 0 }
    : { 'raster-saturation': -0.85, 'raster-brightness-max': 0.55, 'raster-contrast': -0.05 }
}
