/**
 * The mark: an emoji a skipper picks to be known by, worn inside the
 * boat's crew colour on the chart, in the Crew list and on the card. Any
 * emoji goes — the quick picks are the ones that get a grin, and Surprise
 * me rolls from a longer list. Flair is optional dressing on top: a glow
 * outside the disk, a tint (the disk's finish), an effect (something that
 * moves). The crew colour is always the base, so the chart still reads by
 * colour at a glance.
 *
 * Two renderers share one vocabulary: HTML for the sheet, the list and the
 * popup (where CSS can animate), and a canvas raster for the chart, where
 * MapLibre draws icons from images — its text layer has no colour emoji.
 */

export type Glow = 'none' | 'crew' | 'white' | 'gold' | 'ice' | 'pink'
export type Tint = 'solid' | 'fade' | 'frost' | 'metal' | 'ink' | 'glass'
export type Effect = 'none' | 'sparkle' | 'pulse' | 'halo' | 'wake' | 'bubbles'

export interface Flair {
  glow: Glow
  /** The glow's strength: neon is the brighter, wider one. */
  neon: boolean
  tint: Tint
  effect: Effect
}

export const NO_FLAIR: Flair = { glow: 'none', neon: false, tint: 'solid', effect: 'none' }

/** `plus` marks what could become Sandies Plus one day. Free for now. */
export const GLOWS: { id: Glow; label: string; color: string | null }[] = [
  { id: 'none', label: 'None', color: null },
  { id: 'crew', label: 'Crew', color: null },
  { id: 'white', label: 'White', color: '#ffffff' },
  { id: 'gold', label: 'Gold', color: '#ffd166' },
  { id: 'ice', label: 'Ice', color: '#5ec8ff' },
  { id: 'pink', label: 'Pink', color: '#ff7ac6' },
]
export const TINTS: { id: Tint; label: string; plus?: boolean }[] = [
  { id: 'solid', label: 'Solid' },
  { id: 'fade', label: 'Fade' },
  { id: 'frost', label: 'Frost' },
  { id: 'metal', label: 'Metal', plus: true },
  { id: 'ink', label: 'Ink' },
  { id: 'glass', label: 'Glass', plus: true },
]
export const EFFECTS: { id: Effect; label: string; plus?: boolean }[] = [
  { id: 'none', label: 'None' },
  { id: 'sparkle', label: 'Sparkle', plus: true },
  { id: 'pulse', label: 'Pulse' },
  { id: 'halo', label: 'Halo' },
  { id: 'wake', label: 'Wake' },
  { id: 'bubbles', label: 'Bubbles', plus: true },
]

export const QUICK_PICKS = [
  '🐌', '🍺', '🍹', '🏴‍☠️', '🦆', '🦀',
  '🐐', '🦖', '🦩', '🧜‍♀️', '🍕', '🌭',
  '🐷', '🦈', '🐳', '🦑', '🐙', '🦭',
  '🐢', '🐸', '🦄', '🤠', '🫠', '🍻',
]

const MORE = [
  '🐔', '🦧', '🥴', '🐡', '🦞', '🦜', '🐊', '🦦', '🐧', '🌮', '🥐', '🧀', '🍩', '🎸', '🪩', '🛸',
  '🧟', '🤖', '👽', '🥷', '🧙', '🦸', '🐉', '🦕', '🎃', '🍄', '🌵', '🐝', '🦋', '🎣', '⛵', '🚤',
  '🛶', '🏄', '🤿', '🐬', '🦅', '🦉', '🐻', '🦫', '🐺', '🦊', '🍔', '🌶️', '🥂', '🧊', '🌞', '🌊',
]

/** Surprise me: any of the picks, or one from the longer list — never the one already worn. */
export function surprise(not: string): string {
  const pool = [...QUICK_PICKS, ...MORE].filter((e) => e !== not)
  return pool[Math.floor(Math.random() * pool.length)]
}

const PICTO = /\p{Extended_Pictographic}/u

/** The first user-perceived character of a string (a flag, a family, a
 *  skin-toned hand all count as one), or ''. */
export function firstGrapheme(s: string): string {
  const t = s.trim()
  if (!t) return ''
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter
  if (Seg) {
    for (const x of new Seg(undefined, { granularity: 'grapheme' }).segment(t)) return x.segment
  }
  // no segmenter: a base code point and any joiners, modifiers, selectors that follow it
  const m = /^.(?:\p{M}|\p{Emoji_Modifier}|\u{FE0F}|\u{200D}|[\u{E0020}-\u{E007F}])*(?:\u{200D}.(?:\p{M}|\u{FE0F})*)*/su.exec(t)
  return m ? m[0] : ''
}

