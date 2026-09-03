/**
 * A tick under the thumb at the moments that matter — cast-off, arrival,
 * joining a circle. Android phones buzz; iPhones ignore the Vibration API
 * and lose nothing. Never for ordinary taps: a phone that buzzes on every
 * touch stops meaning anything at the one that counts.
 */
export function haptic(kind: 'tap' | 'confirm' = 'tap'): void {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    navigator.vibrate?.(kind === 'confirm' ? [12, 40, 18] : 8)
  } catch {
    /* not available */
  }
}
