import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DESTINATIONS, type DestinationDef } from '../config'

/**
 * The user's own places — points saved off the water-tap popup — plus their
 * edits to the built-in list: places they've removed, and notes they've
 * written or rewritten. A saved pin and a named spot are the same kind of
 * thing from the rest of the app's point of view; there is no second species
 * of place.
 *
 * Built-ins keep their config identity (names are how spots are referenced
 * everywhere), so "removing" one hides it rather than deleting it, and it can
 * always be restored from the sheet's edit mode.
 */

export interface SavedPlace {
  name: string
  lon: number
  lat: number
}

interface PlacesState {
  saved: SavedPlace[]
  /** Built-in place names the user removed from the list and the chart. */
  hidden: string[]
  /** The user's notes, by place name — overrides a built-in's config note. */
  notes: Record<string, string>
  /** Save a point; names itself "Pin", "Pin 2", … — renamed in the sheet. */
  addPlace: (lon: number, lat: number) => SavedPlace
  removePlace: (name: string) => void
  renamePlace: (from: string, to: string) => void
  hidePlace: (name: string) => void
  restorePlace: (name: string) => void
  /** Empty string clears the user's note (a built-in falls back to config). */
  setNote: (name: string, note: string) => void
  /** The place the sheet should open with its name in edit — set by Save on
   *  the water-tap popup, consumed by the sheet. Transient, never persisted. */
  pendingEdit: string | null
  setPendingEdit: (name: string | null) => void
  /**
   * HOME BASE: the name of the place trips depart from when the GPS doesn't
   * know better — the dock, the cottage, the rental's launch. Starred in the
   * sheet's edit mode; null means the app has no opinion and must ask before
   * routing blind. Persisted, because home is the most durable fact there is.
   */
  homeName: string | null
  setHome: (name: string | null) => void
}

export const usePlacesStore = create<PlacesState>()(
  persist(
    (set, get) => ({
      saved: [],
      hidden: [],
      notes: {},
      addPlace: (lon, lat) => {
        const taken = new Set([...DESTINATIONS.map((d) => d.name), ...get().saved.map((p) => p.name)])
        let name = 'Pin'
        for (let n = 2; taken.has(name); n++) name = `Pin ${n}`
        const place = { name, lon, lat }
        set((s) => ({ saved: [...s.saved, place] }))
        return place
      },
      removePlace: (name) =>
        set((s) => {
          const notes = { ...s.notes }
          delete notes[name]
          return {
            saved: s.saved.filter((p) => p.name !== name),
            notes,
            // a removed home base is no home base — never a dangling name
            homeName: s.homeName === name ? null : s.homeName,
          }
        }),
      renamePlace: (from, to) =>
        set((s) => {
          const notes = { ...s.notes }
          if (notes[from] != null) {
            notes[to] = notes[from]
            delete notes[from]
          }
          return {
            saved: s.saved.map((p) => (p.name === from ? { ...p, name: to } : p)),
            notes,
            homeName: s.homeName === from ? to : s.homeName,
          }
        }),
      hidePlace: (name) =>
        set((s) => ({ hidden: s.hidden.includes(name) ? s.hidden : [...s.hidden, name] })),
      restorePlace: (name) => set((s) => ({ hidden: s.hidden.filter((n) => n !== name) })),
      setNote: (name, note) =>
        set((s) => {
          const notes = { ...s.notes }
          if (note.trim()) notes[name] = note.trim()
          else delete notes[name]
          return { notes }
        }),
      pendingEdit: null,
      setPendingEdit: (pendingEdit) => set({ pendingEdit }),
      homeName: null,
      setHome: (homeName) => set({ homeName }),
    }),
    {
      name: 'sandies-places',
      partialize: (s) => ({ saved: s.saved, hidden: s.hidden, notes: s.notes, homeName: s.homeName }),
    },
  ),
)

/** The starred home base, resolved to coordinates — or null when none is
 *  set. Hidden built-ins still count: hiding a spot curates the list, it
 *  doesn't move house. */
export function homeBase(): SavedPlace | null {
  const s = usePlacesStore.getState()
  if (!s.homeName) return null
  const p = [...s.saved, ...DESTINATIONS].find((d) => d.name === s.homeName)
  return p ? { name: p.name, lon: p.lon, lat: p.lat } : null
}

/** Home base as a [lon, lat], for the fallback chains. */
export function homeCenter(): [number, number] | null {
  const h = homeBase()
  return h ? [h.lon, h.lat] : null
}

/** A place's note: the user's own wording wins over the config's. */
export function noteFor(name: string): string | null {
  const s = usePlacesStore.getState()
  return s.notes[name] ?? DESTINATIONS.find((d) => d.name === name)?.note ?? null
}

/** Every place the sheet lists: built-ins the user hasn't removed (wearing
 *  the user's notes where written), then the user's pins. */
export function allPlaces(): DestinationDef[] {
  const s = usePlacesStore.getState()
  const gone = new Set(s.hidden)
  return [
    ...DESTINATIONS.filter((d) => !gone.has(d.name)).map((d) =>
      s.notes[d.name] != null ? { ...d, note: s.notes[d.name] } : d,
    ),
    ...s.saved.map((p) => ({ ...p, note: s.notes[p.name] })),
  ]
}

/** The places that wear a badge on the chart: the watched spots the user
 *  hasn't removed + every pin. (Un-watched built-ins stay in the sheet only —
 *  chart furniture is deliberately sparse.) */
export function badgedPlaces(): DestinationDef[] {
  const s = usePlacesStore.getState()
  const gone = new Set(s.hidden)
  return [...DESTINATIONS.filter((d) => d.watch && !gone.has(d.name)), ...s.saved]
}
