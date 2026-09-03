import { dateShort, timeLabel, durationLabel } from '../time'
import type { Outing } from '../tracking/db'
import { SEA_BANDS } from '../weather/seaState'
import type { AchIcon } from './icons'
import type { LogView } from './log'
import { SEASON_PLACES, seasonOf } from './season'
import { sunTimes } from './solar'
import type { TouchKey } from './store'

/**
 * The achievements. Every one is a CHECK over observed state — nothing is
 * earned by tapping a row — and every one is visible from day one, the
 * locked ones with a two-word hint of the gesture. That hint is the
 * onboarding.
 *
 * Tone: the Sandies goes like a party. Setup names stay straight; the
 * going names carry a little edge. Freshwater words only.
 *
 * The line: nothing for a rough band, nothing for consecutive days,
 * nothing that rewards drinking on the water.
 */

/** Everything a check may look at, assembled by the engine. */
export interface Ctx {
  now: number
  onboarded: boolean
  homeName: string | null
  savedPlaces: { name: string; lon: number; lat: number }[]
  noteCount: number
  waveLimitM: number | null
  seaScaleM: number
  offlineReady: boolean
  touched: Partial<Record<TouchKey, true>>
  rainChecks: number
  seasonReached: Record<string, number>
  log: LogView
}

export type Facts = [string, string][]

export interface AchievementDef {
  id: string
  name: string
  /** Two words on how it is earned — the locked row's hint. */
  hint: string
  icon: AchIcon
  group: 'setup' | 'going'
  /** Facts when earned, null while not. */
  check: (c: Ctx) => Facts | null
}

const SANDIES = 'The Sandies'
const LATE_MIN = 5
const LATE_FRAC = 0.1
const NOSE_MIN = 2

/** One trip a day counts: four ten-minute out-and-backs are one day out. */
function oneADay(os: Outing[]): Outing[] {
  const seen = new Set<string>()
  return os.filter((o) => {
    const d = new Date(o.startedAt).toDateString()
    if (seen.has(d)) return false
    seen.add(d)
    return true
  })
}

function ended(c: Ctx): Outing[] {
  return oneADay(c.log.outings.filter((o) => o.endedAt != null))
}

function bandName(b: number | null): string {
  return b == null ? '—' : SEA_BANDS[b].name
}

/** Planned vs actual arrival: the margin that makes a difference, in minutes. */
function arrivalDrift(o: Outing): { driftMin: number; marginMin: number } | null {
  if (o.arrivedAt == null || o.plannedArriveMs == null) return null
  const runMin = (o.plannedArriveMs - o.startedAt) / 60_000
  return {
    driftMin: (o.arrivedAt - o.plannedArriveMs) / 60_000,
    marginMin: Math.max(LATE_MIN, runMin * LATE_FRAC),
  }
}

function arrivalFacts(o: Outing): Facts {
  return [
    ['Planned', timeLabel(o.plannedArriveMs!)],
    ['Arrived', timeLabel(o.arrivedAt!)],
    ['Run', o.destName ?? 'Pinned spot'],
  ]
}

function firstOuting(c: Ctx, pred: (o: Outing) => boolean): Outing | undefined {
  return ended(c).find(pred)
}

