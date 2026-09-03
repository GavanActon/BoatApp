import type { Feature, FeatureCollection } from 'geojson'
import maplibregl, { type GeoJSONSource, type Map as MlMap } from 'maplibre-gl'
import { getMap, onEachMap, withMap } from '../map/mapController'
import { useAppStore } from '../state/appStore'
import { agoLabel, timeLabel } from '../time'
import { distanceUnitFor, knToUnit, runDistance, speedUnitLabel } from '../units'
import { friendBoats, useCircleStore, type Boat } from './store'
import { onCirclePoll } from './sync'

/**
 * Friends on the chart. Each boat in the circle that is out is a small
 * hollow glyph in the own-boat blue with its name and the age of its
 * position beside it — the same honesty rule as every weather surface: a
 * position under 15 min is solid, older is hollow and says how old, and
 * after two hours it leaves the chart (it stays in the Boats out list).
 *
 * A friend under way toward a spot also draws their plotted course as a
 * faint dashed line, so you see them COMING across the bay, not a dot.
 * Tapping a glyph opens its card: who, where they're going, when.
 */

const STALE_MS = 15 * 60_000
const GONE_MS = 2 * 3600_000
const HIT_PAD = 22
const BLUE = '#3fc8ff'

let layersOn: MlMap | null = null
let popup: maplibregl.Popup | null = null

function emptyFc(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] }
}

function addLayers(map: MlMap) {
  if (layersOn === map || !map.getStyle()) return
  map.addSource('circle-routes', { type: 'geojson', data: emptyFc() })
  map.addSource('circle-boats', { type: 'geojson', data: emptyFc() })

  // under the run's own line, so a shared spot's approaches don't cover it
  const before = map.getLayer('route-line-casing') ? 'route-line-casing' : undefined
  map.addLayer(
    {
      id: 'circle-route',
      type: 'line',
      source: 'circle-routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': BLUE,
        'line-width': 1.6,
        'line-opacity': 0.4,
        'line-dasharray': [2, 2.5],
      },
    },
    before,
  )
  map.addLayer({
    id: 'circle-boat',
    type: 'circle',
    source: 'circle-boats',
    paint: {
      'circle-radius': 7,
      'circle-color': BLUE,
      // solid when fresh, hollow when the position has aged
      'circle-opacity': ['case', ['get', 'stale'], 0, 0.85],
      'circle-stroke-color': BLUE,
      'circle-stroke-width': 2,
      'circle-stroke-opacity': ['case', ['get', 'stale'], 0.6, 1],
    },
  })
  map.addLayer({
    id: 'circle-boat-name',
    type: 'symbol',
    source: 'circle-boats',
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10.5,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': 'rgba(233, 242, 250, 0.95)',
      'text-halo-color': 'rgba(8, 20, 34, 0.9)',
      'text-halo-width': 1.4,
    },
  })
  layersOn = map
}

function nmBetween(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const R = 3440.065
  const toR = Math.PI / 180
  const dLat = (bLat - aLat) * toR
  const dLon = (bLon - aLon) * toR
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** The age of a friend's position — the fix time when they sent one, else
 *  when the server took the record. */
export function boatAgeMs(b: Boat, now = Date.now()): number {
  return now - (b.fixTs ?? b.updated)
}

/** "coming to The Sandies · about 1:40 · 4 nm out" — the card's and the
 *  list's one line about what a friend is doing. Facts only. */
export function describeBoat(b: Boat): string {
  const { speedUnit } = useAppStore.getState()
  const t = b.trip
  const dest = t?.dest?.name ?? 'a pinned spot'
  if (!t || t.state === 'out') {
    return b.sogKn != null && b.sogKn >= 1
      ? `out · ${Math.round(knToUnit(speedUnit, b.sogKn))} ${speedUnitLabel(speedUnit)}`
      : 'out'
  }
  if (t.state === 'coming') {
    const parts = [`coming to ${dest}`]
    if (t.etaMs != null) parts.push(`about ${timeLabel(t.etaMs)}`)
    if (t.dest && b.lon != null && b.lat != null) {
      const nm = nmBetween(b.lon, b.lat, t.dest.lon, t.dest.lat)
      parts.push(`${runDistance(speedUnit, nm)} ${distanceUnitFor(speedUnit)} out`)
    }
    return parts.join(' · ')
  }
  if (t.state === 'there') {
    return t.sinceMs != null ? `at ${dest} since ${timeLabel(t.sinceMs)}` : `at ${dest}`
  }
  if (t.state === 'heading-home') {
    const when = t.homeMs ?? t.etaMs
    return when != null ? `heading home · about ${timeLabel(when)}` : 'heading home'
  }
  return 'home'
}

function buildFeatures(): { boats: FeatureCollection; routes: FeatureCollection } {
  const now = Date.now()
  const boats: Feature[] = []
  const routes: Feature[] = []
  for (const b of friendBoats()) {
    if (b.lon == null || b.lat == null) continue
    const age = boatAgeMs(b, now)
    if (age > GONE_MS) continue
    if (b.trip?.state === 'home') continue
    const stale = age > STALE_MS
    boats.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
      properties: {
        deviceId: b.deviceId,
        label: `${b.name} · ${agoLabel(age)}`,
        stale,
      },
    })
    const t = b.trip
    if (t?.route && (t.state === 'coming' || t.state === 'heading-home')) {
      routes.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: t.route },
        properties: { deviceId: b.deviceId },
      })
    }
  }
  return {
    boats: { type: 'FeatureCollection', features: boats },
    routes: { type: 'FeatureCollection', features: routes },
  }
}

