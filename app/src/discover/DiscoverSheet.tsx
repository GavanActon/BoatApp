import { useEffect, useState } from 'react'
import { DESTINATIONS } from '../config'
import { useRouteStore } from '../routing/routeStore'
import { haversineNm } from '../routing/waterRouter'
import { useAppStore } from '../state/appStore'
import { homeCenter, usePlacesStore } from '../state/placesStore'
import { dateShort } from '../time'
import { useGpsStore } from '../tracking/gpsStore'
import { enterHelmView, locateAndFollow } from '../tracking/gpsService'
import BottomSheet from '../ui/BottomSheet'
import { IconMinus, IconPlus } from '../ui/icons'
import { distanceUnitFor, knToUnit, runDistance, speedUnitLabel, unitToKn } from '../units'
import { seaColor } from '../weather/seaState'
import { gridConditionsAt } from '../weather/weatherLayer'
import { AchGlyph, RoseRing } from './icons'
import { onLog } from './log'
import { ACH_BY_ID, ACHIEVEMENTS } from './registry'
import { SEASON_PLACES } from './season'
import { chapters, levelName, levelOf, nextChunk, setupCounts, LEVELS, type Chapter, type SetupRow } from './setup'
import { useDiscoverStore } from './store'

type View = { kind: 'hub' } | { kind: 'setup' } | { kind: 'season' } | { kind: 'detail'; id: string }

const TITLES = { hub: 'Discover', setup: 'Levels', season: 'Season', detail: 'Discover' } as const

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
  const [allEarned, setAllEarned] = useState(false)
  const [showLocked, setShowLocked] = useState(false)

  const ch = chapters()
  const setup = setupCounts(ch)
  const level = levelOf(ch)
  const next = nextChunk(ch)
  const seasonN = SEASON_PLACES.filter((p) => seasonReached[p.id]).length
  const earnedDefs = ACHIEVEMENTS.filter((a) => earned[a.id]).sort((a, b) => earned[b.id].at - earned[a.id].at)
  const locked = ACHIEVEMENTS.filter((a) => !earned[a.id])
  const shownEarned = allEarned ? earnedDefs : earnedDefs.slice(0, 3)

  return (
    <>
      <div className="dv-head">
        <RoseRing frac={level / ch.length} size={56} full={level >= ch.length} />
        <div className="dv-head-text">
          <span className="dv-count">{levelName(level)}</span>
          <span className="dv-sub numeral">
            Level {level} · {earnedDefs.length} of {ACHIEVEMENTS.length} earned
          </span>
        </div>
      </div>

      {next ? (
        <div className="dv-next">
          <div className="dv-next-head">
            <span className="panel-section">Next up · {next.name}</span>
            <span className="dv-n numeral">
              {next.rows.filter((r) => r.done).length}/{next.rows.length}
            </span>
          </div>
          {next.rows
            .filter((r) => !r.done)
            .slice(0, 3)
            .map((r) => (
              <ActionRow key={r.id} row={r} />
            ))}
        </div>
      ) : null}

      <button className="dv-row" onClick={() => go({ kind: 'setup' })}>
        <div className="dv-row-text">
          <span className={`dv-row-title${setup.done === setup.total ? ' done' : ''}`}>Levels</span>
          <Segs n={ch.length} done={level} />
        </div>
        <span className={`dv-n numeral${setup.done === setup.total ? ' done' : ''}`}>
          {level}/{ch.length}
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
          <div className="dv-next-head">
            <span className="panel-section">Earned</span>
            {earnedDefs.length > 3 && (
              <button className="dv-more" onClick={() => setAllEarned((v) => !v)}>
                {allEarned ? 'recent' : `all ${earnedDefs.length}`}
              </button>
            )}
          </div>
          <div className="dv-grid">
            {shownEarned.map((a) => (
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
          <button className="dv-row dv-row-last dv-fold" onClick={() => setShowLocked((v) => !v)}>
            <div className="dv-row-text">
              <span className="dv-row-title">Locked</span>
            </div>
            <span className="dv-n numeral">{locked.length}</span>
            <span className={`dv-chev${showLocked ? ' open' : ''}`}>
              <Chevron />
            </span>
          </button>
          {showLocked &&
            locked.map((a) => (
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
  const ch = chapters()
  const level = levelOf(ch)
  const next = nextChunk(ch)
  const [open, setOpen] = useState<string | null>(null)
  const openId = open ?? next?.id ?? null
  return (
    <>
      <div className="dv-ladder">
        {LEVELS.map((name, i) => (
          <span key={name} className={`dv-rung${i <= level ? ' on' : ''}${i === level ? ' now' : ''}`}>
            {name}
          </span>
        ))}
      </div>
      {ch.map((c, i) => (
        <ChapterBlock
          key={c.id}
          chapter={c}
          n={i + 1}
          open={c.id === openId}
          onToggle={() => setOpen(c.id === openId ? '' : c.id)}
        />
      ))}
    </>
  )
}

/** One chunk: finish it and you are up a level, in any order. Folded to a
 *  line unless it is the one being worked on, or tapped open. */
function ChapterBlock({
  chapter,
  n,
  open,
  onToggle,
}: {
  chapter: Chapter
  n: number
  open: boolean
  onToggle: () => void
}) {
  const done = chapter.rows.filter((r) => r.done).length
  const all = done === chapter.rows.length
  return (
    <div className={`dv-chapter${all ? ' done' : ''}${open ? ' open' : ''}`}>
      <button className="dv-chapter-head" onClick={onToggle} aria-expanded={open}>
        <span className="dv-chapter-n numeral">{all ? '✓' : n}</span>
        <span className={`dv-row-title${all ? ' done' : ''}`}>{chapter.name}</span>
        <Segs n={chapter.rows.length} done={done} />
        <span className={`dv-chev${open ? ' open' : ''}`}>
          <Chevron />
        </span>
      </button>
      {open && (
        <>
          <div className="dv-reward">{chapter.reward}</div>
          {chapter.rows.map((r) => (
            <ActionRow key={r.id} row={r} />
          ))}
        </>
      )}
    </div>
  )
}

/** A row is an action: tap, and you are at the real control. Two rows
 *  host their control ONCE — cruise speed and limits are set in place the
 *  first time, with a line saying where they live from now on — and then
 *  turn into pointers wearing the value. Set it here once; change it there. */
function ActionRow({ row }: { row: SetupRow }) {
  if (!row.done && row.action === 'cruise') return <SetOnceRow row={row} />
  return <PointerRow row={row} />
}

function SetOnceRow({ row }: { row: SetupRow }) {
  return (
    <div className="dv-fv open">
      <span className="dv-box" />
      <span className="dv-fv-text">
        <b>{row.label}</b>
        <div className="dv-ctl">
          <CruiseStep />
          <span className="dv-where">from now on · {row.hint}</span>
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

function PointerRow({ row }: { row: SetupRow }) {
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
      case 'cruise':
        // lives at the top of Settings, under Boat
        app().setSheetTab('layers')
        useDiscoverStore.getState().setGuide('cruise')
        break
      case 'settings':
        app().setSheetTab('layers')
        break
      case 'places':
        app().setSheetTab('places')
        break
      case 'offline':
        app().setSheetTab('offline')
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
      {row.value && <span className="dv-fv-val numeral">{row.value}</span>}
      <span className="dv-chev">
        <Chevron />
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
