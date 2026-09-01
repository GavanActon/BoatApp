# St. Joseph Island routing (through the Soo locks)

Status: **routing works end-to-end as of 2026-09-01** — home waters → Lisa's
probes at 56.0 nm through the Canadian lock (C:/tmp/pwscratch/locks2.mjs).
This doc keeps the verified facts and what remains.

## What was done (2026-09-01)

- `REGION_BBOX` extended to west -85.3, south 46.0, east -83.55, north 47.5
  (St. Joseph + north Superior in one rebuild; Gavan's call). Weather lattice
  bumped 8×7 → 9×9 (`GRID_SHAPE`, `fetch_rdwps.py` COLS/ROWS, grid cache key
  v1→v2) so cells stay ~15×18 km. `MAX_BOUNDS` derives from the bbox.
- CHS NONNA tiles for the river + St. Joseph + north shore dropped in
  `external/nonna/Bathymetry/` and baked in (`build_region.py` run).
- **Known channels** (`KNOWN_CHANNELS` in routing/channels.ts — a pure
  module so Node headless probes import the real list, stamped by
  `buildNavMask` AFTER the depth test, shallow tier): the Canadian lock canal
  (flagged `lock`), two St. Marys river channels, and the Narrows at
  Campement d'Ours. The three river lines were NOT hand-drawn: least-cost
  paths over the fine dgrid (charted soundings cheap, NODATA dear),
  constrained to OSM water polygons decoded from the basemap pmtiles —
  each line has ≤1 uncharted cell. Derivation scripts:
  session scratchpad `carve2.mjs`/`carve3.mjs` (pattern worth keeping).
- **Lockage**: `LOCKAGE_MIN` (40) in waterRouter.ts; `RouteResult.locks`
  carries each gate with its distance-run; `lockDelayMin()` feeds planner
  minutes, TripCard durations, itinerary sample times (outbound AND the
  re-crossing on the way home), and the departure-window sweep.
- Wave honesty below the locks: already handled — `conditionFor` rates on
  wind alone when `waveM` is null; nothing prints invented wave numbers.

## Verified facts (don't re-derive)

- NONNA below the locks is referenced to the LOCAL (Lake Huron) chart datum,
  so depth = -elevation needs **no per-pool datum shift**: the Soo basin
  probes 9.6 m — sensible harbour depth — and NOAA is NODATA below the locks
  so no cross-datum mixing exists. (The old "~7 m shift" worry is resolved.)
- The rapids stay unroutable (never stamped); the canal corridor is the only
  way through, which is true on the water.
- Live under-way ETA ("X nm to go" chip) does not add lockage for a lock
  still ahead — known small gap, acceptable for now.

## Remains

- [ ] Phones must re-download the offline bundle (files cached by name).
- [ ] Optional data upgrade: NONNA-10 portal tiles for the river reaches
      (4640N08430W, 4640N08420W, 4650N08430W, 4630N08420W, 4630N08410W)
      would replace the two derived river channel stamps with real
      four-cell-deep soundings; the lock canal stamp stays either way.
- [ ] Optional UI: TripCard could say "includes ~40 min lockage" when
      `route.locks` is non-empty (check DESIGN-SPEC before adding).
