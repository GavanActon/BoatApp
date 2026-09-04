import { useState } from 'react'
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
      <div className="panel-note row-desc">
        Build {BUILD.sha} · {BUILD.at.slice(0, 10)}
      </div>
    </>
  )
}
