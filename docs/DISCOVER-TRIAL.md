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

Setup (straight): All Talk · Knows the Boat · Has a Home · Cartographer ·
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
(`'discover'` in SheetTab), `TripCard.tsx` (the strip), `db.ts` (v4).

Driven end to end in a real browser (Playwright, iPhone viewport,
spoofed GPS): welcome → All Talk → first voyage → glyph → hub → set up
(cruise/units/limits/scale in place) → season → detail → Start trip →
Lines Off → arrival latched at the Sandies → home → sea felt → End →
seven earned, one outing and two arrivals in the log, no console errors.

Trial-harness notes: progress replans fire on `visibilitychange`, not
`online`; a spoofed fix must be AFLOAT (the config Sandies point is a
beach — park the boat just off it).

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
