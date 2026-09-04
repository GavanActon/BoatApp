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
import { distanceUnitFor, runDistance } from '../units'
import { seaColor } from '../weather/seaState'
import { gridConditionsAt } from '../weather/weatherLayer'
import { AchGlyph, RoseRing } from './icons'
import { canPromptInstall, onInstallChange, platform, promptInstall } from './install'
import { onLog } from './log'
import { ACH_BY_ID, ACHIEVEMENTS } from './registry'
import { SEASON_PLACES } from './season'
import { chapters, levelName, levelOf, nextChunk, setupCounts, LEVELS, type Chapter, type SetupRow } from './setup'
import { useDiscoverStore } from './store'

type View = { kind: 'hub' } | { kind: 'setup' } | { kind: 'season' } | { kind: 'detail'; id: string }

const TITLES = { hub: 'Discover', setup: 'Levels', season: 'Season', detail: 'Discover' } as const

/**
 * The Discover sheet, disclosed as it is earned. At level 0 it is the
 * First voyage chapter and nothing else — four rows and the ring that
 * counts them. From level 1 the hub arrives around the current chapter:
 * the levels, the season's places, what's earned, what's locked and how.
 */
export default function DiscoverSheet() {
  // sent here by the welcome card: land on the levels, not the scoreboard
  const [view, setView] = useState<View>(() => {
    const d = useDiscoverStore.getState()
    if (d.entry === 'setup') {
      d.setEntry(null)
      return { kind: 'setup' }
    }
    return { kind: 'hub' }
  })
  // opening the sheet at all answers the welcome card's nudge chip
  useEffect(() => {
    const d = useDiscoverStore.getState()
    if (d.nudge) d.setNudge(false)
  }, [])
  // the fresh outlines are for the first look — the engine clears them when
  // the sheet closes (an unmount effect here would fire twice under
  // StrictMode and clear them on open)

  const back = () => setView({ kind: 'hub' })
  // the hub opens on what's next and no more — the header and the current
  // chapter's rows; levels, the season, what's earned sit below the fold,
  // a scroll away. The sub-views take the room a list needs.
  const level = useDiscoverStore((s) => s.level)
  const halfPct = view.kind !== 'hub' ? 62 : level === 0 ? 46 : 48
  return (
    <BottomSheet title={view.kind === 'hub' && level === 0 ? 'First voyage' : TITLES[view.kind]} halfPct={halfPct}>
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

/** …and when the browser offers an install prompt, or an install lands. */
function useInstallTick() {
  const [, setTick] = useState(0)
  useEffect(() => onInstallChange(() => setTick((t) => t + 1)), [])
}

/** Everything a set-up row reads, one primitive per selector (a fresh array
 *  would re-render forever) — so the counters can't go stale. */
function useSetupInputs() {
  useLogTick()
  useInstallTick()
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

  const nextDone = next ? next.rows.filter((r) => r.done).length : 0

  // level 0: the chapter, whole, and nothing else to wonder about
  if (level === 0 && next) {
    return (
      <>
        <div className="dv-head">
          <RoseRing size={56} frac={0} level={0} segs={{ n: next.rows.length, done: nextDone }} />
          <div className="dv-head-text">
            <span className="dv-count numeral">
              {nextDone} of {next.rows.length} done
            </span>
            <span className="dv-sub">{next.reward}</span>
          </div>
        </div>
        <div className="dv-next">
          {next.rows.map((r) => (
            <ActionRow key={r.id} row={r} chapterId={next.id} />
          ))}
        </div>
      </>
    )
  }

  return (
    <>
      <div className="dv-head">
        <RoseRing frac={level / ch.length} size={56} full={level >= ch.length} level={level} />
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
              {nextDone}/{next.rows.length}
            </span>
          </div>
          {next.rows.map((r) => (
            <ActionRow key={r.id} row={r} chapterId={next.id} />
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
  // back from a control a row sent you to: the chapter you left is open
  const [open, setOpen] = useState<string | null>(() => {
    const d = useDiscoverStore.getState()
    const c = d.entryChapter
    if (c) d.setEntryChapter(null)
    return c
  })
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
            <ActionRow key={r.id} row={r} chapterId={chapter.id} inLevels />
          ))}
        </>
      )}
    </div>
  )
}

