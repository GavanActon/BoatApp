import { useState } from 'react'
import { createCircle, inviteText, joinCode } from './api'
import { useCircleStore, type Circle } from './store'
import { joinCircle, leaveCircle } from './sync'

/**
 * The Circle section of Settings: the skipper card (how this boat is named
 * to friends), the circles this phone is in, and the two doors — start
 * one, or join one by code. Invites go out the share sheet as a text with
 * the code in it; on iPhone a link opens in Safari, whose storage isn't
 * the home-screen app's, so the CODE is what always works.
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
      setNote('No answer from the circle')
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
      setCode('')
      setNote(`Joined · ${c.name}`)
    } catch (e) {
      setNote(e instanceof Error && /code/.test(e.message) ? 'Not a circle code' : 'No such circle')
    } finally {
      setBusy(false)
    }
  }

  const invite = async (c: Circle) => {
    const text = inviteText(c, skipper.name)
    try {
      if (navigator.share) {
        await navigator.share({ text })
        return
      }
    } catch {
      /* dismissed — fall through to the clipboard */
    }
    try {
      await navigator.clipboard.writeText(text)
      setNote(`Invite copied · code ${joinCode(c)}`)
    } catch {
      setNote(`Code · ${joinCode(c)}`)
    }
  }

  const leave = async (c: Circle) => {
    setNote(null)
    await leaveCircle(c)
    setNote(`Left · ${c.name}`)
  }

  return (
    <>
      <div className="panel-section">Circle</div>

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
        <div className="row" key={c.id}>
          <div className="row-text">
            <span className="row-title">{c.name}</span>
            <span className="row-desc numeral">code {joinCode(c)}</span>
          </div>
          <span className="circle-actions">
            <button className="linklike" onClick={() => void invite(c)}>
              Invite
            </button>
            <button className="linklike danger" onClick={() => void leave(c)}>
              Leave
            </button>
          </span>
        </div>
      ))}

      <div className="row circle-fields">
        <input
          type="text"
          value={newName}
          placeholder={circles.length ? 'Another circle' : 'Name a circle, e.g. Sandies crew'}
          maxLength={40}
          aria-label="New circle name"
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
          aria-label="Circle code"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void join()}
        />
        <button className="linklike" disabled={!code.trim() || busy} onClick={() => void join()}>
          Join
        </button>
      </div>
      {note && <div className="circle-note">{note}</div>}
      <div className="circle-note dim">shared per trip · position · where to · when · nothing kept</div>
    </>
  )
}