/** A mark as the store or the server should keep it: one emoji, or ''. */
export function cleanMark(s: unknown): string {
  if (typeof s !== 'string') return ''
  const g = firstGrapheme(s)
  return g && g.length <= 16 && PICTO.test(g) ? g : ''
}

const GLOW_IDS = new Set<string>(GLOWS.map((g) => g.id))
const TINT_IDS = new Set<string>(TINTS.map((t) => t.id))
const EFFECT_IDS = new Set<string>(EFFECTS.map((e) => e.id))

/** Flair as it came off the wire, or null when there is none worth keeping. */
export function cleanFlair(v: unknown): Flair | null {
  if (!v || typeof v !== 'object') return null
  const f = v as Record<string, unknown>
  const out: Flair = {
    glow: typeof f.glow === 'string' && GLOW_IDS.has(f.glow) ? (f.glow as Glow) : 'none',
    neon: f.neon === true,
    tint: typeof f.tint === 'string' && TINT_IDS.has(f.tint) ? (f.tint as Tint) : 'solid',
    effect: typeof f.effect === 'string' && EFFECT_IDS.has(f.effect) ? (f.effect as Effect) : 'none',
  }
  return out.glow === 'none' && out.tint === 'solid' && out.effect === 'none' ? null : out
}

/** "crew glow · ink · sparkle" — or '' for none. */
export function flairSummary(f: Flair | null): string {
  if (!f) return ''
  const parts: string[] = []
  if (f.glow !== 'none') parts.push(`${GLOWS.find((g) => g.id === f.glow)?.label.toLowerCase()} glow${f.neon ? ' · neon' : ''}`)
  if (f.tint !== 'solid') parts.push(TINTS.find((t) => t.id === f.tint)?.label.toLowerCase() ?? f.tint)
  if (f.effect !== 'none') parts.push(EFFECTS.find((e) => e.id === f.effect)?.label.toLowerCase() ?? f.effect)
  return parts.join(' · ')
}

// ---------- colour arithmetic (the canvas has no color-mix) ----------

const DARK = '#0a1522'
const LIGHT = '#eaf3fb'

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** `t` of the way from a to b. */
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgb(a)
  const [r2, g2, b2] = rgb(b)
  const c = (x: number, y: number) => Math.round(x + (y - x) * t)
  return `rgb(${c(r1, r2)}, ${c(g1, g2)}, ${c(b1, b2)})`
}

export function alpha(hex: string, a: number): string {
  const [r, g, b] = rgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

export function glowColor(f: Flair, crew: string): string | null {
  if (f.glow === 'none') return null
  return GLOWS.find((g) => g.id === f.glow)?.color ?? crew
}

// ---------- HTML: the sheet, the list, the popup ----------

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
}

/** The disk's own CSS — finish, ring, glow — for a mark of `size` px. */
function diskCss(color: string, f: Flair, size: number): string {
  let bg = `background: ${color};`
  let outline = ''
  switch (f.tint) {
    case 'fade':
      bg = `background: linear-gradient(160deg, ${color}, ${mix(color, DARK, 0.45)});`
      break
    case 'frost':
      bg = `background: linear-gradient(160deg, ${LIGHT}, ${color} 70%);`
      break
    case 'metal':
      bg = `background: linear-gradient(135deg, ${color} 0%, #ffffff 42%, ${color} 52%, ${mix(color, DARK, 0.4)} 100%);`
      break
    case 'ink':
      bg = 'background: #101e2e;'
      outline = `outline: ${size >= 40 ? 2.5 : 2}px solid ${color}; outline-offset: -${size >= 40 ? 2.5 : 2}px;`
      break
    case 'glass':
      bg = 'background: rgba(234, 243, 251, 0.12);'
      outline = `outline: 1.5px solid ${color}; outline-offset: -1.5px;`
      break
  }
  const ring = '0 0 0 1.5px rgba(8, 20, 34, 0.6)'
  const g = glowColor(f, color)
  const k = size / 22
  const shadow = !g
    ? ring
    : f.neon
      ? `${ring}, 0 0 ${6 * k}px ${2 * k}px ${g}, 0 0 ${22 * k}px ${8 * k}px ${alpha(g, 0.5)}`
      : `${ring}, 0 0 ${12 * k}px ${4 * k}px ${alpha(g, 0.85)}`
  return `${bg} ${outline} box-shadow: ${shadow};`
}