export const ACHIEVEMENTS: AchievementDef[] = [
  // ---------- setup: straight names ----------
  {
    id: 'all-talk',
    name: 'All Talk',
    hint: 'open the app',
    icon: 'talk',
    group: 'setup',
    check: (c) => (c.onboarded ? [['Opened', dateShort(c.now)]] : null),
  },
  {
    id: 'knows-the-boat',
    name: 'Knows the Boat',
    hint: 'speed and limits',
    icon: 'boat',
    group: 'setup',
    check: (c) =>
      c.touched.cruise && c.waveLimitM != null
        ? [
            ['Wave limit', `${c.waveLimitM.toFixed(1)} m`],
            ['Rough from', `${c.seaScaleM.toFixed(1)} m`],
          ]
        : null,
  },
  {
    id: 'has-a-home',
    name: 'Has a Home',
    hint: 'star home',
    icon: 'home',
    group: 'setup',
    check: (c) => (c.homeName ? [['Home', c.homeName]] : null),
  },
  {
    id: 'cartographer',
    name: 'Cartographer',
    hint: 'five places',
    icon: 'map',
    group: 'setup',
    check: (c) => {
      const n = c.savedPlaces.filter((p) => p.name !== c.homeName).length
      return n >= 5 ? [['Places', String(n)]] : null
    },
  },
  {
    id: 'local-knowledge',
    name: 'Local Knowledge',
    hint: 'write a note',
    icon: 'note',
    group: 'setup',
    check: (c) => (c.noteCount > 0 ? [['Notes', String(c.noteCount)]] : null),
  },
  {
    id: 'points-north',
    name: 'Points North',
    hint: 'tap an hour',
    icon: 'north',
    group: 'setup',
    check: (c) => (c.touched.planTime ? [['Planned', dateShort(c.now)]] : null),
  },
  {
    id: 'ride-home',
    name: 'Ride Home',
    hint: 'set back-by',
    icon: 'back',
    group: 'setup',
    check: (c) => (c.touched.backBy ? [['Set', dateShort(c.now)]] : null),
  },
  {
    id: 'scenic-route',
    name: 'Scenic Route',
    hint: 'steer a via',
    icon: 'via',
    group: 'setup',
    check: (c) => (c.touched.via ? [['Steered', dateShort(c.now)]] : null),
  },
  {
    id: 'off-the-grid',
    name: 'Off the Grid',
    hint: 'download charts',
    icon: 'grid',
    group: 'setup',
    check: (c) => (c.offlineReady ? [['Charts', 'on board']] : null),
  },
  {
    id: 'logbook',
    name: 'Logbook',
    hint: 'ten tracks',
    icon: 'log',
    group: 'setup',
    check: (c) => (c.log.trackCount >= 10 ? [['Tracks', String(c.log.trackCount)]] : null),
  },

  // ---------- going: the edge ----------
  {
    id: 'lines-off',
    name: 'Lines Off',
    hint: 'start a trip',
    icon: 'lines',
    group: 'going',
    check: (c) => {
      const o = c.log.outings[0]
      return o ? [['Cast off', `${dateShort(o.startedAt)} ${timeLabel(o.startedAt)}`]] : null
    },
  },
  {
    id: 'home-sweet-home',
    name: 'Home Sweet Home',
    hint: 'back to the dock',
    icon: 'home',
    group: 'going',
    check: (c) => {
      const o = c.log.outings.find((x) => x.homeAt != null)
      return o ? [['Home', `${dateShort(o.homeAt!)} ${timeLabel(o.homeAt!)}`]] : null
    },
  },
  {
    id: 'bar-tab',
    name: 'Bar Tab',
    hint: 'Sandies ×3',
    icon: 'tab',
    group: 'going',
    check: (c) => {
      const n = c.log.arrivals.filter((a) => a.name === SANDIES).length
      return n >= 3 ? [['Sandies', `${n} days`]] : null
    },
  },
  {
    id: 'you-like-it-here',
    name: 'You Like It Here!',
    hint: 'a second spot ×3',
    icon: 'like',
    group: 'going',
    check: (c) => {
      const counts = new Map<string, number>()
      for (const a of c.log.arrivals) {
        if (a.name === c.homeName) continue
        counts.set(a.name, (counts.get(a.name) ?? 0) + 1)
      }
      const regulars = [...counts.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])
      return regulars.length >= 2 ? [['Spots', regulars.map(([n]) => n).join(' · ')]] : null
    },
  },
  {
    id: 'double-dip',
    name: 'Double Dip',
    hint: 'both Sandies',
    icon: 'dip',
    group: 'going',
    check: (c) => {
      const n = c.seasonReached['sandies-north']
      const s = c.seasonReached['sandies-south']
      return n && s ? [['North', dateShort(n)], ['South', dateShort(s)]] : null
    },
  },
  {
    id: 'lighthouse',
    name: 'Lighthouse',
    hint: 'Parisienne light',
    icon: 'light',
    group: 'going',
    check: (c) => {
      const at = c.seasonReached['parisienne-light']
      return at ? [['Reached', dateShort(at)]] : null
    },
  },
  {
    id: 'laker',
    name: 'Laker',
    hint: '50 nm this season',
    icon: 'laker',
    group: 'going',
    check: (c) =>
      c.log.seasonNm >= 50 ? [['Season', `${Math.round(c.log.seasonNm)} nm`]] : null,
  },
  {
    id: 'last-minute-club',
    name: 'Last Minute Club',
    hint: 'open, go',
    icon: 'club',
    group: 'going',
    check: (c) => {
      const o = c.log.outings.find((x) => x.openedAt != null && x.startedAt - x.openedAt <= 60_000)
      return o ? [['Open to go', `${Math.round((o.startedAt - o.openedAt!) / 1000)} s`]] : null
    },
  },
  {
    id: 'speedsteer',
    name: 'Speedsteer',
    hint: 'beat the plan',
    icon: 'fast',
    group: 'going',
    check: (c) => {
      const o = firstOuting(c, (x) => {
        const d = arrivalDrift(x)
        return d != null && d.driftMin <= -d.marginMin
      })
      return o ? arrivalFacts(o) : null
    },
  },
  {
    id: 'slowpoke',
    name: 'Slowpoke',
    hint: 'miss the plan',
    icon: 'slow',
    group: 'going',
    check: (c) => {
      const o = firstOuting(c, (x) => {
        const d = arrivalDrift(x)
        return d != null && d.driftMin >= d.marginMin
      })
      return o ? arrivalFacts(o) : null
    },
  },
  {
    id: 'on-the-nose',
    name: 'On the Nose',
    hint: 'arrive to the minute',
    icon: 'nose',
    group: 'going',
    check: (c) => {
      const o = firstOuting(c, (x) => {
        const d = arrivalDrift(x)
        return d != null && Math.abs(d.driftMin) <= NOSE_MIN
      })
      return o ? arrivalFacts(o) : null
    },
  },
  {
    id: 'glassy',
    name: 'Glassy',
    hint: 'arrive on flat water',
    icon: 'glassy',
    group: 'going',
    check: (c) => {
      const o = c.log.outings.find((x) => x.arrivedAt != null && x.forecastBand === 0)
      return o ? [['Sea', bandName(0)], ['At', o.destName ?? 'Pinned spot']] : null
    },
  },
  {
    id: 'called-it',
    name: 'Called It',
    hint: 'felt = forecast ×3',
    icon: 'called',
    group: 'going',
    check: (c) => {
      const judged = ended(c).filter((o) => o.feltBand != null && o.forecastBand != null)
      const last = judged.slice(-3)
      if (last.length < 3 || !last.every((o) => o.feltBand === o.forecastBand)) return null
      return [['Trips', '3'], ['Last', bandName(last[2].feltBand)]]
    },
  },
  {
    id: 'got-distracted',
    name: 'Got Distracted',
    hint: 'wander off the run',
    icon: 'distracted',
    group: 'going',
    check: (c) => {
      const o = firstOuting(
        c,
        (x) => x.trackNm != null && x.plannedNm != null && x.plannedNm > 1 && x.trackNm >= 1.5 * x.plannedNm,
      )
      return o ? [['Planned', `${o.plannedNm!.toFixed(1)} nm`], ['Ran', `${o.trackNm!.toFixed(1)} nm`]] : null
    },
  },
  {
    id: 'first-light',
    name: 'First Light',
    hint: 'out before sunrise',
    icon: 'dawn',
    group: 'going',
    check: (c) => {
      const o = c.log.outings.find((x) => {
        const s = sunTimes(x.originLon, x.originLat, x.startedAt)
        return s != null && x.startedAt < s.rise
      })
      return o ? [['Cast off', timeLabel(o.startedAt)]] : null
    },
  },
  {
    id: 'sunburn',
    name: 'Sunburn',
    hint: 'six hours there',
    icon: 'sun',
    group: 'going',
    check: (c) => {
      const o = c.log.outings.find(
        (x) => x.arrivedAt != null && x.leftDestAt != null && x.leftDestAt - x.arrivedAt >= 6 * 3600_000,
      )
      return o
        ? [['There', durationLabel(Math.round((o.leftDestAt! - o.arrivedAt!) / 60_000))], ['At', o.destName ?? 'Pinned spot']]
        : null
    },
  },
  {
    id: 'closing-time',
    name: 'Closing Time',
    hint: 'leave after sunset',
    icon: 'dusk',
    group: 'going',
    check: (c) => {
      // after sunset — or before sunrise, for the ones who left at one in the morning
      const o = c.log.outings.find((x) => {
        if (x.leftDestAt == null) return false
        const s = sunTimes(x.destLon, x.destLat, x.leftDestAt)
        return s != null && (x.leftDestAt > s.set || x.leftDestAt < s.rise)
      })
      return o ? [['Left', timeLabel(o.leftDestAt!)], ['From', o.destName ?? 'Pinned spot']] : null
    },
  },
  {
    id: 'walk-of-shame',
    name: 'Walk of Shame',
    hint: 'home after back-by',
    icon: 'shame',
    group: 'going',
    check: (c) => {
      const o = c.log.outings.find(
        (x) => x.homeAt != null && x.plannedHomeMs != null && x.homeAt - x.plannedHomeMs >= LATE_MIN * 60_000,
      )
      return o ? [['Back-by', timeLabel(o.plannedHomeMs!)], ['Home', timeLabel(o.homeAt!)]] : null
    },
  },
  {
    id: 'designated-skipper',
    name: 'Designated Skipper',
    hint: 'helm view home ×5',
    icon: 'helm',
    group: 'going',
    check: (c) => {
      const n = ended(c).filter((o) => o.helmHome && o.homeAt != null).length
      return n >= 5 ? [['Rides home', String(n)]] : null
    },
  },
  {
    id: 'overdressed',
    name: 'Overdressed',
    hint: 'flat water, high limits',
    icon: 'glassy',
    group: 'going',
    // judged against the limits set THAT day, not today's
    check: (c) => {
      const o = c.log.outings.find(
        (x) => x.arrivedAt != null && x.forecastBand === 0 && x.limitM != null && x.scaleM != null && x.limitM >= x.scaleM,
      )
      return o ? [['Limit', `${o.limitM!.toFixed(1)} m`], ['Sea', bandName(0)]] : null
    },
  },
  {
    id: 'rain-check',
    name: 'Rain Check',
    hint: 'plan, then stay in ×3',
    icon: 'rain',
    group: 'going',
    check: (c) => (c.rainChecks >= 3 ? [['Stayed in', String(c.rainChecks)]] : null),
  },
  {
    id: 'season-ticket',
    name: 'Season Ticket',
    hint: 'every season place',
    icon: 'ticket',
    group: 'going',
    check: (c) => {
      const year = seasonOf(c.now)
      const all = SEASON_PLACES.every((p) => c.seasonReached[p.id] && seasonOf(c.seasonReached[p.id]) === year)
      return all ? [['Season', String(year)], ['Places', String(SEASON_PLACES.length)]] : null
    },
  },
]

export const ACH_BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]))
