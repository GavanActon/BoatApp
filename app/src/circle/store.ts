import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Circles — "Boats out". A circle is a small invited group of boats that
 * can see each other on the chart, and who's coming to the spot and when.
 *
 * No accounts. This store holds the three identities the plan names and
 * nothing more: the device key (made once, never shown), the skipper card
 * (how this boat is named to friends), and the circle secrets (holding one
 * IS membership). Sharing is opt-in PER TRIP and switches itself off when
 * the trip ends. What friends are doing lives here too, un-persisted — it
 * is minutes old at best and the server is the source.
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

interface CircleState {
  deviceId: string
  deviceKey: string
  skipper: Skipper
  circles: Circle[]
  /** This trip is being shown to the circles. Persisted so a reload under
   *  way keeps sharing; cleared when the trip ends. */
  sharing: boolean
  /** Friends' latest records, all circles merged, newest first. */
  boats: Boat[]
  fetchedAt: number
  fetchError: string | null
  setSkipper: (s: Skipper) => void
  addCircle: (c: Circle) => void
  removeCircle: (id: string) => void
  setSharing: (v: boolean) => void
  setBoats: (circleId: string, boats: Boat[]) => void
  setFetchError: (e: string | null) => void
}

function hex(bytes: number): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('')
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
      fetchedAt: 0,
      fetchError: null,
      setSkipper: (skipper) => set({ skipper }),
      addCircle: (c) =>
        set((s) => ({ circles: [...s.circles.filter((x) => x.id !== c.id), c] })),
      removeCircle: (id) =>
        set((s) => ({
          circles: s.circles.filter((x) => x.id !== id),
          boats: s.boats.filter((b) => b.circleId !== id),
        })),
      setSharing: (sharing) => set({ sharing }),
      // one circle's fresh list replaces that circle's old one; a boat in two
      // circles shows once, by its newest record
      setBoats: (circleId, boats) =>
        set((s) => {
          const merged = [...s.boats.filter((b) => b.circleId !== circleId), ...boats]
          const byDevice = new Map<string, Boat>()
          for (const b of merged) {
            const prev = byDevice.get(b.deviceId)
            if (!prev || b.updated > prev.updated) byDevice.set(b.deviceId, b)
          }
          return {
            boats: [...byDevice.values()].sort((a, b) => b.updated - a.updated),
            fetchedAt: Date.now(),
            fetchError: null,
          }
        }),
      setFetchError: (fetchError) => set({ fetchError }),
    }),
    {
      name: 'sandies-circle',
      partialize: (s) => ({
        deviceId: s.deviceId,
        deviceKey: s.deviceKey,
        skipper: s.skipper,
        circles: s.circles,
        sharing: s.sharing,
      }),
    },
  ),
)

/** Friends only: everything the store holds that isn't this device. */
export function friendBoats(): Boat[] {
  const { boats, deviceId } = useCircleStore.getState()
  return boats.filter((b) => b.deviceId !== deviceId)
}
