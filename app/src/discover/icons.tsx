import { LEVEL_COLORS } from './setup'
/** Achievement glyphs — stroke icons on the app's 24-grid, one style. */

export type AchIcon =
  | 'talk'
  | 'boat'
  | 'home'
  | 'lines'
  | 'club'
  | 'tab'
  | 'shame'
  | 'slow'
  | 'fast'
  | 'nose'
  | 'flag'
  | 'map'
  | 'note'
  | 'north'
  | 'back'
  | 'via'
  | 'light'
  | 'grid'
  | 'log'
  | 'laker'
  | 'dip'
  | 'like'
  | 'glassy'
  | 'called'
  | 'distracted'
  | 'dawn'
  | 'sun'
  | 'dusk'
  | 'helm'
  | 'rain'
  | 'ticket'

const PATHS: Record<AchIcon, string> = {
  talk: '<path d="M4 5h16v10H9l-5 4Z"/>',
  boat: '<path d="M3 15h18l-2 4H5Z"/><path d="M6 15V9h9l3 6"/><path d="M9 9V5"/>',
  home: '<path d="M4 11 12 4l8 7"/><path d="M6 10v10h12V10"/>',
  lines: '<path d="M6 4v9a4 4 0 0 0 8 0V6"/><path d="M14 20h4"/><circle cx="16" cy="17" r="2.5"/>',
  club: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  tab: '<path d="M6 4h12v16l-3-2-3 2-3-2-3 2Z"/><path d="M9 9h6M9 13h4"/>',
  shame: '<path d="M12 3a7 7 0 1 0 7 7"/><path d="M12 3v7h7"/><path d="M5 20h14"/>',
  slow: '<path d="M4 18c3-2 4-8 8-8s5 6 8 4"/><circle cx="6" cy="18" r="1.5" fill="currentColor"/>',
  fast: '<path d="M3 12h11"/><path d="M10 7l5 5-5 5"/><path d="M17 5v14"/>',
  nose: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h13l-3 4 3 4H5Z"/>',
  map: '<path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20Z"/>',
  note: '<path d="M5 4h14v16H5Z"/><path d="M8 9h8M8 13h5"/>',
  north: '<path d="M12 3v18"/><path d="M7 8l5-5 5 5"/>',
  back: '<path d="M20 12H6"/><path d="M11 7l-5 5 5 5"/>',
  via: '<path d="M4 18c4 0 4-12 8-12s4 12 8 12"/>',
  light: '<path d="M9 21h6l-1-12h-4Z"/><path d="M8 9h8M12 3v3"/><path d="M5 6l2 2M19 6l-2 2"/>',
  grid: '<path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5"/><path d="M4 19.5h16"/>',
  log: '<path d="M6 3h12v18H6Z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
  laker: '<path d="M2 17h20l-2 3H4Z"/><path d="M5 17V9h5l2-4h8v12"/>',
  dip: '<path d="M3 14c3 0 3-3 6-3s3 3 6 3 3-3 6-3"/><path d="M3 19c3 0 3-3 6-3s3 3 6 3 3-3 6-3"/>',
  like: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z"/>',
  glassy: '<path d="M3 12h18"/><path d="M6 8c2 0 2 1 4 1s2-1 4-1 2 1 4 1"/><path d="M6 16c2 0 2 1 4 1s2-1 4-1 2 1 4 1" opacity="0.5"/>',
  called: '<path d="M4 13l5 5L20 7"/>',
  distracted: '<path d="M3 18c3 0 3-6 6-6s3 6 6 6 3-8 6-8"/><circle cx="20" cy="6" r="1.5" fill="currentColor"/>',
  dawn: '<path d="M3 17h18"/><path d="M6 17a6 6 0 0 1 12 0"/><path d="M12 3v3M5 8l2 2M19 8l-2 2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  dusk: '<path d="M3 17h18"/><path d="M6 17a6 6 0 0 1 12 0"/><path d="M12 8V5"/><path d="M9 20h6"/>',
  helm: '<path d="M8.2 4.5H15.8L20.5 19.5H3.5Z"/><path d="M12 8.5l2.2 6.1L12 13.3l-2.2 1.3Z" fill="currentColor"/>',
  rain: '<path d="M7 15a4 4 0 0 1 1-7.9A5 5 0 0 1 17.5 9 3.5 3.5 0 0 1 17 15Z"/><path d="M9 18l-1 2M13 18l-1 2M17 18l-1 2"/>',
  ticket: '<path d="M4 8a2 2 0 0 0 2-2h12a2 2 0 0 0 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 0-2 2H6a2 2 0 0 0-2-2v-3a2 2 0 0 0 0-4Z"/><path d="M12 6v14" stroke-dasharray="2 2"/>',
}