function starSvg(size: number, pos: string, delay: string): string {
  return (
    `<svg class="mk-spark" viewBox="0 0 10 10" width="${size}" height="${size}" style="${pos} animation-delay: ${delay};">` +
    `<path d="M5 0 6.2 3.8 10 5 6.2 6.2 5 10 3.8 6.2 0 5 3.8 3.8z" fill="currentColor"></path></svg>`
  )
}

/**
 * A mark as an element: `<span class="mk">` sized `size` px, the emoji
 * inside the crew colour, flair around it. `wake` is only worn under way,
 * so the caller says. With no mark the disk is plain — a bigger dot.
 */
export function markHtml(
  size: number,
  mark: string,
  color: string,
  flair: Flair | null,
  opts: { wake?: boolean; dim?: boolean } = {},
): string {
  const f = flair ?? NO_FLAIR
  const s = size
  let inner = ''
  const r = (x: number) => Math.round(x)
  switch (f.effect) {
    case 'sparkle':
      inner +=
        starSvg(r(s * 0.3), `top: ${r(-s * 0.1)}px; right: ${r(-s * 0.12)}px;`, '0s') +
        starSvg(r(s * 0.22), `bottom: ${r(-s * 0.05)}px; left: ${r(-s * 0.12)}px;`, '0.8s') +
        starSvg(r(s * 0.17), `top: ${r(s * 0.08)}px; left: ${r(-s * 0.22)}px;`, '0.4s')
      break
    case 'pulse':
      inner += `<i class="mk-pulse" style="color: ${glowColor(f, color) ?? color};"></i>`
      break
    case 'halo':
      inner += `<i class="mk-halo" style="color: ${color}; inset: -${r(s * 0.2)}px;"></i>`
      break
    case 'wake':
      if (opts.wake) inner += `<i class="mk-wake" style="width: ${r(s * 1.2)}px; height: ${Math.max(2, r(s * 0.12))}px;"></i>`
      break
    case 'bubbles':
      for (const [x, d, rr] of [
        [0.15, '0s', 0.14],
        [0.55, '0.9s', 0.1],
        [0.8, '1.6s', 0.12],
      ] as const) {
        inner += `<i class="mk-bub" style="left: ${r(s * x)}px; top: ${r(s * 0.85)}px; width: ${r(s * rr)}px; height: ${r(s * rr)}px; animation-delay: ${d};"></i>`
      }
      break
  }
  const font = mark ? `font-size: ${r(s * 0.56)}px;` : ''
  const dim = opts.dim ? ' opacity: 0.55;' : ''
  return (
    `<span class="mk" style="width: ${s}px; height: ${s}px; ${font} ${diskCss(color, f, s)}${dim}" aria-hidden="true">` +
    `${inner}<span class="mk-e">${esc(mark)}</span></span>`
  )
}

// ---------- canvas: the chart ----------

/** The chart glyph's disk, in CSS px. Today's dot is 14; the mark needs room. */
export const CHART_MARK_PX = 22
const PAD = 12
const RATIO = 2

/** One image per look; the key names it to the map. */
export function markKey(mark: string, color: string, flair: Flair | null, stale: boolean): string {
  const f = flair ?? NO_FLAIR
  return `mk:${encodeURIComponent(mark)}:${color}:${f.glow}:${f.neon ? 1 : 0}:${f.tint}:${f.effect}:${stale ? 1 : 0}`
}

function star(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath()
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 - Math.PI / 2
    const rr = i % 2 === 0 ? r : r * 0.38
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr)
  }
  ctx.closePath()
  ctx.fill()
}

/**
 * The mark drawn for MapLibre: the disk with its emoji and its still
 * flair (a glow, a halo, a glint — nothing that moves), at 2× for a phone
 * screen. Stale (an aged position) is hollow, as the plain dot is.
 */
