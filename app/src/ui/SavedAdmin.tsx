import { useCallback, useEffect, useState } from 'react'
import { applySavedTrip, useRouteStore } from '../routing/routeStore'
import { useAppStore } from '../state/appStore'
import { db, type SavedStart, type SavedTrip } from '../tracking/db'
import { knToUnit, speedUnitLabel } from '../units'
import { IconCheck, IconLocate, IconPin, IconRoute, IconStar, IconTrash } from './icons'

/**
 * The tail of the Places sheet: pick-on-map for the two ends of a run, and
 * the saved trips and start points — kept, renamed, deleted, used.
 *
 * This is what survived of the route drawer's admin when the drawer retired.
 * It is deliberately small: choosing a destination is the spots list's job,
 * and everything here is bookkeeping around it. Tapping a name edits it in
 * place; the row's route/pin button is what puts the thing back on the map.
 */
export default function SavedAdmin() {
  const setSheetTab = useAppStore((s) => s.setSheetTab)
  const setDetent = useAppStore((s) => s.setDetent)
  const speedUnit = useAppStore((s) => s.speedUnit)
  const destination = useRouteStore((s) => s.destination)
  const setDestination = useRouteStore((s) => s.setDestination)
  const startPoint = useRouteStore((s) => s.startPoint)
  const setStartPoint = useRouteStore((s) => s.setStartPoint)
  const setPicking = useRouteStore((s) => s.setPicking)
  const setCard = useRouteStore((s) => s.setCard)
  const viaPoints = useRouteStore((s) => s.viaPoints)
  const roundTrip = useRouteStore((s) => s.roundTrip)
  const cruiseKn = useRouteStore((s) => s.cruiseKn)
  const stayMin = useRouteStore((s) => s.stayMin)
  const backByHour = useRouteStore((s) => s.backByHour)

  const [saved, setSaved] = useState<SavedTrip[]>([])
  const [justSaved, setJustSaved] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const reloadSaved = useCallback(() => {
    void db.trips.orderBy('createdAt').reverse().toArray().then(setSaved)
  }, [])
  useEffect(() => reloadSaved(), [reloadSaved])

  const [starts, setStarts] = useState<SavedStart[]>([])
  const [editingStartId, setEditingStartId] = useState<number | null>(null)
  const [editStartName, setEditStartName] = useState('')
  const reloadStarts = useCallback(() => {
    void db.starts.orderBy('createdAt').toArray().then(setStarts)
  }, [])
  useEffect(() => reloadStarts(), [reloadStarts])

  function pickOnMap(what: 'start' | 'dest') {
    setPicking(what)
    setSheetTab(null) // get everything out of the way to tap the map
    setDetent('rest') // and come back at rest, looking at what was picked
  }

  /** Turn the map-picked start into a reusable named one. */
  async function saveStart() {
    if (!startPoint) return
    const names = new Set(starts.map((s) => s.name))
    let name = 'Start point'
    for (let n = 2; names.has(name); n++) name = `Start point ${n}`
    await db.starts.add({ name, lon: startPoint.lon, lat: startPoint.lat, createdAt: Date.now() })
    setStartPoint({ name, lon: startPoint.lon, lat: startPoint.lat }) // keeps its name from here on
    reloadStarts()
  }

  async function saveTrip() {
    if (!destination) return
    await db.trips.add({
      name: destination.name ?? 'Pinned spot',
      destName: destination.name,
      lon: destination.lon,
      lat: destination.lat,
      roundTrip,
      cruiseKn,
      stayMin,
      backBy: backByHour,
      vias: viaPoints,
      start: startPoint ? { ...startPoint } : null,
      createdAt: Date.now(),
    })
    reloadSaved()
    setJustSaved(true)
    setTimeout(() => setJustSaved(false), 1600)
  }

  async function commitName(t: SavedTrip) {
    const name = editName.trim()
    setEditingId(null)
    if (name && name !== t.name) {
      await db.trips.update(t.id!, { name })
      // if this trip is the one on the map, rename it there too
      if (destination && destination.lon === t.lon && destination.lat === t.lat) {
        setDestination({ name, lon: t.lon, lat: t.lat })
      }
      reloadSaved()
    }
  }

  async function commitStartName(sp: SavedStart) {
    const name = editStartName.trim()
    setEditingStartId(null)
    if (name && name !== sp.name) {
      await db.starts.update(sp.id!, { name })
      // if it's the start in use, rename it on the map too
      if (startPoint && startPoint.lon === sp.lon && startPoint.lat === sp.lat) {
        setStartPoint({ name, lon: sp.lon, lat: sp.lat })
      }
      reloadStarts()
    }
  }

  async function deleteStart(sp: SavedStart) {
    await db.starts.delete(sp.id!)
    // deleting the start in use falls back to current location
    if (startPoint && startPoint.lon === sp.lon && startPoint.lat === sp.lat) setStartPoint(null)
    reloadStarts()
  }

  return (
    <div className="saved-admin">
      <div className="tb-chips saved-pick">
        <button className="dest-chip dest-pick" onClick={() => pickOnMap('dest')}>
          <IconPin size={14} /> Destination
        </button>
        <button className="dest-chip dest-pick" onClick={() => pickOnMap('start')}>
          <IconPin size={14} /> Start point
        </button>
        {startPoint && (
          <button className="dest-chip" onClick={() => setStartPoint(null)}>
            <IconLocate size={13} /> Current location
          </button>
        )}
        {startPoint && !startPoint.name && (
          <button className="dest-chip dest-save-start" onClick={() => void saveStart()}>
            <IconStar size={12} /> Save start
          </button>
        )}
      </div>

      {(destination || saved.length > 0 || starts.length > 0) && (
        <div className="saved-head">
          <span className="panel-section">Saved</span>
          {destination && (
            <span className="saved-actions">
              <button className="linklike" onClick={() => void saveTrip()} disabled={justSaved}>
                {justSaved ? (
                  <>
                    <IconCheck size={13} /> Saved
                  </>
                ) : (
                  'Save trip'
                )}
              </button>
              <button className="linklike danger" onClick={() => setDestination(null)}>
                Clear trip
              </button>
            </span>
          )}
        </div>
      )}

      {saved.map((t) => (
        <div key={t.id} className="row">
          <div className="row-text">
            {editingId === t.id ? (
              <input
                className="trip-name-input"
                value={editName}
                autoFocus
                // A place name is not a login. Left unmarked, iOS reads a bare text
                // field as something it might know about you and lays its AutoFill bar —
                // passwords, cards, addresses — over the sheet the moment a pin is
                // saved and this focuses. Say what the field is and it stays away.
                type="text"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="done"
                name="trip-label"
                autoCapitalize="words"
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => void commitName(t)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setEditingId(null)
                }}
              />
            ) : (
              <button
                className="row-title trip-name"
                onClick={() => {
                  setEditingId(t.id!)
                  setEditName(t.name)
                }}
                aria-label={`Rename ${t.name}`}
              >
                {t.name}
              </button>
            )}
            <span className="row-desc">
              {t.roundTrip ? 'Round trip' : 'One way'} ·{' '}
              {Math.round(knToUnit(speedUnit, t.cruiseKn))} {speedUnitLabel(speedUnit)}
              {t.start ? ` · from ${t.start.name ?? 'a pinned start'}` : ''}
            </span>
          </div>
          <button
            className="icon-btn"
            onClick={() => {
              useAppStore.getState().setPlanPicked(false) // loaded, not yet timed
              applySavedTrip(t)
              setCard('trip')
              setDetent('rest')
              setSheetTab(null) // the point of plotting is seeing the run
            }}
            aria-label={`Plot ${t.name}`}
          >
            <IconRoute size={16} />
          </button>
          <button
            className="icon-btn danger"
            onClick={() => void db.trips.delete(t.id!).then(reloadSaved)}
            aria-label={`Delete ${t.name}`}
          >
            <IconTrash size={16} />
          </button>
        </div>
      ))}

      {starts.map((sp) => (
        <div key={`start-row-${sp.id}`} className="row">
          <div className="row-text">
            {editingStartId === sp.id ? (
              <input
                className="trip-name-input"
                value={editStartName}
                autoFocus
                // A place name is not a login. Left unmarked, iOS reads a bare text
                // field as something it might know about you and lays its AutoFill bar —
                // passwords, cards, addresses — over the sheet the moment a pin is
                // saved and this focuses. Say what the field is and it stays away.
                type="text"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="done"
                name="start-label"
                autoCapitalize="words"
                onChange={(e) => setEditStartName(e.target.value)}
                onBlur={() => void commitStartName(sp)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setEditingStartId(null)
                }}
              />
            ) : (
              <button
                className="row-title trip-name"
                onClick={() => {
                  setEditingStartId(sp.id!)
                  setEditStartName(sp.name)
                }}
                aria-label={`Rename ${sp.name}`}
              >
                {sp.name}
              </button>
            )}
            <span className="row-desc">
              Start · {Math.abs(sp.lat).toFixed(3)}°{sp.lat >= 0 ? 'N' : 'S'}{' '}
              {Math.abs(sp.lon).toFixed(3)}°{sp.lon >= 0 ? 'E' : 'W'}
            </span>
          </div>
          <button
            className="icon-btn"
            onClick={() => setStartPoint({ name: sp.name, lon: sp.lon, lat: sp.lat })}
            aria-label={`Start from ${sp.name}`}
          >
            <IconPin size={16} />
          </button>
          <button
            className="icon-btn danger"
            onClick={() => void deleteStart(sp)}
            aria-label={`Delete ${sp.name}`}
          >
            <IconTrash size={16} />
          </button>
        </div>
      ))}
    </div>
  )
}