export function AchGlyph({ icon, size = 18 }: { icon: AchIcon; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: PATHS[icon] }}
    />
  )
}

/** The Discover glyph: a four-point rose, inside a ring that fills as
 *  achievements are earned. Done-colour, never the sea ramp. */
export function RoseRing({
  frac,
  size = 32,
  full = false,
  level,
  segs,
  numeral = false,
}: {
  frac: number
  size?: number
  full?: boolean
  /** Colours the rose by level; without it, `full` colours it done. */
  level?: number
  /** Count instead of fill: n segments, `done` of them lit — the current
   *  chapter's rows, readable as 1/4 at a glance. Overrides `frac`. */
  segs?: { n: number; done: number }
  /** The level as a numeral in place of the rose — one mark, not a badge. */
  numeral?: boolean
}) {
  const rose =
    level != null && level > 0
      ? LEVEL_COLORS[Math.min(level, LEVEL_COLORS.length - 1)]
      : full
        ? 'var(--c-track)'
        : 'currentColor'
  const lit = 'var(--c-track)'
  const cx = size / 2
  const r = size * 0.375
  const c = 2 * Math.PI * r
  const k = size / 32
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={cx} cy={cx} r={r} fill="none" stroke="rgba(126,178,224,0.22)" strokeWidth="2" />
      {segs &&
        segs.n > 0 &&
        Array.from({ length: segs.n }, (_, i) => {
          const gap = Math.min(5, c / segs.n / 3.5)
          const len = c / segs.n - gap
          const on = i < segs.done
          return (
            <circle
              key={i}
              cx={cx}
              cy={cx}
              r={r}
              fill="none"
              stroke={on ? lit : 'rgba(126,178,224,0.2)'}
              strokeWidth={on ? 2.6 : 2}
              strokeLinecap="round"
              strokeDasharray={`${len.toFixed(2)} ${(c - len).toFixed(2)}`}
              strokeDashoffset={-gap / 2}
              transform={`rotate(${-90 + (360 * i) / segs.n} ${cx} ${cx})`}
              style={{ transition: 'stroke 0.4s ease' }}
            />
          )
        })}
      {!segs && frac > 0 && (
        <circle
          cx={cx}
          cy={cx}
          r={r}
          fill="none"
          stroke="var(--c-track)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${(c * Math.min(1, frac)).toFixed(2)} ${c.toFixed(2)}`}
          transform={`rotate(-90 ${cx} ${cx})`}
          style={{ transition: 'stroke-dasharray 0.6s ease' }}
        />
      )}
      {numeral && level != null && level > 0 ? (
        <text
          x={cx}
          y={cx}
          textAnchor="middle"
          dominantBaseline="central"
          fill={rose}
          fontSize={size * 0.44}
          fontWeight={800}
          style={{ fontVariantNumeric: 'tabular-nums', transition: 'fill 0.6s ease' }}
        >
          {level}
        </text>
      ) : (
        <g transform={`translate(${cx} ${cx}) scale(${k})`} fill={rose} style={{ transition: 'fill 0.6s ease' }}>
          <path d="M0 -6.5 L1.6 -1.6 L6.5 0 L1.6 1.6 L0 6.5 L-1.6 1.6 L-6.5 0 L-1.6 -1.6 Z" />
        </g>
      )}
    </svg>
  )
}
