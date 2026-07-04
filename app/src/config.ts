// Central place for region + data-file configuration.
// Adding a new cruising area = add its files here and regenerate with the pipeline.

export const HOME = {
  // Whitefish Bay, NE of Île Parisienne — the Sandies
  center: [-84.58, 46.76] as [number, number],
  zoom: 10.5,
}

export const DATA_BASE = `${import.meta.env.BASE_URL}data/`

/** Map data files (PMTiles). key = pmtiles:// protocol key used in the style. */
export interface DataFileDef {
  key: string
  file: string
  kind: 'vector' | 'raster'
  label: string
}

export const DATA_FILES: DataFileDef[] = [
  { key: 'basemap', file: 'basemap-superior-east.pmtiles', kind: 'vector', label: 'Base map' },
  { key: 'depth', file: 'depth-superior-east.pmtiles', kind: 'raster', label: 'Depth shading' },
]

/** Depth contours + spot soundings (GeoJSON, loaded whole). */
export const CONTOURS_FILE = 'contours-superior-east.json'

/** Compact binary depth grid for instant point lookups (tap readout, depth under boat). */
export const DEPTH_GRID_FILE = 'depthgrid-superior-east.dgrid'

/** Offline bundles shown in the Offline Manager. Sizes filled in from the manifest at runtime. */
export interface BundleDef {
  id: string
  name: string
  description: string
  files: string[] // file names within DATA_BASE
}

export const BUNDLES: BundleDef[] = [
  {
    id: 'superior-east',
    name: 'Whitefish Bay & the Sandies',
    description:
      'Base map, depth shading and contours for eastern Lake Superior — Île Parisienne, Goulais Bay, Batchawana Bay and the Soo.',
    files: [
      ...DATA_FILES.map((d) => d.file),
      'contours-superior-east.json',
      'depthgrid-superior-east.dgrid',
    ],
  },
]

/** Bounding box of the high-detail region (used by pipeline + weather grid clamp). */
export const REGION_BBOX = {
  west: -85.3,
  south: 46.3,
  east: -83.9,
  north: 47.25,
}

export const SEAMARKS_URL = 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'
