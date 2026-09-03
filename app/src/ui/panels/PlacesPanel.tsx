import { useEffect, useState } from 'react'
import { HOME } from '../../config'
import type { Map as MlMap } from 'maplibre-gl'
import { withMap } from '../../map/mapController'
import { useRouteStore } from '../../routing/routeStore'
import { useAppStore } from '../../state/appStore'
import { allPlaces, homeCenter, usePlacesStore } from '../../state/placesStore'
import { isAfloat } from '../../routing/router'
import { haversineNm } from '../../routing/waterRouter'
import { db, type SavedStart } from '../../tracking/db'
import { useGpsStore } from '../../tracking/gpsStore'
import { seaColor } from '../../weather/seaState'
import { byCalmest, spotConditionsAt } from '../../weather/spotConditions'
import { ensureWeatherGrid } from '../../weather/weatherLayer'
import { distanceUnitFor, runDistance, speedUnitLabel, windSpeed } from '../../units'
import { IconClose, IconLocate, IconPin, IconPlus, IconRoute, IconSky, IconStar, IconWindArrow } from '../icons'
import LimitsRow from '../LimitsRow'
import SavedAdmin from '../SavedAdmin'

/**
 * The Places sheet — WHICH PLACE, and nothing else (§0.2).
 *
 * This superseded the dock's old "Here" bar: with no run planned the dock is
 * simply gone, and this tab is the list instead — every place the app knows,
 * built-in and saved pins alike, calmest first, each wearing the one number
 * its badge wears on the chart. No "here" row: one shape for every row.
 *
 * Each row is one glance of NOW — name, sky (sun/cloud/rain, a droplet when
 * rain is likely, ⚡ when thunder), how far it is, wind with its arrow, sea
 * on the ramp — sized to its route button, with the
 * route button beside — because the sheet shares the screen with the chart.
 * The days and hours live on the strip: tapping a row LOOKS (chart eases the
 * place into the map above the sheet, which stays up, strip retargets — no
 * trip made), and the wind & wave layer lights, so the detail arrives
 * painted on the water rather than printed in the row. The route button
 * plots the run — clicking route obviously routes. Notes live in edit mode
 * and on the trip card.
 *
 * EDIT flips the whole page: names (pins), notes (every place) and removal
 * (pins deleted; built-ins hidden, restorable in the same mode) — the list
 * is the user's, not the config's. Rows stop being go-buttons while editing:
 * one mode looks around, the other curates.
 */
/** Breathing room above the row being edited: flush to the sheet's top edge
 *  reads as clipped even when nothing is cut off. */
const ROW_AIR_PX = 12

/**
 * How far off centre to place a spot you've asked to look at: the middle of
 * the chart you can actually SEE, between the outlook strip's bottom edge and
 * the top of the sheet.
 *
 * Both edges are read live, so a sheet already swiped up is accounted for and
 * the spot lands in whatever band is left rather than behind the list. Half
 * the sheet height — what this used to be — counts only the sheet, and put
 * the spot up under the strip, where the strip was covering it.
 */
function lookOffsetY(map: MlMap): number {
  const box = map.getContainer().getBoundingClientRect()
  const strip = document.querySelector('.wxstrip')?.getBoundingClientRect()
  const sheet = document.querySelector('.sheet')?.getBoundingClientRect()
  const top = strip ? Math.max(0, strip.bottom - box.top) : 0
  const bottom = sheet ? sheet.top - box.top : box.height
  // a sheet tall enough to swallow the strip leaves no band; centre on what
  // little sits above it rather than aim at a midpoint that is off-screen
  const mid = bottom > top ? (top + bottom) / 2 : bottom / 2
  return mid - box.height / 2
}

