import { useState } from 'react'
import { track } from '../stats/core'
import { haptic } from '../ui/haptics'
import { IconClose } from '../ui/icons'
import Mark from './Mark'
import {
  cleanMark,
  EFFECTS,
  GLOWS,
  NO_FLAIR,
  QUICK_PICKS,
  surprise,
  SWATCHES,
  TINTS,
  type Effect,
  type Flair,
  type Glow,
  type Tint,
  flairSummary,
} from './marks'
import { autoColor, useCircleStore } from './store'

/**
 * The skipper card: how the crew sees you — a mark (any emoji), your
 * name, your boat. A sheet of its own, once: it comes up the first time
 * Start or Join is tapped, before the crew is made, and That's me runs
 * the tap that was waiting. Edited later from the last row of Crew.
 *
 * Flair — glow, tint, effect on the mark — is a side room off the card
 * for whoever wants to dig in, never a step.
 */
export default function SkipperCard() {
  const open = useCircleStore((s) => s.cardOpen)
  if (!open) return null
  return <CardSheet then={open.then} />
}

function CardSheet({ then }: { then: (() => void) | null }) {
  const skipper = useCircleStore((s) => s.skipper)
  const deviceId = useCircleStore((s) => s.deviceId)
  const [name, setName] = useState(skipper.name)
  const [boat, setBoat] = useState(skipper.boat)
  const [mark, setMark] = useState(skipper.mark)
  const [flair, setFlair] = useState<Flair | null>(skipper.flair)
  const [picked, setPicked] = useState<string | null>(skipper.color)
  const [view, setView] = useState<'card' | 'flair'>('card')
  const auto = autoColor(deviceId)
  const color = picked ?? auto

  const close = () => useCircleStore.getState().setCardOpen(null)
  const save = () => {
    const s = useCircleStore.getState()
    s.setSkipper({ name: name.trim(), boat: boat.trim(), mark, flair, color: picked })
    s.setCardDone(true)
    s.setCardOpen(null)
    haptic('confirm')
    track('skipper-card', { mark: mark ? 1 : 0, flair: flair ? 1 : 0, color: picked ? 1 : 0 })
    then?.()
  }
  const who = [name.trim(), boat.trim()].filter(Boolean).join(' · ')

  return (
    <div className="skipper" role="dialog" aria-label="Your skipper card">
      <div className="skipper-sheet glass">
        {view === 'flair' ? (
          <FlairView
            mark={mark}
            color={color}
            flair={flair ?? NO_FLAIR}
            who={who}
            onChange={setFlair}
            onDone={() => setView('card')}
          />
        ) : (
          <>
            <div className="sheet-titlerow">
              <h2>Your skipper card</h2>
              <button className="sheet-close" onClick={close} aria-label="Close">
                <IconClose />
              </button>
            </div>
            <div className="sheet-body">
              <div className="row-desc">
                How the crew sees you, on the chart and in the list. Once now. Change it later from the bottom
                of Crew.
              </div>
              <div className="sk-preview">
                <Mark size={76} mark={mark} color={color} flair={flair} wake />
                <span className="sk-who">{who || 'Name · Boat'}</span>
              </div>
              <div className="row circle-fields" style={{ borderBottom: 'none' }}>
                <input
                  type="text"
                  value={name}
                  placeholder="Your name"
                  maxLength={40}
                  aria-label="Your name"
                  onChange={(e) => setName(e.target.value)}
                />
                <input
                  type="text"
                  value={boat}
                  placeholder="Boat"
                  maxLength={40}
                  aria-label="Boat name"
                  onChange={(e) => setBoat(e.target.value)}
                />
              </div>

              <div className="panel-section sk-section">
                <span>Your mark</span>
                <span className="meta">any emoji goes</span>
              </div>
              <div className="sk-pick" role="listbox" aria-label="Pick a mark">
                {QUICK_PICKS.map((e) => (
                  <button
                    key={e}
                    className={`sk-chip ${mark === e ? 'on' : ''}`}
                    role="option"
                    aria-selected={mark === e}
                    onClick={() => {
                      setMark(e)
                      haptic()
                    }}
                  >
                    {e}
                  </button>
                ))}
              </div>
              <div className="row circle-fields" style={{ borderBottom: 'none', paddingTop: 6 }}>
                <input
                  type="text"
                  className="sk-emoji-in"
                  value=""
                  placeholder="or type one 🙃"
                  aria-label="Type any emoji"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => {
                    const g = cleanMark(e.target.value)
                    if (g) {
                      setMark(g)
                      haptic()
                    }
                  }}
                />
                <button
                  className="linklike"
                  onClick={() => {
                    setMark(surprise(mark))
                    haptic()
                  }}
                >
                  Surprise me 🎲
                </button>
                {mark && (
                  <button className="linklike dim" onClick={() => setMark('')}>
                    None
                  </button>
                )}
              </div>
              <div className="sk-note">The keyboard's emoji is the whole menu.</div>

              <div className="panel-section sk-section">
                <span>Colour</span>
                <span className="meta">behind the mark</span>
              </div>
              <div className="sk-swatches" role="listbox" aria-label="Colour">
                <button
                  className={`sk-swatch auto ${picked == null ? 'on' : ''}`}
                  role="option"
                  aria-selected={picked == null}
                  aria-label="Automatic"
                  style={{ background: auto }}
                  onClick={() => {
                    setPicked(null)
                    haptic()
                  }}
                >
                  <span>auto</span>
                </button>
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    className={`sk-swatch ${picked === c ? 'on' : ''}`}
                    role="option"
                    aria-selected={picked === c}
                    aria-label={c}
                    style={{ background: c }}
                    onClick={() => {
                      setPicked(c)
                      haptic()
                    }}
                  />
                ))}
                <label
                  className={`sk-swatch any ${picked != null && !SWATCHES.includes(picked) ? 'on' : ''}`}
                  aria-label="Any colour"
                  style={picked != null && !SWATCHES.includes(picked) ? { background: picked } : undefined}
                >
                  <input type="color" value={picked ?? auto} onChange={(e) => setPicked(e.target.value)} />
                  <span>any</span>
                </label>
              </div>

              <button className="row sk-row" onClick={() => setView('flair')}>
                <div className="row-text">
                  <span className="row-title">Flair</span>
                  <span className="row-desc">{flairSummary(flair) || 'glow, tint, effects · if you fancy'}</span>
                </div>
                <svg className="sk-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
              </button>

              <button className="btn-primary sk-btn" onClick={save}>
                That's me
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function FlairView({
  mark,
  color,
  flair,
  who,
  onChange,
  onDone,
}: {
  mark: string
  color: string
  flair: Flair
  who: string
  onChange: (f: Flair | null) => void
  onDone: () => void
}) {
  // none of it chosen is no flair at all — null, so nothing is sent or drawn
  const set = (patch: Partial<Flair>) => {
    const f = { ...flair, ...patch }
    onChange(f.glow === 'none' && f.tint === 'solid' && f.effect === 'none' ? null : f)
    haptic()
  }
  const glow = (id: Glow) => set({ glow: id })
  const tint = (id: Tint) => set({ tint: id })
  const effect = (id: Effect) => set({ effect: id })
  const mini = (f: Flair, size = 30) => <Mark size={size} mark={mark} color={color} flair={f} wake />
  return (
    <>
      <div className="sheet-titlerow">
        <h2>Flair</h2>
        <button className="sheet-close" onClick={onDone} aria-label="Back to the card">
          <IconClose />
        </button>
      </div>
      <div className="sheet-body">
        <div className="row-desc">Dress your mark up, if you fancy. Friends see it on the chart and in the crew.</div>
        <div className="sk-water">
          <Mark size={64} mark={mark} color={color} flair={flair} wake />
          <div className="sk-water-text">
            <span className="sk-who">{who || 'Name · Boat'}</span>
            <span className="row-desc">{flairSummary(flair) || 'plain'}</span>
          </div>
        </div>

        <div className="panel-section sk-section">
          <span>Glow</span>
        </div>
        <div className="sk-pick" role="listbox" aria-label="Glow">
          {GLOWS.map((g) => (
            <button
              key={g.id}
              className={`sk-chip fl ${flair.glow === g.id ? 'on' : ''}`}
              role="option"
              aria-selected={flair.glow === g.id}
              onClick={() => glow(g.id)}
            >
              {mini({ ...NO_FLAIR, glow: g.id, neon: flair.neon })}
              <span className="sk-l">{g.label}</span>
            </button>
          ))}
        </div>
        {flair.glow !== 'none' && (
          <div className="row" style={{ borderBottom: 'none', paddingTop: 8 }}>
            <span className="row-desc">Strength</span>
            <div className="sk-seg" role="radiogroup" aria-label="Glow strength">
              <button className={flair.neon ? '' : 'on'} role="radio" aria-checked={!flair.neon} onClick={() => set({ neon: false })}>
                Soft
              </button>
              <button className={flair.neon ? 'on' : ''} role="radio" aria-checked={flair.neon} onClick={() => set({ neon: true })}>
                Neon
              </button>
            </div>
          </div>
        )}

        <div className="panel-section sk-section">
          <span>Tint</span>
        </div>
        <div className="sk-pick" role="listbox" aria-label="Tint">
          {TINTS.map((t) => (
            <button
              key={t.id}
              className={`sk-chip fl ${flair.tint === t.id ? 'on' : ''}`}
              role="option"
              aria-selected={flair.tint === t.id}
              onClick={() => tint(t.id)}
            >
              {mini({ ...NO_FLAIR, tint: t.id })}
              <span className="sk-l">{t.label}</span>
            </button>
          ))}
        </div>

        <div className="panel-section sk-section">
          <span>Effect</span>
        </div>
        <div className="sk-pick" role="listbox" aria-label="Effect">
          {EFFECTS.map((e) => (
            <button
              key={e.id}
              className={`sk-chip fl ${flair.effect === e.id ? 'on' : ''} ${e.id === 'wake' ? 'wake' : ''}`}
              role="option"
              aria-selected={flair.effect === e.id}
              onClick={() => effect(e.id)}
            >
              {mini({ ...NO_FLAIR, effect: e.id }, 28)}
              <span className="sk-l">{e.label}</span>
            </button>
          ))}
        </div>
        <div className="sk-note">
          Your colour stays the base, so the chart still reads at a glance. Wake shows under way.
        </div>
        <button className="btn-primary sk-btn quiet" onClick={onDone}>
          Done
        </button>
      </div>
    </>
  )
}
