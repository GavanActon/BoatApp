# Discover — the achievements trial

Branch `discover`, served from its own origin. Nothing in this document
applies to `main` or to DESIGN-SPEC.md until the trial earns a merge.

Mock (design canvas, seven boards in flow order):
https://claude.ai/code/artifact/e9b349a2-5a54-447f-b680-bdfa2a8d7864

## Why a separate origin

`main` deploys to sandies.app from GitHub Pages, which serves one site per
repo. The trial deploys from `.github/workflows/trial.yml` to Cloudflare
Pages as project `sandies-next`. A different origin is a different PWA:
separate install, separate `sandies-prefs`, separate offline store. The
family's real app cannot be touched by anything on this branch.

## One-time Cloudflare setup (dashboard)

1. Cloudflare dashboard → My Profile → API Tokens → Create Token →
   template "Edit Cloudflare Workers", or a custom token with
   **Account · Cloudflare Pages · Edit**. Copy it.
2. The account id is already in the workflow (it is not a secret).
3. GitHub → repo → Settings → Secrets and variables → Actions → add
   `next` (the Cloudflare API token).
4. Push to `discover` (or run the workflow by hand). The first run creates
   the project; the site is at `https://sandies-next.pages.dev`.
5. Optional custom domain: Pages → sandies-next → Custom domains → add
   `next.sandies.app`. Cloudflare adds the CNAME itself because the zone is
   already on the account. Keep the record DNS-only (grey cloud) like the
   apex records.
6. On the phone: open the trial URL in Safari, Add to Home Screen. Download
   the offline bundle again on this origin — the store is per-origin.

## What the trial builds

Decided 2026-09-02 (Gavan):

- **Achievements, not levels or points.** Every achievement is an observed
  fact on state the app already has: arrival latch, trip start, plan ETA,
  tracks, persisted settings. Nothing is earned by tapping a row.
- **Nothing hidden.** Every achievement is visible from day one, locked ones
  with a two-word hint of the gesture. The hint is the onboarding.
- **Unlocks get a bit of dopamine.** Earning one is a moment, not a quiet
  tile: the arrival card (and the sheet) plays the unlock. Still no
  streaks, no verdicts, no red.
- **Tone.** The Sandies goes like a party: setup names stay straight, the
  going names carry a little edge. Freshwater words only (Laker, never
  Old Salt).