function render(map: MlMap) {
  if (layersOn !== map) return
  const { boats, routes } = buildFeatures()
  ;(map.getSource('circle-boats') as GeoJSONSource | undefined)?.setData(boats)
  ;(map.getSource('circle-routes') as GeoJSONSource | undefined)?.setData(routes)
}

/** The friend's boat near a tapped point, or null — exported so the
 *  depth-popup tap handler can stand down when a boat was hit. */
export function circleBoatAt(map: MlMap, point: { x: number; y: number }): Boat | null {
  if (!map.getLayer('circle-boat')) return null
  const feats = map.queryRenderedFeatures(
    [
      [point.x - HIT_PAD, point.y - HIT_PAD],
      [point.x + HIT_PAD, point.y + HIT_PAD],
    ],
    { layers: ['circle-boat', 'circle-boat-name'] },
  )
  let best: Boat | null = null
  let bestD = Infinity
  const boats = friendBoats()
  for (const f of feats) {
    const id = f.properties?.deviceId as string | undefined
    const b = boats.find((x) => x.deviceId === id)
    if (!b || b.lon == null || b.lat == null) continue
    const p = map.project([b.lon, b.lat])
    const d = Math.hypot(p.x - point.x, p.y - point.y)
    if (d < bestD) {
      bestD = d
      best = b
    }
  }
  return best
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
}

function cardHtml(b: Boat): string {
  const who = b.boat ? `${b.name} · ${b.boat}` : b.name
  return (
    `<div class="boat-card">` +
    `<div class="boat-card-who">${esc(who)}</div>` +
    `<div class="boat-card-what">${esc(describeBoat(b))}</div>` +
    `<div class="boat-card-age">position ${esc(agoLabel(boatAgeMs(b)))}</div>` +
    `</div>`
  )
}

/** Open a friend's card at their position (and bring them on screen). */
export function showBoat(b: Boat) {
  const map = getMap()
  if (!map || b.lon == null || b.lat == null) return
  popup?.remove()
  popup = new maplibregl.Popup({
    closeButton: false,
    className: 'depth-popup boat-popup',
    offset: 12,
    maxWidth: 'none',
  })
    .setLngLat([b.lon, b.lat])
    .setHTML(cardHtml(b))
    .addTo(map)
  map.easeTo({ center: [b.lon, b.lat], duration: 600 })
}

let inited = false

/** Call once at startup, after the route layer. */
export function initCircleLayer() {
  if (inited) return
  inited = true
  onEachMap((map) => {
    addLayers(map)
    render(map)
    map.on('click', (e) => {
      const b = circleBoatAt(map, e.point)
      if (b) showBoat(b)
      else popup?.remove()
    })
  })
  onCirclePoll(() => withMap(render))
  useCircleStore.subscribe((s, prev) => {
    if (s.boats !== prev.boats || s.circles !== prev.circles) withMap(render)
  })
  // the age in every label ticks
  setInterval(() => {
    if (document.visibilityState === 'visible') withMap(render)
  }, 30_000)
}
