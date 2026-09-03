import { useAppStore } from '../state/appStore'
import { usePlacesStore } from '../state/placesStore'
import { useGpsStore } from '../tracking/gpsStore'
import { logView } from './log'
import { useDiscoverStore } from './store'

/**
 * Set up: the chapters. Each row is an observed fact with a two-word hint;
 * tapping a row takes you to the real control (the sheet decides how). The
 * boat chapter's rows are drawn with the control itself, in place.
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
  | 'settings'
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

export function chapters(): Chapter[] {
  const app = useAppStore.getState()
  const places = usePlacesStore.getState()
  const gps = useGpsStore.getState()
  const d = useDiscoverStore.getState()
  const t = d.touched
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
        { id: 'units', label: 'Units', hint: 'Settings › Units', action: 'inline', done: !!t.units },
        { id: 'limits', label: 'Your limits', hint: 'Places › My limits', action: 'inline', done: app.waveLimitM != null },
        { id: 'scale', label: 'Sea-state scale', hint: 'Settings › Weather › Sea-state scale', action: 'inline', done: !!t.scale },
      ],
    },
    {
      id: 'your-places',
      name: 'Your places',
      reward: 'The chart carries your own names.',
      rows: [
        { id: 'pin', label: 'Save a pin', hint: 'tap the water · Save', action: 'chart', done: pins > 0 },
        { id: 'rename', label: 'Name it', hint: 'Places › Edit', action: 'places', done: !!t.rename },
        { id: 'note', label: 'Write a note', hint: 'Places › Edit', action: 'places', done: Object.keys(places.notes).length > 0 },
        { id: 'hide', label: 'Hide one', hint: 'Places › Edit', action: 'places', done: places.hidden.length > 0 },
      ],
    },
    {
      id: 'planning',
      name: 'Planning',
      reward: "The day's windows, out and back.",
      rows: [
        { id: 'hour', label: 'Tap an hour', hint: 'the strip up top', action: 'strip', done: !!t.planTime },
        { id: 'backBy', label: 'Set back-by', hint: 'Trip card › Back', action: 'strip', done: !!t.backBy },
        { id: 'via', label: 'Steer a via', hint: 'the route FAB', action: 'chart', done: !!t.via },
        { id: 'new', label: 'Somewhere new', hint: 'route to another place', action: 'places', done: !!t.newRoute },
      ],
    },
    {
      id: 'on-the-water',
      name: 'On the water',
      reward: 'Time left, arrival, the ride home.',
      rows: [
        { id: 'trip', label: 'Start a trip', hint: 'Trip card › Start', action: 'chart', done: !!t.tripStart },
        { id: 'helm', label: 'Helm view', hint: 'the helm FAB', action: 'helm', done: !!t.helm },
        { id: 'lowPower', label: 'Low power', hint: 'Settings', action: 'settings', done: !!t.lowPower },
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
