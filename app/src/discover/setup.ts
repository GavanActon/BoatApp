import { useAppStore } from '../state/appStore'
import { usePlacesStore } from '../state/placesStore'
import { useGpsStore } from '../tracking/gpsStore'
import { logView } from './log'
import { useDiscoverStore } from './store'

/**
 * Levels: the set-up path in small chunks. Each chunk is two to four
 * observed facts; finishing a chunk brings you up a level, in any order.
 * Only things worth changing are here — a default that suits most boats
 * (units, the ramp's scale) is not a task.
 */

export type RowAction =
  | 'locate'
  | 'pickHome'
  | 'guide'
  | 'sandies'
  | 'places'
  | 'chart'
  | 'strip'
  | 'offline'
  | 'helm'
  | 'tracks'
  | 'inline'

export interface SetupRow {
  id: string
  label: string
  hint: string
  action: RowAction
  done: boolean
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

export function chapters(): Chapter[] {
  const app = useAppStore.getState()
  const places = usePlacesStore.getState()
  const gps = useGpsStore.getState()
  const t = useDiscoverStore.getState().touched
  const log = logView()
  const pins = places.saved.filter((p) => p.name !== places.homeName).length
  return [
    {
      id: 'first-voyage',
      name: 'First voyage',
      reward: 'The chart follows the boat and the first run is on it.',
      rows: [
        { id: 'location', label: 'Allow location', hint: 'the chart follows', action: 'locate', done: gps.status === 'on' || app.gpsWanted },
        { id: 'home', label: 'Star your home dock', hint: 'tap it on the chart', action: 'pickHome', done: places.homeName != null },
        { id: 'numbers', label: 'Read the water', hint: 'the numbers guide', action: 'guide', done: app.numbersSeen },
        { id: 'route', label: 'Route to The Sandies', hint: 'the first run', action: 'sandies', done: app.firstRouteDone },
      ],
    },
    {
      id: 'your-boat',
      name: 'Your boat',
      reward: 'Limit dots on every place. Lanes timed to the boat.',
      rows: [
        { id: 'cruise', label: 'Cruise speed', hint: 'Trip card › speed chip', action: 'inline', done: !!t.cruise },
        { id: 'limits', label: 'Your limits', hint: 'Places › My limits', action: 'inline', done: app.waveLimitM != null },
      ],
    },
    {
      id: 'your-places',
      name: 'Your places',
      reward: 'The chart carries your own names.',
      rows: [
        { id: 'pin', label: 'Save a pin', hint: 'tap the water · Save', action: 'chart', done: pins > 0 },
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
        { id: 'track', label: 'Record a track', hint: 'Tracks', action: 'tracks', done: log.trackCount > 0 },
      ],
    },
    {
      id: 'off-the-grid',
      name: 'Off the grid',
      reward: 'Charts with no bars.',
      rows: [{ id: 'download', label: 'Download charts', hint: 'Offline', action: 'offline', done: app.offlineReady }],
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
