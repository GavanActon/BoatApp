import { useEffect, useState } from 'react'
import { BUILD, buildReport, REPORT_EMAIL, reportMailto } from '../../diagnostics'
import { BUNDLES, DATA_BASE } from '../../config'
import {
  deleteStoredFile,
  downloadToStore,
  listStored,
  requestPersistence,
  storageEstimate,
} from '../../offline/fileStore'
import { useAppStore } from '../../state/appStore'
import { IconCheck, IconDownload, IconTrash } from '../icons'

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`
  return `${(n / 1e3).toFixed(0)} KB`
}

interface DlState {
  active: boolean
  file: string
  loaded: number
  total: number
  fileIdx: number
  fileCount: number
}

export default function OfflinePanel() {
  const online = useAppStore((s) => s.online)
  const [stored, setStored] = useState(listStored())
  const [dl, setDl] = useState<DlState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void storageEstimate().then(setQuota)
  }, [stored, dl])

  const storedNames = new Set(stored.map((s) => s.name))

  async function downloadBundle(files: string[]) {
    setError(null)
    await requestPersistence()
    const todo = files.filter((f) => !storedNames.has(f))
    try {
      for (let i = 0; i < todo.length; i++) {
        const file = todo[i]
        await downloadToStore(DATA_BASE + file, file, (loaded, total) =>
          setDl({ active: true, file, loaded, total, fileIdx: i + 1, fileCount: todo.length }),
        )
        setStored(listStored())
      }
      setDl(null)
      // data files are re-read at startup — reload so the map switches to local copies
      window.location.reload()
    } catch {
      setDl(null)
      setError('Download failed — check your connection and try again.')
      setStored(listStored())
    }
  }

  // Report a problem: the mail app opens with the diagnostics filled in.
  // Assigning location (not window.open) is what works from an installed
  // iOS PWA — a popup would be blocked or open a blank Safari tab.
  async function emailReport() {
    location.assign(reportMailto(await buildReport()))
  }

  // For the phone with no mail app set up: the same text, to paste anywhere.
  async function copyReport() {
    try {
      await navigator.clipboard.writeText(await buildReport())
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy — try the email button instead.')
    }
  }

  async function removeBundle(files: string[]) {
    if (!confirm('Remove downloaded charts from this device?')) return
    for (const f of files) await deleteStoredFile(f)
    setStored(listStored())
    window.location.reload()
  }

  return (
    <div className="panel">
      {BUNDLES.map((b) => {
        const complete = b.files.every((f) => storedNames.has(f))
        const bundleSize = stored
          .filter((s) => b.files.includes(s.name))
          .reduce((sum, s) => sum + s.size, 0)
        return (
          <div key={b.id} className="bundle glass-inset">
            <div className="bundle-head">
              <div>
                <div className="row-title">{b.name}</div>
                <div className="row-desc">{b.description}</div>
              </div>
            </div>

            {dl?.active && (
              <div className="dl-progress">
                <div className="dl-progress-label">
                  <span>
                    {dl.file} ({dl.fileIdx}/{dl.fileCount})
                  </span>
                  <span className="numeral">
                    {fmtBytes(dl.loaded)}
                    {dl.total > 0 ? ` / ${fmtBytes(dl.total)}` : ''}
                  </span>
                </div>
                <div className="dl-bar">
                  <div
                    className="dl-bar-fill"
                    style={{ width: dl.total > 0 ? `${(dl.loaded / dl.total) * 100}%` : '30%' }}
                  />
                </div>
              </div>
            )}

            {error && <div className="dl-error">{error}</div>}

            <div className="bundle-actions">
              {complete ? (
                <>
                  <span className="bundle-status ok">
                    <IconCheck size={16} /> Downloaded · {fmtBytes(bundleSize)}
                  </span>
                  <button className="icon-btn danger" onClick={() => void removeBundle(b.files)}>
                    <IconTrash size={18} />
                  </button>
                </>
              ) : dl?.active ? (
                <span className="bundle-status">Downloading…</span>
              ) : (
                <button
                  className="btn-primary"
                  disabled={!online}
                  onClick={() => void downloadBundle(b.files)}
                >
                  <IconDownload size={18} />
                  {online ? 'Download for offline use' : 'Connect to download'}
                </button>
              )}
            </div>
          </div>
        )
      })}

      {quota && quota.quota > 0 && (
        <div className="quota row-desc">
          Storage: {fmtBytes(quota.usage)} used of {fmtBytes(quota.quota)} available
        </div>
      )}

      <div className="panel-note row-desc">Charts offline · weather shows its age</div>

      <div className="panel-section">Something wrong?</div>
      <div className="row">
        <div className="row-text">
          <div className="row-title">Report a problem</div>
          <div className="row-desc">
            Opens an email to {REPORT_EMAIL} with the build, your position and the age of every
            forecast already filled in. Just say what happened.
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
      <div className="panel-note row-desc">
        Build {BUILD.sha} · {BUILD.at.slice(0, 10)}
      </div>
    </div>
  )
}
