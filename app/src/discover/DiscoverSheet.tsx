import { useEffect, useState } from 'react'
import { DESTINATIONS } from '../config'
import { useRouteStore } from '../routing/routeStore'
import { haversineNm } from '../routing/waterRouter'
import { SEA_SCALE_MAX_M, SEA_SCALE_MIN_M, useAppStore } from '../state/appStore'
import { homeCenter, usePlacesStore } from '../state/placesStore'
import { dateShort } from '../time'
import { useGpsStore } from '../tracking/gpsStore'
import { enterHelmView, locateAndFollow } from '../tracking/gpsService'
import BottomSheet from '../ui/BottomSheet'
import LimitsRow from '../ui/LimitsRow'
import SeaRamp from '../ui/SeaRamp'
import { IconMinus, IconPlus } from '../ui/icons'
import { knToUnit, SPEED_UNITS, speedUnitLabel, unitToKn, distanceUnitFor, runDistance } from '../units'
import { seaColor } from '../weather/seaState'
import { gridConditionsAt } from '../weather/weatherLayer'
import { AchGlyph, RoseRing } from './icons'
import { onLog } from './log'
import { ACH_BY_ID, ACHIEVEMENTS } from './registry'
import { SEASON_PLACES } from './season'
import { chapters, setupCounts, type Chapter, type SetupRow } from './setup'
import { useDiscoverStore } from './store'

type View = { kind: 'hub' } | { kind: 'setup' } | { kind: 'season' } | { kind: 'detail'; id: string }

const TITLES = { hub: 'Discover', setup: 'Set up', season: 'Season', detail: 'Discover' } as const

/**
 * The Discover sheet: the hub (what's earned, what's locked and how), the
 * set-up chapters, the season's places, and one achievement opened.
 */
export default function DiscoverSheet() {
  const [view, setView] = useState<View>({ kind: 'hub' })
  // the fresh outlines are for the first look — the engine clears them when
  // the sheet closes (an unmount effect here would fire twice under
  // StrictMode and clear them on open)

  const back = () => setView({ kind: 'hub' })
  return (
    <BottomSheet title={TITLES[view.kind]} halfPct={view.kind === 'hub' ? 70 : 62}>
      {view.kind !== 'hub' && (
        <button className="dv-back" onClick={back}>
          <Chevron left /> Discover
        </button>
      )}
      {view.kind === 'hub' && <Hub go={setView} />}
      {view.kind === 'setup' && <Setup />}
      {view.kind === 'season' && <Season />}
      {view.kind === 'detail' && <Detail id={view.id} />}
    </BottomSheet>
  )
}

function Chevron({ left = false }: { left?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {left ? <path d="M14.5 5 7.5 12l7 7" /> : <path d="M9.5 5 16.5 12l-7 7" />}
    </svg>
  )
}

/** Re-render when the log moves (Dexie-backed, not a store). */
function useLogTick() {
  const [, setTick] = useState(0)
  useEffect(() => onLog(() => setTick((t) => t + 1)), [])
}

/** Everything a set-up row reads, one primitive per selector (a fresh array
 *  would re-render forever) — so the counters can't go stale. */
function useSetupInputs() {
  useLogTick()
  useAppStore((s) => s.numbersSeen)
  useAppStore((s) => s.firstRouteDone)
  useAppStore((s) => s.gpsWanted)
  useAppStore((s) => s.waveLimitM)
  useAppStore((s) => s.offlineReady)
  usePlacesStore((s) => s.saved)
  usePlacesStore((s) => s.notes)
  usePlacesStore((s) => s.hidden)
  usePlacesStore((s) => s.homeName)
  useGpsStore((s) => s.status)
  useDiscoverStore((s) => s.touched)
}

function Segs({ n, done }: { n: number; done: number }) {
  return (
    <div className="dv-segs" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i < done ? 'on' : ''} />
      ))}
    </div>
  )
}

// ---------- the hub ----------

