import { useRouteStore } from '../routing/routeStore'
import { useAppStore } from '../state/appStore'
import { usePlacesStore } from '../state/placesStore'
import { useGpsStore } from '../tracking/gpsStore'
import { knToUnit, speedUnitLabel } from '../units'
import { isInstalled } from './install'
import { logView } from './log'
import { useDiscoverStore } from './store'

/**
 * Levels: the set-up path in small chunks. Each chunk is two to four
 * observed facts; finishing a chunk brings you up a level, in any order.
 * Only things worth changing are here — a default that suits most boats
 * (units, the ramp's scale) is not a task.
 *
 * Discover POINTS, it never hosts: every row takes you to the real
 * control, so that is where you learn it lives. A row that has a value
 * wears it, so the state is visible without leaving.
 */

export type RowAction =
  | 'locate'
  | 'pickHome'
  | 'guide'
  | 'sandies'
  | 'cruise'
  | 'units'
  | 'settings'
  | 'places'
  | 'chart'
  | 'strip'
  | 'offline'
  | 'install'
  | 'helm'
  | 'tracks'

export interface SetupRow {
  id: string
  label: string
  hint: string
  action: RowAction
  done: boolean
  /** The current value, where the row has one. */
  value?: string
}

export interface Chapter {
  id: string
  name: string
  /** What finishing it gives you — the one sentence a chapter allows itself. */
  reward: string
  rows: SetupRow[]
}

/** The ladder: one name per level, level = chunks finished. Freshwater words. */
export const LEVELS = ['Dock Sitter', 'Deckhand', 'Bay Rat', 'Regular', 'Point Reader', 'Skipper', 'Commodore']

/** The rose's colour by level, in the app's own tokens: the dim text it
 *  sits in until the first level, the accent from then on, and the done
 *  colour at the top of the ladder. Index = level (LEVELS above). */
export const LEVEL_COLORS = [
  'currentColor',
  'var(--c-accent)',
  'var(--c-accent)',
  'var(--c-accent)',
  'var(--c-accent)',
  'var(--c-accent)',
  'var(--c-track)', // Commodore
]

export function chapters(): Chapter[] {
  const app = useAppStore.getState()
  const rs = useRouteStore.getState()
  const places = usePlacesStore.getState()
  const gps = useGpsStore.getState()
  const t = useDiscoverStore.getState().touched
  const log = logView()
  const pins = places.saved.filter((p) => p.name !== places.homeName).length
  const cruise = `${Math.round(knToUnit(app.speedUnit, rs.cruiseKn))} ${speedUnitLabel(app.speedUnit)}`
  return [
    {
      id: 'first-voyage',
      name: 'First voyage',
      reward: 'The chart follows the boat and the first run is on it.',
      rows: [
        { id: 'location', label: 'Allow location', hint: 'the chart follows', action: 'locate', done: gps.status === 'on' || app.gpsWanted },
        { id: 'home', label: 'Star your home dock', hint: 'tap it on the chart', action: 'pickHome', done: places.homeName != null, value: places.homeName ?? undefined },
        // one trip to Settings, before any number is read: seeing where the
        // units live is the task, changing them is optional
        { id: 'units', label: 'Your units', hint: 'Settings › Units', action: 'units', done: !!t.unitsSeen || !!t.units, value: `${app.depthUnit} · ${speedUnitLabel(app.speedUnit)}` },
        { id: 'numbers', label: 'Read the water', hint: 'the numbers guide', action: 'guide', done: app.numbersSeen },
        { id: 'route', label: 'Route to The Sandies', hint: 'the first run', action: 'sandies', done: app.firstRouteDone },
      ],
    },
    {
      id: 'your-boat',
      name: 'Your boat',
      reward: 'Lanes timed to the boat.',
      rows: [{ id: 'cruise', label: 'Cruise speed', hint: 'Settings › Boat', action: 'cruise', done: !!t.cruise, value: cruise }],
    },
    {
      id: 'your-places',
      name: 'Your places',
      reward: 'The chart carries your own names.',
      rows: [
        { id: 'placesRoute', label: 'Route from Places', hint: 'Places › the route button', action: 'places', done: !!t.placesRoute },
        { id: 'pin', label: 'Save a pin', hint: 'tap the water · Save', action: 'chart', done: pins > 0, value: pins ? String(pins) : undefined },
        { id: 'note', label: 'Write a note', hint: 'Places › Edit', action: 'places', done: Object.keys(places.notes).length > 0 },
      ],
    },
    {
      id: 'planning',
      name: 'Planning',
      reward: "The day's windows, out and back.",
      rows: [
        { id: 'hour', label: 'Tap an hour', hint: 'the strip up top', action: 'strip', done: !!t.planTime },
        { id: 'backBy', label: 'Set back-by', hint: 'Trip card › Back', action: 'strip', done: !!t.backBy },
      ],
    },
    {
      id: 'on-the-water',
      name: 'On the water',
      reward: 'Time left, arrival, the ride home.',
      rows: [
        { id: 'trip', label: 'Start a trip', hint: 'Trip card › Start', action: 'chart', done: !!t.tripStart },
        { id: 'helm', label: 'Helm view', hint: 'the helm FAB', action: 'helm', done: !!t.helm },
        { id: 'track', label: 'Record a track', hint: 'Tracks', action: 'tracks', done: log.trackCount > 0, value: log.trackCount ? String(log.trackCount) : undefined },
      ],
    },
    {
      id: 'off-the-grid',
      name: 'Off the grid',
      reward: 'Charts with no bars. A long day on one battery.',
      rows: [
        // first, because it is what KEEPS the download: Safari clears a
        // site's storage after seven days away; a Home Screen app is exempt
        { id: 'install', label: 'Put it on your Home Screen', hint: 'keeps the charts and your crew', action: 'install', done: isInstalled() || !!t.installed },
        { id: 'download', label: 'Download charts', hint: 'Offline', action: 'offline', done: app.offlineReady },
        // beside the charts: both are about the boat being far from anything
        { id: 'lowPower', label: 'Low power', hint: 'Settings › Boat', action: 'settings', done: !!t.lowPower, value: app.lowPower ? 'on' : 'off' },
      ],
    },
  ]
}

export function setupCounts(ch: Chapter[]): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const c of ch) for (const r of c.rows) {
    total++
    if (r.done) done++
  }
  return { done, total }
}

/** Chunks finished = the level. */
export function levelOf(ch: Chapter[]): number {
  return ch.filter((c) => c.rows.every((r) => r.done)).length
}

export function levelName(level: number): string {
  return LEVELS[Math.min(level, LEVELS.length - 1)]
}

/** The chunk to work on: the first unfinished one, in order. */
export function nextChunk(ch: Chapter[]): Chapter | null {
  return ch.find((c) => c.rows.some((r) => !r.done)) ?? null
}