/** A row is an action: tap, and you are at the real control — Discover
 *  points, it never hosts. A row that opens another sheet lands on its
 *  control and comes back here when that sheet closes (engine.ts), so the
 *  levels are where you left them. */
function ActionRow({ row, chapterId, inLevels }: { row: SetupRow; chapterId?: string; inLevels?: boolean }) {
  // the one row with nowhere to point: iOS has no install button, only two
  // taps to describe, so the row unfolds them here
  if (row.action === 'install' && !row.done) return <InstallRow row={row} />
  return <PointerRow row={row} chapterId={chapterId} inLevels={inLevels} />
}

/**
 * Putting the app on the Home Screen. Where the browser hands us a prompt
 * (Android, desktop Chrome) the row is an Install button. On iOS it is the
 * two taps, drawn: Share, then Add to Home Screen — and where that sits
 * when the sheet hides it.
 */
function InstallRow({ row }: { row: SetupRow }) {
  const [open, setOpen] = useState(false)
  const plat = platform()
  const prompt = canPromptInstall()
  const touch = useDiscoverStore((s) => s.touch)
  const install = async () => {
    if (await promptInstall()) touch('installed')
  }
  return (
    <div className={`dv-fv${open ? ' open' : ''}`}>
      <span className="dv-box" />
      <span className="dv-fv-text">
        <button className="dv-install-head" onClick={() => (prompt ? void install() : setOpen((v) => !v))} aria-expanded={open}>
          <b>{row.label}</b>
          <i>{prompt ? 'tap to install' : row.hint}</i>
        </button>
        {open && !prompt && (
          <ol className="dv-steps">
            {plat === 'ios-other' && (
              <li>
                Open <b>sandies.app</b> in <b>Safari</b>
              </li>
            )}
            {plat === 'desktop' ? (
              <li>Open <b>sandies.app</b> on your phone, or install from Chrome's address bar</li>
            ) : (
              <>
                <li>
                  Tap <b>Share</b> <ShareGlyph /> {plat === 'android' ? '(or the ⋮ menu)' : 'at the bottom of Safari'}
                </li>
                <li>
                  Tap <b><PlusGlyph /> Add to Home Screen</b>
                </li>
                <li className="dv-step-dim">
                  Not there? Scroll the sheet down, or tap <b>··· More</b>, then <b>Add to Home Screen</b>
                </li>
              </>
            )}
            <li className="dv-step-dim">Then open Sandies from the Home Screen — the charts and your crew stay put</li>
          </ol>
        )}
      </span>
      <span className="dv-chev">
        <Chevron />
      </span>
    </div>
  )
}

function ShareGlyph() {
  return (
    <svg className="dv-glyph-inline" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="share icon">
      <path d="M12 3v13" />
      <path d="M8 7l4-4 4 4" />
      <path d="M5 11v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9" />
    </svg>
  )
}

function PlusGlyph() {
  return (
    <svg className="dv-glyph-inline" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  )
}

function PointerRow({ row, chapterId, inLevels }: { row: SetupRow; chapterId?: string; inLevels?: boolean }) {
  const app = useAppStore.getState
  const act = () => {
    const disc = useDiscoverStore.getState()
    // the round trip lands where the row was: the hub, or Levels on its chapter
    disc.setEntry(inLevels ? 'setup' : null)
    disc.setEntryChapter(inLevels ? (chapterId ?? null) : null)
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
      case 'units':
        // the trip itself is the task: seen once is done
        disc.touch('unitsSeen')
        disc.setTarget('units')
        disc.setReturnTo(true)
        app().setSheetTab('layers')
        break
      case 'cruise':
        // lives at the top of Settings, under Boat — land ON it
        disc.setTarget('cruise')
        disc.setReturnTo(true)
        app().setSheetTab('layers')
        break
      case 'settings':
        disc.setReturnTo(true)
        app().setSheetTab('layers')
        break
      case 'places':
        disc.setReturnTo(true)
        app().setSheetTab('places')
        break
      case 'offline':
        // the download lives in Settings now, under Charts offline
        disc.setReturnTo(true)
        app().setSheetTab('layers')
        break
      case 'tracks':
        disc.setReturnTo(true)
        app().setSheetTab('log')
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
