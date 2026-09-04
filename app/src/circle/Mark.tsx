import { markHtml, type Flair } from './marks'

/**
 * A boat's mark as an element: the emoji inside the crew colour, flair
 * around it. One renderer (mark.ts) serves this, the popup's HTML string
 * and — as a raster — the chart, so the three always agree.
 */
export default function Mark({
  size,
  mark,
  color,
  flair,
  wake,
  dim,
  className,
}: {
  size: number
  mark: string
  color: string
  flair: Flair | null
  /** Under way: the wake effect shows only then. */
  wake?: boolean
  dim?: boolean
  className?: string
}) {
  return (
    <span
      className={className ? `mk-wrap ${className}` : 'mk-wrap'}
      dangerouslySetInnerHTML={{ __html: markHtml(size, mark, color, flair, { wake, dim }) }}
    />
  )
}