export default function PlacesPanel() {
  const setSheetTab = useAppStore((s) => s.setSheetTab)
  const setDetent = useAppStore((s) => s.setDetent)
  const setPlanPicked = useAppStore((s) => s.setPlanPicked)
  const planTimeMs = useAppStore((s) => s.planTimeMs)
  const speedUnit = useAppStore((s) => s.speedUnit)
  const windUnit = useAppStore((s) => s.windUnit)
  const waveLimitM = useAppStore((s) => s.waveLimitM)
  const windLimitKn = useAppStore((s) => s.windLimitKn)
  const seaScale = useAppStore((s) => s.seaScaleM)
  const destination = useRouteStore((s) => s.destination)
  const focusPoint = useRouteStore((s) => s.focusPoint)
  const setDestination = useRouteStore((s) => s.setDestination)
  const setFocusPoint = useRouteStore((s) => s.setFocusPoint)
  const setCard = useRouteStore((s) => s.setCard)
  const startPoint = useRouteStore((s) => s.startPoint)
  // Where the boat is when the sheet OPENS, and not a step after.
  //
  // The distance column is the only thing on this panel that moves with the
  // boat. Subscribing to the fix re-rendered the whole list on every GPS
  // update — once a second under way, and jitter kept it going even tied up.
  // You open this sheet to look and to pick, and a list whose numbers shuffle
  // while you read it is worse than one taken a moment ago. The panel
  // unmounts with the sheet, so the next open takes a fresh reading.
  const [fixAt] = useState(() => {
    const f = useGpsStore.getState().fix
    return f ? { lon: f.lon, lat: f.lat } : null
  })
  const armedSlot = useAppStore((s) => s.armedSlot)
  const setArmedSlot = useAppStore((s) => s.setArmedSlot)
  const saved = usePlacesStore((s) => s.saved)
  const homeName = usePlacesStore((s) => s.homeName)
  const setHome = usePlacesStore((s) => s.setHome)
  const hidden = usePlacesStore((s) => s.hidden)
  const removePlace = usePlacesStore((s) => s.removePlace)
  const renamePlace = usePlacesStore((s) => s.renamePlace)
  const hidePlace = usePlacesStore((s) => s.hidePlace)
  const restorePlace = usePlacesStore((s) => s.restorePlace)
  const setNote = usePlacesStore((s) => s.setNote)
  usePlacesStore((s) => s.notes) // re-render when a note commits

  // re-render once the grid lands — the week bands and numbers read from it
  const [, setGridTick] = useState(0)
  useEffect(() => {
    void ensureWeatherGrid().then(() => setGridTick((t) => t + 1))
  }, [])

  // the saved docks and launches: exactly what an armed From wants, so they
  // ride between the two options and the places. Loaded once per open.
  const [starts, setStarts] = useState<SavedStart[]>([])
  useEffect(() => {
    if (armedSlot !== 'from') return
    void db.starts.orderBy('createdAt').toArray().then(setStarts)
  }, [armedSlot])

  const [editMode, setEditMode] = useState(false)
  // one field in edit at a time: a place's name or its note
  const [editing, setEditing] = useState<{ name: string; field: 'name' | 'note' } | null>(null)
  const [editVal, setEditVal] = useState('')

  // While a field is in edit the phone keyboard covers the bottom half of
  // the screen — and this sheet rests IN that half, so saving a pin used to
  // mean typing blind. Stretch the sheet to full for the duration.
  const setSheetTall = useAppStore((s) => s.setSheetTall)
  useEffect(() => {
    setSheetTall(editing != null)
    return () => setSheetTall(false)
  }, [editing, setSheetTall])

  // Save on the water-tap popup lands here in edit mode with the fresh pin's
  // name selected — you name the spot while you still remember why you tapped
  const pendingEdit = usePlacesStore((s) => s.pendingEdit)
  useEffect(() => {
    if (!pendingEdit) return
    setEditMode(true)
    setEditing({ name: pendingEdit, field: 'name' })
    setEditVal(pendingEdit)
    usePlacesStore.getState().setPendingEdit(null)
  }, [pendingEdit])

  // where you are: the chosen start beats the fix beats the home waters
  const here = startPoint ?? (fixAt ? { name: null, ...fixAt } : null) ?? {
    name: null,
    lon: (homeCenter() ?? HOME.center)[0],
    lat: (homeCenter() ?? HOME.center)[1],
  }

  const savedNames = new Set(saved.map((p) => p.name))
  const rows = spotConditionsAt(planTimeMs ?? Date.now(), waveLimitM, windLimitKn, allPlaces()).sort(
    byCalmest,
  )

  // chips arm, surfaces answer: with a slot armed, a row FILLS it. The home
  // base is starred in Edit, never asked for here.
  const gps = useGpsStore.getState().fix
  const fillSlot = (d: { name: string | null; lon: number; lat: number }) => {
    const rs = useRouteStore.getState()
    if (armedSlot === 'from') {
      rs.setStartPoint({ name: d.name, lon: d.lon, lat: d.lat })
    } else {
      setPlanPicked(false)
      rs.setDestination({ name: d.name, lon: d.lon, lat: d.lat })
      rs.setFocusPoint({ lon: d.lon, lat: d.lat, label: d.name ?? 'Pinned spot' })
      rs.setCard('trip')
    }
    setArmedSlot(null)
    setSheetTab(null) // back to the chart, sentence filled
  }

  // the ROW looks: chart flies there, strip retargets — no trip is made, and
  // the sheet STAYS UP, because looking is comparing: you want the place on
  // the chart and the list still in hand. The location is eased into the map
  // area above the sheet; the route button is right there if looking turns
  // into going.
  // context, not close-up: the place with the water around it, wide enough
  // that the wind & wave layer's arrows and shading read as a picture — 9.5
  // proved too far out, 11 too close; the bay scale sits between
  const LOOK_ZOOM = 10.4

  const look = (d: { name: string; lon: number; lat: number }) => {
    // looking is a deliberate "show me there" — break follow, or the very
    // next GPS fix tugs the camera straight back to the boat (the locate FAB
    // re-follows in one tap). Same rule fitToRoute applies when a run plots.
    useAppStore.getState().setFollow(false)
    setFocusPoint({ lon: d.lon, lat: d.lat, label: d.name })
    // and light the wind & waves — seeing the location IS seeing its weather
    if (!useAppStore.getState().layers.weather) useAppStore.getState().setLayer('weather', true)
    withMap((m) => m.easeTo({ center: [d.lon, d.lat], zoom: LOOK_ZOOM, offset: [0, lookOffsetY(m)] }))
  }

  // the ROUTE button plots the run: destination set, lanes draw, dock fills —
  // and a fresh subject starts at exploring, never planning (§0.4)
  const routeTo = (d: { name: string; lon: number; lat: number }) => {
    setPlanPicked(false)
    setDestination(d)
    setFocusPoint({ lon: d.lon, lat: d.lat, label: d.name })
    setCard('trip')
    setDetent('rest')
    setSheetTab(null) // the point of routing is seeing the run drawn
  }

  // Opened from the trip card (a slot armed), the sheet is that slot's
  // keypad and leads with the two answers no list can hold — where the boat
  // is now, and anywhere on the chart — then the places. Opened direct,
  // none of this shows: just where you stand and the list.
  const afloat = gps != null && isAfloat(gps.lon, gps.lat)
  // a start ashore can't be routed from; a destination is any fix at all
  const hereUsable = gps != null && (armedSlot === 'to' || afloat)
  const hereWhy = !gps ? 'no GPS fix yet' : !hereUsable ? 'not on the water' : 'where the boat is now'
  // under To, the boat's position is only an answer when From is pinned
  // somewhere else — with From automatic, a run to where you already are
  // is no run, so the option stays out
  const showHere = armedSlot === 'from' || startPoint != null
  const useHere = () => {
    if (!gps) return
    const rs = useRouteStore.getState()
    if (armedSlot === 'from') {
      rs.setStartPoint(null) // automatic: the planner resolves to the fix
    } else {
      setPlanPicked(false)
      rs.setDestination({ name: 'My position', lon: gps.lon, lat: gps.lat })
      rs.setFocusPoint({ lon: gps.lon, lat: gps.lat, label: 'My position' })
      rs.setCard('trip')
    }
    setArmedSlot(null)
    setSheetTab(null)
  }
  // the slot stays armed and the sheet gets out of the way: with a slot
  // armed any tap on the water fills it, and the banner up top says so
  const pickOnMap = () => {
    setDetent('rest')
    setSheetTab(null)
  }

  const commit = () => {
    if (!editing) return
    const { name, field } = editing
    const val = editVal.trim()
    setEditing(null)
    if (field === 'note') {
      setNote(name, val)
      return
    }
    if (!val || val === name || rows.some((r) => r.spot.name === val)) return
    renamePlace(name, val)
    // if the pin is the subject, rename it there too
    if (destination?.name === name) setDestination({ name: val, lon: destination.lon, lat: destination.lat })
  }

  const remove = (name: string) => {
    if (savedNames.has(name)) removePlace(name)
    else hidePlace(name) // built-ins hide, and can be restored below
    if (destination?.name === name) {
      setDestination(null)
      setPlanPicked(false) // its trip goes with it, window included
    }
  }

  const editField = (name: string, field: 'name' | 'note', current: string) => {
    setEditing({ name, field })
    setEditVal(current)
  }

  const editInput = (
    <input
      className="trip-name-input"
      value={editVal}
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
      name={editing?.field === 'note' ? 'spot-note' : 'spot-label'}
      autoCapitalize={editing?.field === 'note' ? 'sentences' : 'words'}
      onFocus={(e) => {
        e.currentTarget.select()
        // After the keyboard's slide-in, bring the row up the SHEET — the
        // keyboard owns the bottom half of the screen, and centred is exactly
        // where its top edge lands.
        //
        // Scrolling the sheet's own list, by hand, rather than asking
        // scrollIntoView: that walks every scrollable ancestor and takes the
        // document with it, so on the phone the whole app rode up under the
        // address bar and the row came to rest clipped against the top. And a
        // little air above it, because flush to the edge reads as cut off even
        // when it isn't.
        const el = e.currentTarget
        setTimeout(() => {
          const body = el.closest('.sheet-body')
          const row = el.closest('.place-row') ?? el
          if (!body) return
          const top = row.getBoundingClientRect().top - body.getBoundingClientRect().top
          body.scrollTo({ top: Math.max(0, body.scrollTop + top - ROW_AIR_PX), behavior: 'smooth' })
        }, 300)
      }}
      onChange={(e) => setEditVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setEditing(null)
      }}
    />
  )

  return (
    <div className="places-panel">
      {armedSlot && (
        <div className="slot-head">
          <span className="slot-q">{armedSlot === 'from' ? 'From?' : 'To?'}</span>
          <div className="place-list">
            {showHere && (
              <button
                className="place-go place-opt"
                disabled={!hereUsable}
                onClick={useHere}
                aria-label={`Current location — ${hereWhy}`}
              >
                <span className="pg-top">
                  <IconLocate size={14} />
                  <span className="nm">Current location</span>
                </span>
                {!hereUsable && <span className="pg-info">{hereWhy}</span>}
              </button>
            )}
            <button className="place-go place-opt" onClick={pickOnMap} aria-label="Pick on map — tap the chart">
              <span className="pg-top">
                <IconPin size={14} />
                <span className="nm">Pick on map</span>
              </span>
            </button>
            {armedSlot === 'from' &&
              starts.map((sp) => (
                <button
                  key={`start-${sp.id}`}
                  className="place-go"
                  onClick={() => fillSlot({ name: sp.name, lon: sp.lon, lat: sp.lat })}
                  aria-label={`Start from ${sp.name}`}
                >
                  <span className="pg-top">
                    <span className="pg-pin">
                      <IconPin size={14} />
                    </span>
                    <span className="nm">{sp.name}</span>
                  </span>
                  <span className="pg-info">saved start</span>
                </button>
              ))}
          </div>
        </div>
      )}
      {!armedSlot && (
        <div className="places-tools">
          <button
            className="linklike"
            onClick={() => {
              setEditing(null)
              setEditMode(!editMode)
            }}
          >
            {editMode ? 'Done' : 'Edit'}
          </button>
        </div>
      )}

      {!editMode || armedSlot ? (
        <div className="place-list">
          {rows.map((r) => (
            <div
              key={r.spot.name}
              // the highlight follows where you're LOOKING (the strip's focus),
              // not where a trip happens to be routed — routing sets focus too,
              // so a plotted trip stays lit until you look elsewhere
              className={`place-row${
                (focusPoint ? focusPoint.label === r.spot.name : destination?.name === r.spot.name)
                  ? ' place-current'
                  : ''
              }`}
            >
              <button
                className="place-go"
                onClick={() =>
                  armedSlot
                    ? fillSlot({ name: r.spot.name, lon: r.spot.lon, lat: r.spot.lat })
                    : look({ name: r.spot.name, lon: r.spot.lon, lat: r.spot.lat })
                }
                aria-label={
                  `Look at ${r.spot.name}${r.waveM != null ? `, ${r.waveM.toFixed(1)} metres` : ', no wave data'}` +
                  (r.clears ? ', inside your limits' : '')
                }
              >
                <span className="pg-top">
                  <span className="nm">
                    {r.clears && <i className="spot-clear" aria-hidden="true" />}
                    {r.spot.name}
                    {homeName === r.spot.name && (
                      <em className="pg-home" title="Home base" aria-label="home base">
                        <IconStar size={11} />
                      </em>
                    )}
                  </span>
                  <span className="pg-sky" aria-hidden="true">
                    {r.precipProbPct != null && r.precipProbPct >= 40 && <em className="pg-wet">💧</em>}
                    {r.weatherCode != null && r.weatherCode >= 95 && <em className="wx-bolt">⚡</em>}
                    {r.weatherCode != null && <IconSky code={r.weatherCode} size={14} />}
                  </span>
                </span>
                <span className="pg-info numeral">
                  {runDistance(speedUnit, haversineNm(here.lon, here.lat, r.spot.lon, r.spot.lat))}{' '}
                  {distanceUnitFor(speedUnit)}
                  {r.windKn != null && (
                    <>
                      {' · '}
                      {r.windDir != null && <IconWindArrow deg={r.windDir + 180} size={11} />}
                      {windSpeed(windUnit, r.windKn)} {speedUnitLabel(windUnit)}
                    </>
                  )}
                  {r.waveM != null && (
                    <>
                      {' · '}
                      <b style={{ color: seaColor(r.waveM, seaScale) }}>{r.waveM.toFixed(1)} m</b>
                    </>
                  )}
                </span>
              </button>
              {!armedSlot && (
                <button
                  className="icon-btn place-route"
                  onClick={() => routeTo({ name: r.spot.name, lon: r.spot.lon, lat: r.spot.lat })}
                  aria-label={`Route to ${r.spot.name}`}
                >
                  <IconRoute size={20} />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="place-list">
          {/* the row in edit rides to the TOP: the phone keyboard owns the
              bottom half of the screen, and at full sheet height the list
              doesn't scroll — position is the only way to stay visible */}
          {(editing
            ? [...rows].sort((a, b) =>
                a.spot.name === editing.name ? -1 : b.spot.name === editing.name ? 1 : 0,
              )
            : rows
          ).map((r) => {
            const isPin = savedNames.has(r.spot.name)
            const editingName = editing?.name === r.spot.name && editing.field === 'name'
            const editingNote = editing?.name === r.spot.name && editing.field === 'note'
            return (
              <div key={r.spot.name} className="place-row place-row-edit">
                {/* the home base star: where trips depart from when the GPS
                    doesn't know better — the dock, the cottage, the rental's
                    launch. One star; starring here moves house. */}
                <button
                  className={`icon-btn pe-star${homeName === r.spot.name ? ' pe-star-on' : ''}`}
                  onClick={() => setHome(homeName === r.spot.name ? null : r.spot.name)}
                  aria-label={
                    homeName === r.spot.name
                      ? `${r.spot.name} is your home base — tap to unset`
                      : `Make ${r.spot.name} your home base`
                  }
                >
                  <IconStar size={15} />
                </button>
                <div className="pe-fields">
                  {editingName ? (
                    editInput
                  ) : isPin ? (
                    <button className="pe-name" onClick={() => editField(r.spot.name, 'name', r.spot.name)}>
                      {r.spot.name}
                    </button>
                  ) : (
                    // a built-in keeps its chart identity — the name is how a
                    // spot is referenced everywhere, so it stays put
                    <span className="pe-name pe-fixed">{r.spot.name}</span>
                  )}
                  {editingNote ? (
                    editInput
                  ) : (
                    <button
                      className={`pe-note${r.spot.note ? '' : ' pe-empty'}`}
                      onClick={() => editField(r.spot.name, 'note', r.spot.note ?? '')}
                    >
                      {r.spot.note ?? 'add a note'}
                    </button>
                  )}
                </div>
                <button
                  className="icon-btn danger"
                  onClick={() => remove(r.spot.name)}
                  aria-label={`Remove ${r.spot.name}`}
                >
                  <IconClose size={13} />
                </button>
              </div>
            )
          })}
          {hidden.map((name) => (
            <div key={`hidden-${name}`} className="place-row place-row-edit place-row-hidden">
              <span className="pe-name pe-fixed">{name}</span>
              <button className="icon-btn" onClick={() => restorePlace(name)} aria-label={`Restore ${name}`}>
                <IconPlus size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {!armedSlot && (
        <>
          <div className="place-hint">tap the chart to add a place</div>
          <LimitsRow />
          <SavedAdmin />
        </>
      )}
    </div>
  )
}