export function markImage(mark: string, color: string, flair: Flair | null, stale: boolean): ImageData | null {
  const f = flair ?? NO_FLAIR
  const D = CHART_MARK_PX
  const W = D + PAD * 2
  const canvas = document.createElement('canvas')
  canvas.width = W * RATIO
  canvas.height = W * RATIO
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(RATIO, RATIO)
  const cx = W / 2
  const cy = W / 2
  const R = D / 2
  const disk = () => {
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
  }

  const g = stale ? null : glowColor(f, color)
  if (g) {
    ctx.save()
    ctx.shadowColor = f.neon ? g : alpha(g, 0.85)
    ctx.shadowBlur = f.neon ? 9 : 7
    ctx.fillStyle = g
    disk()
    ctx.fill()
    if (f.neon) {
      ctx.shadowBlur = 4
      ctx.fill()
    }
    ctx.restore()
  }

  // the disk's finish
  if (stale) {
    ctx.strokeStyle = alpha(color, 0.6)
    ctx.lineWidth = 2
    disk()
    ctx.stroke()
  } else {
    let fill: string | CanvasGradient = color
    let stroke: [string, number] | null = null
    if (f.tint === 'fade') {
      const gr = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R)
      gr.addColorStop(0, color)
      gr.addColorStop(1, mix(color, DARK, 0.45))
      fill = gr
    } else if (f.tint === 'frost') {
      const gr = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R)
      gr.addColorStop(0, LIGHT)
      gr.addColorStop(0.7, color)
      fill = gr
    } else if (f.tint === 'metal') {
      const gr = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R)
      gr.addColorStop(0, color)
      gr.addColorStop(0.42, '#ffffff')
      gr.addColorStop(0.52, color)
      gr.addColorStop(1, mix(color, DARK, 0.4))
      fill = gr
    } else if (f.tint === 'ink') {
      fill = '#101e2e'
      stroke = [color, 2]
    } else if (f.tint === 'glass') {
      fill = 'rgba(234, 243, 251, 0.14)'
      stroke = [color, 1.5]
    }
    // the dark ring every glyph wears, under the disk
    ctx.strokeStyle = 'rgba(8, 20, 34, 0.6)'
    ctx.lineWidth = 3
    disk()
    ctx.stroke()
    ctx.fillStyle = fill
    disk()
    ctx.fill()
    if (stroke) {
      ctx.strokeStyle = stroke[0]
      ctx.lineWidth = stroke[1]
      ctx.beginPath()
      ctx.arc(cx, cy, R - stroke[1] / 2, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  if (mark) {
    ctx.save()
    if (stale) ctx.globalAlpha = 0.6
    ctx.font = `${Math.round(D * 0.58)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#eaf3fb'
    ctx.fillText(mark, cx, cy + 1)
    ctx.restore()
  }

  if (!stale) {
    if (f.effect === 'halo' || f.effect === 'pulse') {
      ctx.strokeStyle = alpha(f.effect === 'pulse' ? (g ?? color) : color, f.effect === 'pulse' ? 0.4 : 0.8)
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(cx, cy, R + 4.5, 0, Math.PI * 2)
      ctx.stroke()
    } else if (f.effect === 'sparkle') {
      ctx.fillStyle = '#ffffff'
      star(ctx, cx + R - 1, cy - R + 1, 3.6)
      star(ctx, cx - R + 1, cy + R - 2, 2.6)
      star(ctx, cx - R - 2.5, cy - 2, 2)
    } else if (f.effect === 'bubbles') {
      ctx.fillStyle = 'rgba(234, 243, 251, 0.85)'
      for (const [dx, dy, r] of [
        [R - 3, -R - 3, 1.6],
        [R + 2, -R + 2, 1.2],
        [R - 6, -R - 7, 1.1],
      ] as const) {
        ctx.beginPath()
        ctx.arc(cx + dx, cy + dy, r, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
  return ctx.getImageData(0, 0, W * RATIO, W * RATIO)
}

export const MARK_IMAGE_RATIO = RATIO

/** The wake: a streak the length of a couple of disks, drawn pointing
 *  east, for MapLibre to swing behind the boat by its course. */
export function wakeImage(): ImageData | null {
  const L = CHART_MARK_PX * 1.4
  const H = 6
  const canvas = document.createElement('canvas')
  canvas.width = L * RATIO
  canvas.height = H * RATIO
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(RATIO, RATIO)
  const gr = ctx.createLinearGradient(0, 0, L, 0)
  gr.addColorStop(0, 'rgba(234, 243, 251, 0)')
  gr.addColorStop(1, 'rgba(234, 243, 251, 0.75)')
  ctx.fillStyle = gr
  ctx.beginPath()
  ctx.roundRect(0, H / 2 - 1.5, L, 3, 1.5)
  ctx.fill()
  return ctx.getImageData(0, 0, L * RATIO, H * RATIO)
}
