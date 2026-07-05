---
name: verify
description: Build, launch and drive the Sandies chartplotter PWA to verify changes end-to-end in a real browser.
---

# Verifying the Sandies PWA

## Build / launch
- `cd app && npm run build` — runs `tsc -b` (typecheck) + vite build.
- `cd app && npm run dev` — dev server; port 5173 is often taken by the user's own instance, vite falls back to 5174. Read the printed URL.
- `npm run lint` — oxlint.

## Drive (Playwright)
- Playwright browsers live in `%LOCALAPPDATA%\ms-playwright`. Install the `playwright` npm package in a scratch dir (not the repo) and `npx playwright install chromium --only-shell` if the build revision mismatches.
- Use an iPhone-ish context: `{ viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true, hasTouch: true }`.
- In dev builds the MapLibre map is exposed as `window.__map` (see MapView.tsx). Wait for `window.__map && window.__map.loaded()`, then drive geography deterministically:
  `window.__map.jumpTo({center, zoom})` + `window.__map.project([lon, lat])` → `page.mouse.click(x, y)`.
- Tab dock buttons match `getByRole('button', {name: '<Tab>', exact: true})` — `exact` matters because top-bar chips can contain the same word.
- Weather comes from live Open-Meteo (no key). `context.setOffline(true)` exercises the IndexedDB forecast-cache fallback (look for the `offline ·` age badge).
- Spoof GPS via context `geolocation` + `permissions: ['geolocation']` — test both a fix far outside `REGION_BBOX` (start-point fallback) and one on the bay (auto-follow on load).
- Read map GeoJSON with `map.getSource(id).serialize().data` (`._data` is not reliable).
- The bottom tab dock is covered while a sheet is open — `.sheet-close` first, then switch tabs.

## Known traps in app code
- React StrictMode double-runs effects in dev: `init*()` singletons (weatherLayer, routeLayer, planner) must be guarded run-once or handlers/intervals register twice — a double-registered *toggle* handler cancels itself and looks like "nothing happened".

`withMap()` runs its callback immediately once the style has loaded (it tracks its own ready flag set by the `'load'` event), and queues callbacks made before that. It no longer gates on `map.loaded()` — that returned false during any camera animation and used to drop mid-animation calls forever. `getMap()` still returns the map before the style loads; only take that direct path for things that don't touch style layers (markers, easeTo).

## Flows worth driving
- Trip monitoring: plan a trip → Start trip (starts track recording, chip shows "X nm to go") → move the boat with `context.setGeolocation(...)` then `window.dispatchEvent(new Event('online'))` to force a quiet progress replan without waiting for the 2-min tick → at the destination the plan flips to the ride home ("Home" in the timeline).
- Tap water → depth popup (regression for any map click-handler change).
- Trip tab → preset destination → verdict card + timeline; close sheet → route line + trip chip on map.
- "Pick on map" → tap water (plans) / tap far inland (clean "No water route found" error).
- Router itself can be exercised headlessly: `app/src/routing/waterRouter.ts` is dependency-free; Node 24 imports it directly (type stripping) — load `app/public/data/*.dgrid`, `buildNavMask`, `routeOnGrid`, then check min depth along the track.
