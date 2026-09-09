import { useAppStore } from '../state/appStore'

/**
 * Text size for the chrome. Three stops — standard (as designed), large
 * (×1.3), larger (×1.6) — applied as one CSS variable, `--ui-scale`, plus a
 * class the strip uses to show fewer hours across so the numbers stay
 * whole (10 · 8 · 6). Auto reads the phone: iOS hands a page its Dynamic
 * Type size through the `-apple-system-body` font, 17 px at the default
 * setting, more when the person has asked for bigger text everywhere. The
 * app used to pin every size in pixels and ignore that ask.
 */

export type TextStop = 'standard' | 'large' | 'larger'

const SCALE: Record<TextStop, number> = { standard: 1, large: 1.3, larger: 1.6 }
const CLASSES: TextStop[] = ['standard', 'large', 'larger']
const IOS_BODY_PX = 17

/** What the phone asks for, as one of our stops; standard where a browser
 *  has no such font (everything but iOS) or says nothing unusual. */
export function phoneTextStop(): TextStop {
  if (typeof document === 'undefined') return 'standard'
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;font:-apple-system-body;'
  probe.textContent = 'M'
  document.body.append(probe)
  const px = parseFloat(getComputedStyle(probe).fontSize) || 0
  probe.remove()
  if (!px || px < IOS_BODY_PX * 1.12) return 'standard'
  return px < IOS_BODY_PX * 1.4 ? 'large' : 'larger'
}

/** The stop in force: the setting, or the phone's when the setting is auto. */
export function currentTextStop(): TextStop {
  const t = useAppStore.getState().textSize
  return t === 'auto' ? phoneTextStop() : t
}

function apply() {
  const stop = currentTextStop()
  const root = document.documentElement
  root.style.setProperty('--ui-scale', String(SCALE[stop]))
  for (const c of CLASSES) root.classList.toggle(`ui-${c}`, c === stop)
}

let inited = false

export function initTextScale() {
  if (inited) return
  inited = true
  apply()
  useAppStore.subscribe((s, prev) => {
    if (s.textSize !== prev.textSize) apply()
  })
  // the phone's own setting can change while we're in the background
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && useAppStore.getState().textSize === 'auto') apply()
  })
}