- **Season places.** A flag fills on arrival, dated. No clocks, no order.
  Sandies north, Sandies south, Parisienne light (island's south tip),
  Sydney's Shoal `46.489, -84.554`, Batchawana Bay.
- **The line.** Nothing for a rough band. Nothing for consecutive days.
  Nothing that rewards drinking on the water. One trip a day counts.

### The list

Setup (straight): All Talk · Knows the Boat · Has a Home · Address Book · Cartographer ·
Local Knowledge · Points North · Ride Home · Scenic Route · Off the Grid ·
Logbook

Going (edge): Lines Off · Home Sweet Home · Bar Tab (Sandies ×3) ·
You Like It Here! (a second place ×3) · Double Dip · Lighthouse · Laker
(50 nm/season) · Last Minute Club (trip started ≤1 min after open, not on
a reload mid-trip) · Speedsteer / Slowpoke (vs the plan's arrival, ≥10 %
of the run and ≥5 min, never vs SOG) · On the Nose (±2 min) · Glassy ·
Called It (felt sea = forecast band, three trips running) · Got Distracted ·
First Light · Sunburn · Closing Time · Walk of Shame (home after back-by) ·
Designated Skipper · Overdressed · Rain Check · Season Ticket

## What is built (2026-09-03)

Everything under `app/src/discover/`:

- `registry.ts` — the 32 achievements, each a check over observed state.
- `engine.ts` — subscribes to the app's stores; notes gestures a value
  can't show (`touched`); keeps the trip's context cast-off → dock;
  records arrivals (planner latch + a proximity sampler every 20 s,
  once per place per day) and outings; evaluates on every change.
- `log.ts` — Dexie `arrivals` + `outings` (db v4) mirrored in memory.
- `store.ts` — `sandies-discover`: earned, fresh, unlock queue, touched,
  season flags, the trip context, the glyph's hidden flag.
- `setup.ts` — six set-up chapters, 21 rows, each an observed fact.
- `season.ts` — the five places; the Sandies pair placed on the depth
  grid's two land masses (confirm on the water).
- UI: `DiscoverGlyph` (top bar), `DiscoverSheet` (hub · set up · season ·
  one achievement), `ArrivalStrip` (on the live trip card once home:
  sea felt + what was earned), `UnlockToast` (the moment).

Mount points: `App.tsx` (glyph, sheet, toast, init), `appStore.ts`
(`'discover'` in SheetTab), `TripCard.tsx` (the strip), `db.ts` (v4),
`LayersPanel.tsx` (the cruise row lights up when a Discover row sent you),
`OfflinePanel.tsx` (the seven-day note reads `install.ts`'s standalone check).

Driven end to end in a real browser (Playwright, iPhone viewport,
spoofed GPS): welcome (Get set up) → levels, First voyage open → All Talk → glyph → hub → set up
(cruise/units/limits/scale in place) → season → detail → Start trip →
Lines Off → arrival latched at the Sandies → home → sea felt → End →
seven earned, one outing and two arrivals in the log, no console errors.

Rules the engine keeps (from the code review, 2026-09-03):

- Arrival is the boat's own fix within 0.5 nm of the destination; the
  planner's latch is trusted only when it was measured from the boat.
  One-way trips arrive too.
- Being somewhere counts from the WATER (`isAfloat`), never at home,
  never at a hidden place, once per place per day.
- The sea-felt question sits on the live card from arrival; a trip ended
  before it was answered is asked once more over the chart (skippable).
- Saved trips and pin drags are not gestures; only the skipper's own
  changes touch cruise / back-by / somewhere-new.
- One trip a day for every count of outings.
- Unlock moments: at most three queued, never replayed after a reload.

Trial-harness notes: progress replans fire on `visibilitychange`, not
`online`; a spoofed fix must be AFLOAT (the config Sandies point is a
beach — park the boat just off it); `window.__gps` reads the live fix.

## Gavan's phone-test rounds (2026-09-03)

- Set-up rows trimmed to what is worth changing; each chunk finished is a
  LEVEL (Dock Sitter → Deckhand → Bay Rat → Regular → Point Reader →
  Skipper → Commodore), with its own moment.
- The glyph sits at the LEFT of the top bar; the unlock is a small glass
  pill under the strip (sparks, a shine, a haptic where allowed).
- Going achievements need a real outing — arrived, a mile or more — so a
  tap on Start at the dock earns nothing.
- Progressive disclosure: the hub shows Next up (the current chunk's
  undone rows), Levels and Season as rows, three recent earned, Locked
  folded; the Levels page is an accordion with the current chunk open.
- SET ONCE HERE, THEN FOUND THERE: cruise speed is set in place the first
  time with "from now on · Settings › Boat" under it; done rows wear the
  value and point, with a chip on the top bar naming the place until the
  value moves.
- Settings reorganised by importance (shared UI, `LayersPanel.tsx`): BOAT
  open at the top — cruise speed, sea-state scale, low power — then More:
  Chart · Motion · Weather · Units as groups folded to a line each that
  open on touch. Cruise speed now lives in Settings as well as on the
  trip card's chip.
- LIMITS DROPPED entirely (they reached one dot on the Places rows and
  nothing else): no limits row in Places or Settings, no Overdressed;
  Knows the Boat = cruise speed + low power touched. `waveLimitM` /
  `windLimitKn` stay in the prefs store, unused, for a clean revert.

## How the code stays removable

- Everything under `app/src/discover/`: the registry (a list of predicates
  over existing stores), its own persisted store (key `sandies-discover`,
  never inside `sandies-prefs`), the sheet, the glyph, the arrival strip.
- Three mount points, one line each: the glyph in the top bar, the sheet
  routing, the earned strip on the trip card's arrived state.
- It subscribes to planner / route / places / gps stores. It never edits
  their behaviour.
- Two pieces are worth `main` on their own and go there first as a small
  PR: the per-place arrivals table (Dexie) and the sea-felt tap at trip
  end. Both are useful without achievements.

## Spec deltas (only if adopted)

- §1.5 sentence exemption extended to the Discover sheet (hint lines).
- §1 new top-bar chrome: the glyph, ring in the done colour `--c-track`,
  never the sea ramp.
- §0.1 new numbers need one home each: totals on the Tracks tab, reach
  counts on the Places row and chart badge, never on the strip.
- §2.2 the arrival card may carry the unlock moment.

## Verdict, decided up front

About five weeks of season left. Adopt only if, at the end of it:

- the sheet still gets opened in week three;
- the sea-felt tap is completed on at least half of trips;
- the names pass the dock test with the family;
- nobody reports going out for an achievement.

Miss two → delete the branch and the Pages project. By construction that
leaves nothing behind on `main`.

## Git

`discover` branches from `main`. Rebase on `main` weekly so pipeline and
waves changes keep flowing under it. Squash-merge if adopted, behind a
Settings toggle (default off) for one more month, the way the run
animation switch works.
