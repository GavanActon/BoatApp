// Central place for region + data-file configuration.
// Adding a new cruising area = add its files here and regenerate with the pipeline.

/**
 * Where the app looks when it has nothing better: no GPS fix, no starred home
 * base, no saved view. The last link in every `homeCenter() ?? HOME.center`
 * chain — the opening chart, the outlook strip's forecast, the Here row.
 *
 * Batchawana Bay, Gavan's pick. It is water, it is inside the region, and it
 * is somewhere you would actually go — the middle of Whitefish Bay was none
 * of the second two.
 *
 * Routing does NOT use this: with no fix and no home base it still asks
 * rather than plan a trip from a guess (see planner's NO_START_MSG).
 */
export const HOME = {
  // Batchawana Bay — 0.5 km from charted water, well inside the region
  center: [-84.52, 46.93] as [number, number],
  zoom: 10.5,
}

// Where the chart data lives. Same-origin by default; a build may point it
// elsewhere (the discover trial on Cloudflare Pages serves from sandies.app,
// whose 25+ MiB pmtiles exceed the Pages per-file limit — GitHub Pages
// answers with `Access-Control-Allow-Origin: *` and byte ranges, so the
// map, the depth grid and the offline download all work cross-origin).
export const DATA_BASE: string = import.meta.env.VITE_DATA_BASE ?? `${import.meta.env.BASE_URL}data/`

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
  { key: 'satellite', file: 'satellite-superior-east.pmtiles', kind: 'raster', label: 'Satellite' },
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
      'Base map, satellite imagery, depth shading and contours for eastern Lake Superior — Île Parisienne, Goulais Bay, Batchawana Bay, the Soo, ' +
      'the St. Marys River down to St. Joseph Island, and the coast north to Montreal River and Agawa.',
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
  south: 46.0,
  east: -83.55,
  north: 47.5,
}

/**
 * How far the camera may wander: exactly the region, the area the depth grid
 * covers. Beyond it the global fallbacks (Esri imagery, OpenSeaMap) keep
 * rendering a plausible-looking map with no depth data behind it, so even a
 * shoulder of open panning quietly implies coverage we don't have (Gavan,
 * 2026-09-04: the box stops where the bathymetry stops). A fitBounds that
 * pads past the edge is clamped by the map, not fought.
 * When a second region ships, compute this as the union of installed bundles.
 */
export const MAX_BOUNDS: [[number, number], [number, number]] = [
  [REGION_BBOX.west, REGION_BBOX.south],
  [REGION_BBOX.east, REGION_BBOX.north],
]

/**
 * The nearest point of the chart to a position: a fix outside the bounds —
 * the drive to the ramp, a run past the region's edge — puts the map at the
 * closest spot the chart covers, never off it (Gavan, 2026-09-04). The map
 * then nudges that edge point inward so the viewport itself stays on the
 * chart. `clamped` says the position was outside.
 */
export function nearestInBounds(lon: number, lat: number): {
  center: [number, number]
  clamped: boolean
} {
  const [[w, s], [e, n]] = MAX_BOUNDS
  const center: [number, number] = [Math.min(Math.max(lon, w), e), Math.min(Math.max(lat, s), n)]
  return { center, clamped: center[0] !== lon || center[1] !== lat }
}

export const SEAMARKS_URL = 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'

/** Esri World Imagery — online fallback when the baked satellite PMTiles is
 *  unreachable (note z/y/x tile order). */
export const SATELLITE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

export interface DestinationDef {
  name: string
  lon: number
  lat: number
  /** Shown on the home card and in the spots list without being asked for.
   *  Keep this to five or six — the card only has room for that many. */
  watch?: boolean
  /** Local knowledge, written by hand. The model can tell you a height; only
   *  someone who boats here can tell you why this spot gets it. Shown under
   *  the name wherever the spot has room for a second line. */
  note?: string
  /** Sorting hint for the spots list: sheltered places above exposed ones.
   *  Nothing computes this — it's a judgement about geography, not weather. */
  exposed?: boolean
}

/** Preset day-trip destinations. Points get snapped to navigable water by the router.
 *  The first entry is the default trip on a fresh install. */
export const DESTINATIONS: DestinationDef[] = [
  {
    name: 'The Sandies',
    lon: -84.6495,
    lat: 46.8056,
    watch: true,
    note: 'In the lee of the point until the wind goes north of west',
  },
  {
    name: 'Île Parisienne',
    lon: -84.755,
    lat: 46.685,
    watch: true,
    exposed: true,
    note: 'Open to the north — builds here first and drops here last',
  },
  {
    name: 'Batchawana Bay',
    lon: -84.52,
    lat: 46.93,
    watch: true,
    note: 'Inside the bay, sheltered from anything west',
  },
  { name: 'Goulais Bay', lon: -84.44, lat: 46.7, note: 'Tucked in behind the point, south end' },
  {
    name: 'Gros Cap',
    lon: -84.62,
    lat: 46.53,
    watch: true,
    note: 'South and in the lee of the shore in a northwester',
  },
  {
    name: 'Pancake Bay',
    lon: -84.7,
    lat: 46.97,
    watch: true,
    exposed: true,
    note: 'Wide open to the northwest',
  },
  {
    name: 'Whitefish Point',
    lon: -84.95,
    lat: 46.77,
    exposed: true,
    note: 'Open lake — nothing between here and Michipicoten',
  },
]

/** The places the home card and the spots sheet report on without being asked. */
export const WATCHED_SPOTS: DestinationDef[] = DESTINATIONS.filter((d) => d.watch)
