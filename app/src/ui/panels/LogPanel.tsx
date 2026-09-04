import { useEffect, useState } from 'react'
import type { GeoJSONSource, LngLatBounds } from 'maplibre-gl'
import maplibregl from 'maplibre-gl'
import { seasonOf } from '../../discover/season'
import { formatDepth } from '../../map/depthGrid'
import { withMap } from '../../map/mapController'
import { useRouteStore } from '../../routing/routeStore'
import { useAppStore } from '../../state/appStore'
import { track as count } from '../../stats/core'
import { dateShort, dayShort, durationLabel, timeLabel } from '../../time'
import { db, trackSegments, type Mark, type Outing, type Track } from '../../tracking/db'
import { exportTrackGpx } from '../../tracking/gpx'
import { startRecording, stopRecording } from '../../tracking/gpsService'
import { useGpsStore } from '../../tracking/gpsStore'
import { saveLine } from '../../tracking/lines'
import { clearMarksOnMap, deleteMark, marksFor, setMarkNote, showMarksOnMap } from '../../tracking/marks'
import { distanceUnitFor, knToUnit, runDistance, speedUnitLabel } from '../../units'
import { IconShare, IconTrack, IconTrash } from '../icons'

/**
 * The Log: trips, not files. The season on top (trips · distance · hours),
 * then month by month, newest first — each entry the place it went (or
 * "Just out"), the day, how long, how far, how fast, how many marks. One
 * open at a time: its track and marks on the chart, the facts, the marks
 * with their notes, and the ways out — Save as line (into Places), GPX,
 * delete. Recording a plain track lives here too: a trip that isn't a
 * trip is still an outing.
 */

const VIEW_SOURCE = 'track-view'
/** A track and an outing that began within this of each other are one trip
 *  (cast-off starts both in the same tick; a plain recording is its own). */
const MATCH_MS = 5_000

interface Entry {
  key: string
  startedAt: number
  endedAt: number | null
  track: Track | null
  outing: Outing | null
  marks: number
}

function ensureViewLayer(map: maplibregl.Map) {
  if (map.getSource(VIEW_SOURCE)) return
  map.addSource(VIEW_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  map.addLayer({
    id: 'track-view-line',
    type: 'line',
    source: VIEW_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#59e0b8', 'line-width': 3, 'line-opacity': 0.9 },
  })
}

async function showTrackOnMap(track: Track): Promise<void> {
  const pts = await db.points.where('trackId').equals(track.id!).sortBy('ts')
  if (!pts.length) return
  const coords = pts.map((p) => [p.lon, p.lat] as [number, number])
  const segs = trackSegments(pts).filter((c) => c.length > 1)
  withMap((map) => {
    ensureViewLayer(map)
    const src = map.getSource(VIEW_SOURCE) as GeoJSONSource
    src.setData({ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: segs }, properties: {} })
    const bounds = coords.reduce(
      (b: LngLatBounds, c) => b.extend(c),
      new maplibregl.LngLatBounds(coords[0], coords[0]),
    )
    map.fitBounds(bounds, { padding: { top: 120, bottom: 420, left: 60, right: 60 }, duration: 600 })
  })
}

function clearTrackOnMap() {
  withMap((map) => {
    const src = map.getSource(VIEW_SOURCE) as GeoJSONSource | undefined
    src?.setData({ type: 'FeatureCollection', features: [] })
  })
}

/** Tracks and outings, paired by their start, newest first. */
async function loadEntries(): Promise<Entry[]> {
  const [tracks, outings, marks] = await Promise.all([db.tracks.toArray(), db.outings.toArray(), db.marks.toArray()])
  const markCount = new Map<number, number>()
  for (const m of marks) markCount.set(m.trackId, (markCount.get(m.trackId) ?? 0) + 1)
  const used = new Set<number>()
  const entries: Entry[] = tracks.map((t) => {
    const o = outings
      .filter((x) => x.id != null && !used.has(x.id) && Math.abs(x.startedAt - t.startedAt) < MATCH_MS)
      .sort((a, b) => Math.abs(a.startedAt - t.startedAt) - Math.abs(b.startedAt - t.startedAt))[0]
    if (o?.id != null) used.add(o.id)
    return { key: `t${t.id}`, startedAt: t.startedAt, endedAt: t.endedAt, track: t, outing: o ?? null, marks: markCount.get(t.id!) ?? 0 }
  })
  for (const o of outings) {
    if (o.id != null && !used.has(o.id)) {
      entries.push({ key: `o${o.id}`, startedAt: o.startedAt, endedAt: o.endedAt, track: null, outing: o, marks: 0 })
    }
  }
  return entries.sort((a, b) => b.startedAt - a.startedAt)
}

function monthKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}`
}

function monthLabel(ms: number): string {
  const d = new Date(ms)
  const thisYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, thisYear ? { month: 'long' } : { month: 'long', year: 'numeric' })
}

export default function LogPanel() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [openMarks, setOpenMarks] = useState<Mark[]>([])
  const [note, setNote] = useState<string | null>(null)
  const recording = useGpsStore((s) => s.recording)
  const underWay = useRouteStore((s) => s.tripStartedAt) != null
  const speedUnit = useAppStore((s) => s.speedUnit)
  const depthUnit = useAppStore((s) => s.depthUnit)
  const unit = distanceUnitFor(speedUnit)

  const reload = () => void loadEntries().then(setEntries)
  useEffect(reload, [recording])
  // leaving the sheet takes the shown track with it
  useEffect(
    () => () => {
      clearTrackOnMap()
      clearMarksOnMap()
    },
    [],
  )

  const open = async (e: Entry) => {
    if (openKey === e.key) {
      setOpenKey(null)
      clearTrackOnMap()
      clearMarksOnMap()
      return
    }
    setOpenKey(e.key)
    setNote(null)
    count('log_open')
    if (e.track?.id != null) {
      const marks = await marksFor(e.track.id)
      setOpenMarks(marks)
      await showTrackOnMap(e.track)
      showMarksOnMap(marks)
    } else {
      setOpenMarks([])
      clearTrackOnMap()
      clearMarksOnMap()
    }
  }

  const remove = async (e: Entry) => {
    if (!confirm('Delete this trip from the log?')) return
    if (e.track?.id != null) {
      await db.points.where('trackId').equals(e.track.id).delete()
      await db.marks.where('trackId').equals(e.track.id).delete()
      await db.tracks.delete(e.track.id)
    }
    if (e.outing?.id != null) await db.outings.delete(e.outing.id)
    if (openKey === e.key) {
      setOpenKey(null)
      clearTrackOnMap()
      clearMarksOnMap()
    }
    reload()
  }

  const keep = async (e: Entry) => {
    if (!e.track) return
    const dflt = e.outing?.destName ? `${e.outing.destName} line` : `Line · ${dateShort(e.startedAt)}`
    const name = prompt('Name this line', dflt)
    if (name == null) return
    const line = await saveLine(e.track, name)
    count('line_save')
    setNote(`Saved · Places › Lines · ${line.name}`)
  }

  const dropMark = async (m: Mark) => {
    if (m.id == null) return
    await deleteMark(m.id)
    const marks = openMarks.filter((x) => x.id !== m.id)
    setOpenMarks(marks)
    showMarksOnMap(marks)
    reload()
  }

  // the season: finished tracks since the ice went out
  const season = seasonOf(Date.now())
  const finished = entries.filter((e) => e.endedAt != null && seasonOf(e.startedAt) === season)
  const seasonNm = finished.reduce((a, e) => a + (e.track?.distanceNm ?? 0), 0)
  const seasonH = finished.reduce((a, e) => a + ((e.endedAt ?? e.startedAt) - e.startedAt), 0) / 3600_000

  const recordBtn = !underWay && (
    <button
      className={`rec-btn rec-start ${recording ? 'recording' : ''}`}
      onClick={() => (recording ? void stopRecording() : void startRecording())}
      aria-label={recording ? 'Stop recording track' : 'Record a track'}
    >
      <span className="rec-dot" />
      {recording ? 'Stop recording' : 'Record a track'}
    </button>
  )

  if (!entries.length) {
    return (
      <div className="panel log">
        <div className="empty">
          <p>No trips yet.</p>
          {recordBtn}
        </div>
      </div>
    )
  }

  // month by month
  const months: { key: string; label: string; entries: Entry[] }[] = []
  for (const e of entries) {
    const k = monthKey(e.startedAt)
    let m = months[months.length - 1]
    if (!m || m.key !== k) {
      m = { key: k, label: monthLabel(e.startedAt), entries: [] }
      months.push(m)
    }
    m.entries.push(e)
  }

  return (
    <div className="panel log">
      <div className="log-stats" aria-label="This season">
        <div className="stat">
          <span className="v numeral">{finished.length}</span>
          <span className="k">trips</span>
        </div>
        <div className="stat">
          <span className="v numeral">{runDistance(speedUnit, seasonNm)}</span>
          <span className="k">{unit}</span>
        </div>
        <div className="stat">
          <span className="v numeral">{seasonH < 10 ? seasonH.toFixed(1) : Math.round(seasonH)}</span>
          <span className="k">hours</span>
        </div>
      </div>
      {recordBtn}

      {months.map((m) => (
        <div key={m.key}>
          <div className="panel-section log-month">
            <span>{m.label}</span>
            <span className="meta">{m.entries.length === 1 ? '1 trip' : `${m.entries.length} trips`}</span>
          </div>
          {m.entries.map((e) => {
            const t = e.track
            const isOpen = openKey === e.key
            const live = t != null && t.endedAt == null
            const min = Math.round(((e.endedAt ?? Date.now()) - e.startedAt) / 60_000)
            const facts: string[] = [`${dayShort(e.startedAt)} ${dateShort(e.startedAt)}`]
            if (live) facts.push('recording…')
            else {
              facts.push(`${durationLabel(min)} out`)
              if (t) facts.push(`${runDistance(speedUnit, t.distanceNm)} ${unit}`)
              if (t && t.maxSogKn > 0) facts.push(`max ${Math.round(knToUnit(speedUnit, t.maxSogKn))} ${speedUnitLabel(speedUnit)}`)
              if (!t) facts.push('not recorded')
              if (e.marks) facts.push(`${e.marks} ${e.marks === 1 ? 'mark' : 'marks'}`)
            }
            return (
              <div key={e.key} className={`log-entry${isOpen ? ' log-open' : ''}`}>
                <div className="row">
                  <button className="row-text" onClick={() => void open(e)} disabled={live} aria-expanded={isOpen}>
                    <span className="row-title">{e.outing?.destName ?? 'Just out'}</span>
                    <span className="row-desc numeral">{facts.join(' · ')}</span>
                  </button>
                  {t && !live && (
                    <button className={`icon-btn${isOpen ? ' icon-btn-on' : ''}`} onClick={() => void open(e)} aria-label="Show on the chart">
                      <IconTrack size={19} />
                    </button>
                  )}
                </div>
                {isOpen && (
                  <div className="log-detail">
                    <div className="tb-facts">
                      <span>
                        <b className="numeral">{timeLabel(e.startedAt)}</b>–<b className="numeral">{timeLabel(e.endedAt ?? Date.now())}</b>
                      </span>
                      {e.outing?.arrivedAt != null && (
                        <span>
                          there <b className="numeral">{timeLabel(e.outing.arrivedAt)}</b>
                        </span>
                      )}
                      {e.outing?.homeAt != null && (
                        <span>
                          home <b className="numeral">{timeLabel(e.outing.homeAt)}</b>
                        </span>
                      )}
                    </div>
                    {openMarks.length > 0 && (
                      <>
                        <div className="panel-section log-marks-head">
                          <span>Marks</span>
                          <span className="meta">{openMarks.length}</span>
                        </div>
                        {openMarks.map((mk) => (
                          <div key={mk.id} className="row log-mark">
                            <div className="row-text">
                              <span className="row-title numeral">{timeLabel(mk.ts)}</span>
                              <span className="row-desc">
                                {mk.depthM != null && (
                                  <b className="numeral">
                                    {formatDepth(mk.depthM, depthUnit)} {depthUnit}
                                  </b>
                                )}
                                <input
                                  className="mark-note"
                                  defaultValue={mk.note}
                                  placeholder="note"
                                  maxLength={80}
                                  aria-label="Mark note"
                                  onBlur={(ev) => mk.id != null && void setMarkNote(mk.id, ev.target.value)}
                                />
                              </span>
                            </div>
                            <button className="icon-btn danger" onClick={() => void dropMark(mk)} aria-label="Delete mark">
                              <IconTrash size={17} />
                            </button>
                          </div>
                        ))}
                      </>
                    )}
                    <div className="log-actions">
                      {t && (
                        <button className="chip chip-accent" onClick={() => void keep(e)}>
                          Save as line
                        </button>
                      )}
                      {t && (
                        <button
                          className="chip"
                          onClick={() => {
                            count('gpx')
                            void exportTrackGpx(t)
                          }}
                        >
                          <IconShare size={13} /> GPX
                        </button>
                      )}
                      <button className="icon-btn danger log-delete" onClick={() => void remove(e)} aria-label="Delete this trip">
                        <IconTrash size={17} />
                      </button>
                    </div>
                    {note && <div className="circle-note">{note}</div>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
