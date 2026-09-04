import { useEffect, useState } from 'react'
import { clearDevLog, devLogLines, devLogOn, lastUpload, onDevLog, setDevLog, shareDevLog, uploadDevLog } from '../../devlog'
import { BUILD, buildReport, REPORT_EMAIL, reportMailto } from '../../diagnostics'
import { track } from '../../stats/core'

/**
 * Report a problem — the last thing in Settings, where a person looking
 * for a way to say "the wind thing was wrong" ends up. The mail app opens
 * with the diagnostics filled in; Copy details is for the phone with no
 * mail app set up.
 */
export default function ReportProblem() {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Assigning location (not window.open) is what works from an installed
  // iOS PWA — a popup would be blocked or open a blank Safari tab.
  async function emailReport() {
    track('report', { how: 'email' })
    location.assign(reportMailto(await buildReport()))
  }

  async function copyReport() {
    track('report', { how: 'copy' })
    try {
      await navigator.clipboard.writeText(await buildReport())
      setCopied(true)
      setError(null)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy — try the email button instead.')
    }
  }

  return (
    <>
      <div className="panel-section">Something wrong?</div>
      <div className="row">
        <div className="row-text">
          <div className="row-title">Report a problem</div>
          <div className="row-desc">
            Opens an email to {REPORT_EMAIL} with the build, your position and the age of every forecast
            already filled in. Just say what happened.
          </div>
        </div>
      </div>
      <div className="report-actions">
        <button className="btn-primary" onClick={() => void emailReport()}>
          Email a report
        </button>
        <button className="btn-secondary" onClick={() => void copyReport()}>
          {copied ? 'Copied' : 'Copy details'}
        </button>
      </div>
      {error && <div className="panel-note row-desc">{error}</div>}
      <DevLogRows />
      <div className="panel-note row-desc">
        Build {BUILD.sha} · {BUILD.at.slice(0, 10)}
      </div>
    </>
  )
}

/** The dev log: off for everyone until switched on here; then a count of
 *  what it holds and the two ways out — upload for a code, share as a file. */
function DevLogRows() {
  const [, tick] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => onDevLog(() => tick((n) => n + 1)), [])
  const on = devLogOn()
  const last = lastUpload()

  const upload = async () => {
    setBusy(true)
    setNote(null)
    try {
      const u = await uploadDevLog()
      track('devlog', { how: 'upload' })
      setNote(`Uploaded · code ${u.code}`)
    } catch (e) {
      setNote(`Upload failed · ${e instanceof Error ? e.message : 'no answer'}`)
    } finally {
      setBusy(false)
    }
  }
  const share = async () => {
    const r = await shareDevLog()
    track('devlog', { how: 'share', r })
    setNote(r === 'shared' ? 'Shared' : r === 'copied' ? 'Copied' : 'Could not share')
  }
  const copyLink = async () => {
    if (!last) return
    try {
      await navigator.clipboard.writeText(last.url)
      setNote('Link copied')
    } catch {
      setNote(last.url)
    }
  }

  return (
    <>
      <label className="row">
        <div className="row-text">
          <span className="row-title">Dev log</span>
          <span className="row-desc">
            {on
              ? `${devLogLines()} lines · boots, freezes, the chart's context, refused fixes, failed posts`
              : 'records what the app is doing, for a bug that leaves no trace · includes your position'}
          </span>
        </div>
        <input type="checkbox" className="switch" checked={on} onChange={(e) => setDevLog(e.target.checked)} />
      </label>
      {on && (
        <>
          <div className="report-actions">
            <button className="btn-primary" disabled={busy} onClick={() => void upload()}>
              {busy ? 'Uploading…' : 'Upload log'}
            </button>
            <button className="btn-secondary" onClick={() => void share()}>
              Share log
            </button>
          </div>
          <div className="circle-actions devlog-actions">
            {last && (
              <button className="linklike" onClick={() => void copyLink()}>
                Copy link · {last.code}
              </button>
            )}
            <button className="linklike dim" onClick={() => clearDevLog()}>
              Clear
            </button>
            {note && <span className="circle-invite-note">{note}</span>}
          </div>
        </>
      )}
    </>
  )
}
