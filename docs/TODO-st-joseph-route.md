# TODO: route to St. Joseph Island (through the Soo locks)

Status: **specified, not started** — verified against the real grid 2026-08-30.
Gavan saved a place ("Lisa's") on St. Joseph Island; the router can't reach it.
This doc is written so an agent can pick the work up cold.

## Verified facts (don't re-derive)

Probed headlessly by importing `app/src/routing/waterRouter.ts` in Node,
loading `app/public/data/depthgrid-superior-east.dgrid`, `buildNavMask`,
`routeOnGrid` (Node 24 runs the .ts directly). Findings:

1. **The island is outside the region.** `REGION_BBOX` / the dgrid end at
   south 46.3, east -83.9. Richards Landing (46.293, -84.023) is out of the
   grid, so `snapToWater` fails before anything else matters.
2. **The lower river is NODATA.** Below the locks, Lake George and most of the
   reach toward St. Joseph Channel have no depth data in the NOAA mosaic even
   where they're inside the bbox. No continuous navigable corridor exists.
3. **The locks can never pass the depth test.** The rapids are genuinely
   unnavigable; the canal is ~15–30 m wide against ~127×184 m routing cells
   (`buildNavMask` needs all four fine cells ≥ 2 m); the canal reach is mostly
   NODATA regardless. Routing to just *above* the locks works today
   (clean 8.8 nm leg from Pointe Aux Pins).

## The work

### Code (no data dependency — can start any time)

- [ ] Extend `REGION_BBOX` to roughly south 46.0, east -83.55. Note the weather
      lattice (`GRID_SHAPE` 8×7 over the same bbox) stretches with it —
      cells grow to ~15×17 km, acceptable.
- [ ] **Known-channels override**: a config list of hand-drawn channels
      (polyline + width in m), stamped navigable by `buildNavMask` *after* the
      depth test. First entry: the Canadian recreational lock at the Soo
      (~46.512, -84.339). The rapids stay blocked — the lock is the way
      through, which is true. Keep it pure so it tests headlessly.
- [ ] **Lockage allowance**: a fixed ETA penalty (~30–45 min) for any route leg
      crossing a known channel flagged as a lock, so arrival times stay honest.
- [ ] Wave-model honesty: the marine API doesn't cover the river. Conditions
      there rate on wind alone — nulls are already handled everywhere, but the
      trip verdict copy shouldn't imply wave knowledge it doesn't have.

### Data (needs Gavan — CHS login)

- [ ] Download CHS NONNA tiles covering the St. Marys River, Lake George and
      St. Joseph Channel into `external/nonna/Bathymetry/` (the pipeline
      auto-overlays them; license = non-navigational, tiles stay gitignored).
- [ ] **Datum shift below the locks**: water below the Soo sits ~7 m lower than
      Lake Superior's chart datum. The pipeline must apply per-pool datums when
      converting elevation→depth or every lower-river depth is wrong.
      (NONNA sign trap from CLAUDE-memory applies: GeoTIFF = elevation vs chart
      datum, negative down; the .txt XYZ = depth positive down.)
- [ ] Rebuild `pipeline/build_region.py` outputs; bump data files. Phones must
      re-download the offline bundle afterwards (files are cached by name).

## Acceptance

`routeOnGrid` from the home waters (46.76, -84.58) to Richards Landing returns
a route that threads the Canadian lock, never crosses land or sub-2 m water
outside a declared channel, and the plan's ETA includes the lockage allowance.
