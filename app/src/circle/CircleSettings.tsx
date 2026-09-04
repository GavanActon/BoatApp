import { useRef, useState } from 'react'
import { createCircle, inviteText, joinCode } from './api'
import { useCircleStore, type Circle } from './store'
import { joinCircle, leaveCircle } from './sync'
import { haptic } from '../ui/haptics'

/**
 * The Trip sharing section of Settings (a circle in the code, a crew to
 * the person): the skipper card (how this boat is named to friends), the
 * crews this phone is in, and the two doors — start one, or join one by
 * code. Invite opens a card under the circle with the
 * code large and the text ready to copy, and offers the share sheet where
 * there is one — so the tap always shows something, including over plain
 * http on the dev server, where share and clipboard don't exist. On
 * iPhone a link opens in Safari, whose storage isn't the home-screen
 * app's, so the CODE is what always works.
 */
export default function CircleSettings() {
  const skipper = useCircleStore((s) => s.skipper)
  const setSkipper = useCircleStore((s) => s.setSkipper)
  const circles = useCircleStore((s) => s.circles)
  const deviceId = useCircleStore((s) => s.deviceId)
  const deviceKey = useCircleStore((s) => s.deviceKey)
  const addCircle = useCircleStore((s) => s.addCircle)
  const [newName, setNewName] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // the circle whose invite card is open, and the card's own word
  const [inviting, setInviting] = useState<string | null>(null)
  const [inviteNote, setInviteNote] = useState<string | null>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const start = async () => {
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true)
    setNote(null)
    try {
      const c = await createCircle(name, deviceId, deviceKey)
      addCircle(c)
      setNewName('')
      setNote(`Started · ${c.name} · code ${joinCode(c)}`)
    } catch {
      setNote('No answer from the server')
    } finally {
      setBusy(false)
    }
  }

  const join = async () => {
    if (!code.trim() || busy) return
    setBusy(true)
    setNote(null)
    try {
      const c = await joinCircle(code)
      haptic('confirm')
      setCode('')
      setNote(`Joined · ${c.name}`)
    } catch (e) {
      setNote(e instanceof Error && /code/.test(e.message) ? 'Not a sharing code' : 'No crew with that code')
    } finally {
      setBusy(false)
    }
  }

  const invite = (c: Circle) => {
    setNote(null)
    setInviteNote(null)
    setInviting(inviting === c.id ? null : c.id)
  }

  const share = async (c: Circle) => {
    try {
      await navigator.share({ text: inviteText(c, skipper.name) })
      setInviteNote('Sent')
    } catch {
      /* dismissed — the card is still there */
    }
  }

  // the async clipboard needs https; the dev server over the LAN is plain
  // http, where selecting the text and the old copy command still work
  const copy = async (c: Circle) => {
    const text = inviteText(c, skipper.name)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        setInviteNote('Copied')
        return
      }
    } catch {
      /* fall through */
    }
    const ta = textRef.current
    if (ta) {
      ta.focus()
      ta.select()
      try {
        if (document.execCommand('copy')) {
          setInviteNote('Copied')
          return
        }
      } catch {
        /* no copy command either */
      }
    }
    setInviteNote(`Read out the code · ${joinCode(c)}`)
  }

  const leave = async (c: Circle) => {
    setNote(null)
    await leaveCircle(c)
    setNote(`Left · ${c.name}`)
  }

  return (
    <>
      <div className="panel-section">Crews</div>

      <div className="row">
        <div className="row-text">
          <span className="row-title">Skipper card</span>
          <span className="row-desc">name · boat · as friends see you</span>
        </div>
      </div>
      <div className="row circle-fields">
        <input
          type="text"
          value={skipper.name}
          placeholder="Your name"
          maxLength={40}
          aria-label="Your name"
          onChange={(e) => setSkipper({ ...skipper, name: e.target.value })}
        />
        <input
          type="text"
          value={skipper.boat}
          placeholder="Boat"
          maxLength={40}
          aria-label="Boat name"
          onChange={(e) => setSkipper({ ...skipper, boat: e.target.value })}
        />
      </div>

      {circles.map((c) => (
        <div key={c.id}>
          <div className="row">
            <div className="row-text">
              <span className="row-title">{c.name}</span>
              <span className="row-desc numeral">code {joinCode(c)}</span>
            </div>
            <span className="circle-actions">
              <button className="linklike" onClick={() => invite(c)} aria-expanded={inviting === c.id}>
                Invite
              </button>
              <button className="linklike danger" onClick={() => void leave(c)}>
                Leave
              </button>
            </span>
          </div>
          {inviting === c.id && (
            <div className="circle-invite" role="group" aria-label={`Invite to ${c.name}`}>
              <div className="circle-code numeral">{joinCode(c)}</div>
              <textarea
                ref={textRef}
                className="circle-invite-text"
                readOnly
                rows={3}
                value={inviteText(c, skipper.name)}
                aria-label="Invite text"
                onFocus={(e) => e.currentTarget.select()}
              />
              <div className="circle-actions">
                {canShare && (
                  <button className="linklike" onClick={() => void share(c)}>
                    Share
                  </button>
                )}
                <button className="linklike" onClick={() => void copy(c)}>
                  Copy
                </button>
                <button className="linklike dim" onClick={() => setInviting(null)}>
                  Done
                </button>
                {inviteNote && <span className="circle-invite-note">{inviteNote}</span>}
              </div>
            </div>
          )}
        </div>
      ))}

      <div className="row circle-fields">
        <input
          type="text"
          value={newName}
          placeholder={circles.length ? 'Another crew' : 'Name your crew, e.g. Sandies crew'}
          maxLength={40}
          aria-label="New crew name"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void start()}
        />
        <button className="linklike" disabled={!newName.trim() || busy} onClick={() => void start()}>
          Start
        </button>
      </div>
      <div className="row circle-fields">
        <input
          type="text"
          value={code}
          placeholder="Join with a code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Sharing code"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void join()}
        />
        <button className="linklike" disabled={!code.trim() || busy} onClick={() => void join()}>
          Join
        </button>
      </div>
      {note && <div className="circle-note">{note}</div>}
      <div className="circle-note dim">the crew sees · your plan · your trip, cast-off to home · nothing between</div>
    </>
  )
}
