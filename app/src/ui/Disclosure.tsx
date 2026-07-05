import { useState, type ReactNode } from 'react'

/**
 * A collapsed-by-default section: title + a one-line summary of what's
 * inside, chevron to expand. The app's progressive-disclosure primitive —
 * configuration and admin live behind these; decisions and answers never do.
 * Always starts collapsed: power users tap once, everyone else reads the
 * summary and moves on.
 */
export default function Disclosure({
  title,
  summary,
  children,
}: {
  title: string
  summary?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`disc${open ? ' disc-open' : ''}`}>
      <button className="disc-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="disc-title">{title}</span>
        {!open && summary && <span className="disc-sum">{summary}</span>}
        <svg className="disc-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 10l4 4 4-4" />
        </svg>
      </button>
      {open && <div className="disc-body">{children}</div>}
    </div>
  )
}
