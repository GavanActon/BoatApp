/**
 * Small colour helpers for the run's lanes.
 *
 * The lane's motion is carried by the gradient itself rather than by anything
 * riding on top of it, so the highlight has to be built out of the same
 * colours the sea state already uses — a lightened version of whatever band
 * happens to be under it, never a colour of its own. A white streak sliding
 * along would read as a separate mark; a bright patch of the SAME water reads
 * as the water moving.
 */

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

/** Mix a hex colour toward white by `amount` (0..1), as an rgb() string. */
export function lighten(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex)
  const m = (c: number) => Math.round(c + (255 - c) * amount)
  return `rgb(${m(r)}, ${m(g)}, ${m(b)})`
}