function Hub({ go }: { go: (v: View) => void }) {
  useSetupInputs()
  const earned = useDiscoverStore((s) => s.earned)
  const fresh = useDiscoverStore((s) => s.fresh)
  const seasonReached = useDiscoverStore((s) => s.seasonReached)

  const ch = chapters()
  const setup = setupCounts(ch)
  const chaptersDone = ch.filter((c) => c.rows.every((r) => r.done)).length
  const seasonN = SEASON_PLACES.filter((p) => seasonReached[p.id]).length
  const earnedDefs = ACHIEVEMENTS.filter((a) => earned[a.id]).sort((a, b) => earned[b.id].at - earned[a.id].at)
  const locked = ACHIEVEMENTS.filter((a) => !earned[a.id])
  const frac = earnedDefs.length / ACHIEVEMENTS.length

  return (
    <>
      <div className="dv-head">
        <RoseRing frac={frac} size={56} full={frac >= 1} />
        <div className="dv-head-text">
          <span className="dv-count numeral">
            {earnedDefs.length} of {ACHIEVEMENTS.length}
          </span>
          <span className="dv-sub numeral">
            {setup.done} of {setup.total} set up
          </span>
        </div>
      </div>

      <button className="dv-row" onClick={() => go({ kind: 'setup' })}>
        <div className="dv-row-text">
          <span className={`dv-row-title${setup.done === setup.total ? ' done' : ''}`}>Set up</span>
          <Segs n={ch.length} done={chaptersDone} />
        </div>
        <span className={`dv-n numeral${setup.done === setup.total ? ' done' : ''}`}>
          {setup.done}/{setup.total}
        </span>
        <span className="dv-chev">
          <Chevron />
        </span>
      </button>
      <button className="dv-row dv-row-last" onClick={() => go({ kind: 'season' })}>
        <div className="dv-row-text">
          <span className={`dv-row-title${seasonN === SEASON_PLACES.length ? ' done' : ''}`}>Season</span>
          <Segs n={SEASON_PLACES.length} done={seasonN} />
        </div>
        <span className={`dv-n numeral${seasonN === SEASON_PLACES.length ? ' done' : ''}`}>
          {seasonN}/{SEASON_PLACES.length}
        </span>
        <span className="dv-chev">
          <Chevron />
        </span>
      </button>

      {earnedDefs.length > 0 && (
        <>
          <div className="panel-section">Earned</div>
          <div className="dv-grid">
            {earnedDefs.map((a) => (
              <button
                key={a.id}
                className={`dv-ach${fresh.includes(a.id) ? ' fresh' : ''}`}
                onClick={() => go({ kind: 'detail', id: a.id })}
              >
                <AchGlyph icon={a.icon} />
                <span>
                  <b>{a.name}</b>
                  <i className="numeral">{dateShort(earned[a.id].at)}</i>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {locked.length > 0 && (
        <>
          <div className="panel-section">Locked</div>
          {locked.map((a) => (
            <button key={a.id} className="dv-lock" onClick={() => go({ kind: 'detail', id: a.id })}>
              <AchGlyph icon={a.icon} />
              <span className="dv-lock-text">
                <span className="dv-lock-name">{a.name}</span>
                <span className="dv-lock-hint">{a.hint}</span>
              </span>
            </button>
          ))}
        </>
      )}
    </>
  )
}

// ---------- one achievement ----------

function Detail({ id }: { id: string }) {
  const def = ACH_BY_ID.get(id)
  const e = useDiscoverStore((s) => s.earned[id])
  if (!def) return null
  return (
    <>
      <div className="dv-det">
        <div className={`dv-det-tile${e ? '' : ' locked'}`}>
          <AchGlyph icon={def.icon} size={36} />
        </div>
        <div className="dv-det-name">{def.name}</div>
        <div className="dv-det-when numeral">{e ? `Earned · ${dateShort(e.at)}` : def.hint}</div>
      </div>
      {e?.facts.map(([k, v]) => (
        <div key={k} className="dv-fact">
          <span>{k}</span>
          <b className="numeral">{v}</b>
        </div>
      ))}
    </>
  )
}

// ---------- set up ----------

function Setup() {
  useSetupInputs()
  return (
    <>
      {chapters().map((c) => (
        <ChapterBlock key={c.id} chapter={c} />
      ))}
    </>
  )
}

function ChapterBlock({ chapter }: { chapter: Chapter }) {
  const done = chapter.rows.filter((r) => r.done).length
  const all = done === chapter.rows.length
  return (
    <div className="dv-chapter">
      <div className="dv-chapter-head">
        <span className={`dv-row-title${all ? ' done' : ''}`}>{chapter.name}</span>
        <Segs n={chapter.rows.length} done={done} />
        <span className={`dv-n numeral${all ? ' done' : ''}`}>
          {done}/{chapter.rows.length}
        </span>
      </div>
      <div className="dv-reward">{chapter.reward}</div>
      {chapter.rows.map((r) =>
        r.action === 'inline' ? <InlineRow key={r.id} row={r} /> : <ActionRow key={r.id} row={r} />,
      )}
    </div>
  )
}

/** A row is an action: tap, and you are at the real control. */
function ActionRow({ row }: { row: SetupRow }) {
  const app = useAppStore.getState
  const act = () => {
    switch (row.action) {
      case 'locate':
        locateAndFollow()
        app().setSheetTab(null)
        break
      case 'pickHome':
        app().setSheetTab(null)
        app().setPickingHome(true)
        break
      case 'guide':
        app().setShowNumbersGuide(true)
        break
      case 'sandies':
        routeToSandies()
        break
      case 'places':
        app().setSheetTab('places')
        break
      case 'offline':
        app().setSheetTab('offline')
        break
      case 'settings':
        app().setSheetTab('layers')
        break
      case 'tracks':
        app().setSheetTab('tracks')
        break
      case 'helm':
        app().setSheetTab(null)
        enterHelmView()
        break
      default:
        app().setSheetTab(null)
    }
  }
  return (
    <button className={`dv-fv${row.done ? ' done' : ''}`} onClick={act}>
      <span className="dv-box">{row.done ? '✓' : ''}</span>
      <span className="dv-fv-text">
        <b>{row.label}</b>
        <i>{row.hint}</i>
      </span>
    </button>
  )
}

/** The same run the first-voyage card plots (§10.4). */
function routeToSandies() {
  const d = DESTINATIONS.find((x) => x.name === 'The Sandies') ?? DESTINATIONS[0]
  if (!d) return
  useAppStore.getState().setFirstRouteDone(true)
  useAppStore.getState().setPlanPicked(false)
  const rs = useRouteStore.getState()
  rs.setDestination({ name: d.name, lon: d.lon, lat: d.lat })
  rs.setFocusPoint({ lon: d.lon, lat: d.lat, label: d.name })
  rs.setCard('trip')
  useAppStore.getState().setDetent('rest')
  useAppStore.getState().setSheetTab(null)
}

/** The boat chapter: the control itself, then where it lives from now on. */
function InlineRow({ row }: { row: SetupRow }) {
  return (
    <div className={`dv-fv open${row.done ? ' done' : ''}`}>
      <span className="dv-box">{row.done ? '✓' : ''}</span>
      <span className="dv-fv-text">
        <b>{row.label}</b>
        <div className="dv-ctl">
          {row.id === 'cruise' && <CruiseStep />}
          {row.id === 'units' && <UnitSegs />}
          {row.id === 'limits' && <LimitsRow />}
          {row.id === 'scale' && <ScaleSlider />}
          <span className="dv-where">{row.hint}</span>
        </div>
      </span>
    </div>
  )
}

function CruiseStep() {
  const cruiseKn = useRouteStore((s) => s.cruiseKn)
  const setCruiseKn = useRouteStore((s) => s.setCruiseKn)
  const speedUnit = useAppStore((s) => s.speedUnit)
  const shown = Math.round(knToUnit(speedUnit, cruiseKn))
  const step = (d: number) => setCruiseKn(unitToKn(speedUnit, shown + d))
  return (
    <span className="speed-step">
      <button className="nudge" onClick={() => step(-1)} aria-label="Slower">
        <IconMinus size={11} />
      </button>
      <b className="numeral">
        {shown} {speedUnitLabel(speedUnit)}
      </b>
      <button className="nudge" onClick={() => step(1)} aria-label="Faster">
        <IconPlus size={11} />
      </button>
    </span>
  )
}

function UnitSegs() {
  const depthUnit = useAppStore((s) => s.depthUnit)
  const setDepthUnit = useAppStore((s) => s.setDepthUnit)
  const speedUnit = useAppStore((s) => s.speedUnit)
  const setSpeedUnit = useAppStore((s) => s.setSpeedUnit)
  const windUnit = useAppStore((s) => s.windUnit)
  const setWindUnit = useAppStore((s) => s.setWindUnit)
  return (
    <>
      <div className="dv-segrow">
        <span className="dv-seglab">Depth</span>
        <div className="seg">
          {(['m', 'ft'] as const).map((u) => (
            <button key={u} className={depthUnit === u ? 'seg-on' : ''} onClick={() => setDepthUnit(u)}>
              {u}
            </button>
          ))}
        </div>
      </div>
      <div className="dv-segrow">
        <span className="dv-seglab">Boat</span>
        <div className="seg">
          {SPEED_UNITS.map((u) => (
            <button key={u.id} className={speedUnit === u.id ? 'seg-on' : ''} onClick={() => setSpeedUnit(u.id)}>
              {u.label}
            </button>
          ))}
        </div>
      </div>
      <div className="dv-segrow">
        <span className="dv-seglab">Wind</span>
        <div className="seg">
          {SPEED_UNITS.map((u) => (
            <button key={u.id} className={windUnit === u.id ? 'seg-on' : ''} onClick={() => setWindUnit(u.id)}>
              {u.label}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

function ScaleSlider() {
  const seaScaleM = useAppStore((s) => s.seaScaleM)
  const setSeaScale = useAppStore((s) => s.setSeaScale)
  return (
    <>
      <input
        type="range"
        min={SEA_SCALE_MIN_M}
        max={SEA_SCALE_MAX_M}
        step={0.1}
        value={seaScaleM}
        aria-label="Sea-state scale: the wave height at which Rough begins"
        onChange={(e) => setSeaScale(Number(e.target.value))}
      />
      <SeaRamp roughM={seaScaleM} />
    </>
  )
}

// ---------- the season ----------

function Season() {
  const reached = useDiscoverStore((s) => s.seasonReached)
  const speedUnit = useAppStore((s) => s.speedUnit)
  const seaScale = useAppStore((s) => s.seaScaleM)
  const home = homeCenter()
  const n = SEASON_PLACES.filter((p) => reached[p.id]).length
  const now = Date.now()
  return (
    <>
      <div className="dv-head">
        <RoseRing frac={n / SEASON_PLACES.length} size={56} full={n === SEASON_PLACES.length} />
        <div className="dv-head-text">
          <span className="dv-count numeral">
            {n} of {SEASON_PLACES.length} reached
          </span>
          <span className="dv-sub">a flag fills on arrival</span>
        </div>
      </div>
      {SEASON_PLACES.map((p) => {
        const at = reached[p.id]
        const nm = home ? haversineNm(home[0], home[1], p.lon, p.lat) : null
        const wave = gridConditionsAt(p.lon, p.lat, now)?.waveM ?? null
        return (
          <div key={p.id} className="dv-q">
            <span className={`dv-qmark${at ? ' on' : ''}`}>
              <Flag on={!!at} />
            </span>
            <span className="dv-qtext">
              <span className={`dv-qname${at ? ' on' : ''}`}>{p.name}</span>
              <span className="dv-qinfo numeral">
                {nm != null && (
                  <>
                    <b>{runDistance(speedUnit, nm)}</b> {distanceUnitFor(speedUnit)}
                  </>
                )}
                {wave != null && (
                  <>
                    {nm != null && ' ·'}
                    <i className="dv-sea" style={{ background: seaColor(wave, seaScale) }} />
                    {wave.toFixed(1)}
                  </>
                )}
              </span>
            </span>
            {at && <span className="dv-qdate numeral">{dateShort(at)}</span>}
          </div>
        )
      })}
    </>
  )
}

function Flag({ on }: { on: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="M5 21V4" />
      <path d="M5 4h13l-3 4 3 4H5Z" />
    </svg>
  )
}
