import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Circles — the crew. A circle is a small invited group of boats that can
 * see each other on the chart, and who's coming to the spot and when.
 *
 * No accounts. This store holds the three identities the plan names and
 * nothing more: the device key (made once, never shown), the skipper card
 * (how this boat is named to friends), and the circle secrets (holding one
 * IS membership). What the crew is doing lives here too, un-persisted —
 * it is minutes old at best and the server is the source.
 *
 * Three tiers, three consents: being in the crew (the code), a plan (the
 * time pick — where and when, never a position), the boat (cast-off to
 * home). The trip card's one switch turns the last two off for one trip.
 */

export interface Skipper {
  name: string
  boat: string
}

export interface Circle {
  id: string
  name: string
  secret: string
}

export type BoatState = 'out' | 'coming' | 'there' | 'heading-home' | 'home'

export interface BoatTrip {
  dest: { name: string | null; lon: number; lat: number } | null
  etaMs: number | null
  homeMs: number | null
  /** When the boat reached the destination (state 'there'), for "since". */
  sinceMs: number | null
  state: BoatState
  route: [number, number][] | null
}

export interface Boat {
  circleId: string
  deviceId: string
  name: string
  boat: string
  lon: number | null
  lat: number | null
  sogKn: number | null
  cog: number | null
  fixTs: number | null
  trip: BoatTrip | null
  updated: number
}

/** Where and when: a stated intent, not a location. */
export interface Plan {
  dest: { name: string | null; lon: number; lat: number }
  outMs: number
  backMs: number | null
}

/** A member of a circle from the moment they join. */
export interface Member {
  circleId: string
  deviceId: string
  name: string
  boat: string
  joined: number
  plan: Plan | null
  updated: number
}

interface CircleState {
  deviceId: string
  deviceKey: string
  skipper: Skipper
  circles: Circle[]
  /** This trip is being shown to the circles. On by default once there is
   *  a circle (sync.ts keeps it at that default between trips); the trip
   *  card's switch turns one trip off. Persisted so a reload under way
   *  keeps sharing. */
  sharing: boolean
  /** Friends' latest positions, all circles merged, newest first. */
  boats: Boat[]
  /** Everyone in every circle, this device included, oldest member first. */
  members: Member[]
  fetchedAt: number
  fetchError: string | null
  /** When the Crew sheet was last open — the dock's dot is anything newer. */
  crewSeenAt: number
  /** Wants the crew's moments as notifications. On by default — the
   *  browser's permission is the other half, asked on joining. */
  notify: boolean
  setNotify: (v: boolean) => void
  setSkipper: (s: Skipper) => void
  addCircle: (c: Circle) => void
  removeCircle: (id: string) => void
  setSharing: (v: boolean) => void
  setCircle: (circleId: string, boats: Boat[], members: Member[]) => void
  setFetchError: (e: string | null) => void
  markCrewSeen: () => void
}

function hex(bytes: number): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** One record per device across circles: the newest wins. */
function dedupe<T extends { deviceId: string; updated: number }>(list: T[]): T[] {
  const byDevice = new Map<string, T>()
  for (const x of list) {
    const prev = byDevice.get(x.deviceId)
    if (!prev || x.updated > prev.updated) byDevice.set(x.deviceId, x)
  }
  return [...byDevice.values()]
}

export const useCircleStore = create<CircleState>()(
  persist(
    (set) => ({
      deviceId: hex(8),
      deviceKey: hex(16),
      skipper: { name: '', boat: '' },
      circles: [],
      sharing: false,
      boats: [],
      members: [],
      fetchedAt: 0,
      fetchError: null,
      crewSeenAt: 0,
      notify: true,
      setNotify: (notify) => set({ notify }),
      setSkipper: (skipper) => set({ skipper }),
      addCircle: (c) =>
        set((s) => ({ circles: [...s.circles.filter((x) => x.id !== c.id), c] })),
      removeCircle: (id) =>
        set((s) => ({
          circles: s.circles.filter((x) => x.id !== id),
          boats: s.boats.filter((b) => b.circleId !== id),
          members: s.members.filter((m) => m.circleId !== id),
        })),
      setSharing: (sharing) => set({ sharing }),
      // one circle's fresh lists replace that circle's old ones; a boat in
      // two circles shows once, by its newest record
      setCircle: (circleId, boats, members) =>
        set((s) => ({
          boats: dedupe([...s.boats.filter((b) => b.circleId !== circleId), ...boats]).sort(
            (a, b) => b.updated - a.updated,
          ),
          members: dedupe([...s.members.filter((m) => m.circleId !== circleId), ...members]).sort(
            (a, b) => a.joined - b.joined,
          ),
          fetchedAt: Date.now(),
          fetchError: null,
        })),
      setFetchError: (fetchError) => set({ fetchError }),
      markCrewSeen: () => set({ crewSeenAt: Date.now() }),
    }),
    {
      name: 'sandies-circle',
      partialize: (s) => ({
        deviceId: s.deviceId,
        deviceKey: s.deviceKey,
        skipper: s.skipper,
        circles: s.circles,
        sharing: s.sharing,
        crewSeenAt: s.crewSeenAt,
        notify: s.notify,
      }),
    },
  ),
)

/** Each boat its own colour, the same on every phone: by place in the
 *  crew (oldest member first — the order the server gives). None of these
 *  is the own-boat blue, the track green, the amber or the reserved red. */
const BOAT_COLORS = ['#c58bff', '#ff7ac6', '#ffd166', '#a3e635', '#5ec8ff', '#ff9e7a']

export function boatColor(deviceId: string): string {
  const { members } = useCircleStore.getState()
  const i = members.findIndex((m) => m.deviceId === deviceId)
  if (i >= 0) return BOAT_COLORS[i % BOAT_COLORS.length]
  // an older app's boat with no member row: a stable pick from its id
  let h = 0
  for (const c of deviceId) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return BOAT_COLORS[h % BOAT_COLORS.length]
}

/** Friends only: every position the store holds that isn't this device. */
export function friendBoats(): Boat[] {
  const { boats, deviceId } = useCircleStore.getState()
  return boats.filter((b) => b.deviceId !== deviceId)
}

/** Friends only: everyone in the crews but this device. */
export function friendMembers(): Member[] {
  const { members, deviceId } = useCircleStore.getState()
  return members.filter((m) => m.deviceId !== deviceId)
}

/** Something in the crew is newer than the last look at the Crew sheet. */
export function crewChanged(s: CircleState): boolean {
  const since = s.crewSeenAt
  return (
    s.members.some((m) => m.deviceId !== s.deviceId && m.updated > since) ||
    s.boats.some((b) => b.deviceId !== s.deviceId && b.updated > since)
  )
}
