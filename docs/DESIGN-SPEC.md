# Sandies — design spec

The decisions from the prototype rounds, written down as **checkable statements**.

This exists because the prototypes lived only in artifacts and in conversation, so
"does the app match?" had no answer anyone could verify. Everything below is
phrased so a reviewer with the running app can mark it PASS or FAIL without
asking the designer what was meant.

Status legend: **MUST** = decided, non-negotiable. **SHOULD** = decided, but a
reasonable alternative may be proposed. **OPEN** = genuinely undecided.

---

## 0. Purpose — the ladder

The organizing principle is **progressive information density**: one subject on
screen at a time, at four depths, and nothing ever more than one gesture from
where you are. This section exists because the first build satisfied every
structural clause below while missing the point entirely; purpose is now
checkable too.

**0.1 MUST — Three surfaces, three axes, every datum exactly one home.**
- The **strip is WHEN**: days and hours for the current subject — sky, temp,
  wind, wave, rain, ⚡ — all time-series conditions live here and only here.
- The **map is WHERE**: spot badges, the run's lanes, the layers.
- The **dock is WHO & WHAT NEXT**: the subject, the run facts, the plan,
  actions — and at depth, only what has no other home.
If the same number renders on two surfaces at once, that is a bug, not
richness. Opening the app still answers "today, here" with zero taps — the
strip and badges do it; no duplicate readout exists below.
*Check:* screenshot the fresh-open state; every family is visible exactly once.

**0.2 MUST — The map is the selector, and one tap surfaces everything.**
Watched spots appear ON the chart as badges (wave number on the ramp, name
beneath). Tapping a badge does three things in the SAME tap, in place:
- the chart **frames** the spot and the run to it (the existing fit-on-new-
  destination behaviour), and the lanes draw;
- the strip **retargets** to that spot's hours and days, wearing the spot's
  name so it is unmistakable what it now describes;
- the slim bar shows the spot and its run time.
No second gesture is ever needed to see a tapped spot's conditions — "I click
a location, it maps me there and gives the important information" is the
acceptance sentence. ✕ clears the subject — and with no subject there is no
dock at all: the chart stands alone.

The map has two companions as selector, never rivals:
- The **Places sheet** (first tab, next to Layers) is the badges as a list —
  one row per place, calmest first, limits dot alongside. Each row carries
  the selected day's important numbers (wind low–high, sea low–high, the sea
  coloured on the ramp) over its WEEK as colour: seven day-segments on the
  sea-state ramp (amber ⚡ on a thunder day), all read from the cached grid
  so the sheet costs no requests. **Tapping the row LOOKS**: the chart eases
  the place into view above the sheet — which STAYS UP, because looking is
  comparing — and the strip retargets. No trip is made: looking at a place
  must never feel like committing to it (§0.4). **The route button on
  the row is what plots the run** — destination, lanes, dock. Its top row is
  HERE — your position with the standing facts (§2.3). The hand-written
  notes live in the sheet's edit mode and on the trip card.
- **Tap anywhere** on open water: the depth/conditions popup carries two
  square actions. **Go** walks the same ladder as a badge tap (subject set,
  lanes plot, strip retargets — still exploring, §0.4). **Save** makes the
  point a place: a badge on the chart and a Places row, renameable in the
  sheet. A saved pin and a named spot are the same kind of thing — there is
  no second species of place. The run's segments never depend on the
  per-point forecast fetch: when it fails (offline, rate-limited), the
  cached regional grid stands in, so every reachable point gets lanes, dots
  and a plan.

**0.3 MUST — Depth is a swipe, and holds only what has no other home.**
The raised dock: the spot's hand-written note and the leg-by-leg run. The
jump list, limits row and saved-trip admin live in the Places sheet — the
dock is about THIS run, the sheet is about which place. NOT hours or day
tiles — the strip already owns time, and repeating it below is the
duplication this clause exists to forbid. There is no separate per-family
drill-down screen — the anti–Apple-Weather rule.

**0.4 MUST — Place taps explore; time taps plan. Chips arm, surfaces answer.**
Tapping a location NEVER asks when — it is weather exploration, and the trip
(lanes, distance, out/back seas) rides along as passive facts. The window
chips ride the card from the first moment, GHOSTED (em-dashes, never
questions): waking one is itself the time-pick that starts planning, and the
strip becomes that chip's keypad. The same grammar governs space: the
sentence's From/To chips arm, and the chart's badges, the open water and the
Places sheet become that slot's keypad (a banner names the listening slot,
with cancel). One gesture everywhere; nothing auto-suggests a departure.
**Start is never out of reach**: whenever leaving now is possible — no time
picked, or an out-time within 60 minutes — the card shows the real primary
"Start trip" button, no return time required. Only a trip planned for LATER
keeps Start as a quiet control (a control, not a prompt) that starts anyway,
rebasing the window to now — so a Saturday plan never nags on Thursday, and
going is never more than one visible tap. Cast-off stands every armed keypad
down. While Out is armed no hour is fenced off: a pick past the other end
simply carries that end along, span kept.

**0.5 MUST — One visual language, everywhere.**
Square sections: ~6 px radius tiles, ~5 px rows. No pill-shaped controls. The
outlook strip and every pre-existing surface are **functionally untouched but
restyled to match** — the app must not read as two eras. (Circular map FABs
are conventional chart furniture and exempt.)

**0.6 MUST — Rain and lightning are first-class, in the strip.**
A day chip's SKY ICON carries them: the day's code is its worst hour, so a
thunder day wears the storm icon and a rainy day the rain cloud — no 💧/⚡
marks beside it, which told the same story twice (§0.1). Thunder hours mark
their hour cells with an amber ⚡, because hour cells carry no sky icon.
Lightning is the one thing allowed to be loud — amber accent, never the
reserved red (§1.3). A thunder day TODAY may additionally surface an amber
"⚡ 3p" chip on the dock's slim bar, because it changes whether you go at
all.

---

## 1. The core stance

**1.1 MUST — The app never grades your trip.**
No "Good to go", "Use caution", "Not recommended", "safe", "unsafe", "best",
"recommended" anywhere in the interface. The app reports what the water is
doing; whether to go is the skipper's call.
*Check:* grep the UI for those strings; look at the trip card and the details
drawer.

**1.2 MUST — Magnitude, not score.**
Wave height is shown on an eight-band sequential ramp (`weather/seaState.ts`:
Glassy · Calm · Rippled · Choppy · Lumpy · Rough · Heavy · Big), walking
light green → gold → burnt orange → magenta → deep purple, so colour alone
carries how big the water is. The top is deep purple, never the alarm red
(§1.3). Green/amber/red as a good/bad judgement stays retired everywhere it
means "how good is this for you" — the ramp is a magnitude, and the same
band means the same water on the strip, the lanes, the blobs and the sheet.
*Check:* no `--cond-good/mod/rough` or `conditionFor()` driving any colour a
user sees.

**1.3 MUST — Red is reserved.**
The warning colour appears only for a hazard an agency issued, quoted and
attributed. Nothing the app calculates ever wears it.
*Note:* no warning source is wired up yet, so today red should appear nowhere.

**1.4 MUST — Limits are the user's.**
Any "clears your limits" mark reads off numbers the user set. Both limits start
`null` and no mark is drawn until they are set. The app never picks them.

**1.5 MUST — Colour and numbers. No sentences.**
Colour carries high/low. Numbers support it. The app does not narrate.
- No sentence anywhere in the interface — not a headline, not a caveat, not a
  heads-up, not an instruction in the chrome. "Builds around 3 PM — 22 km/h W"
  is a sentence and is banned even though every word of it is true.
- Labels are one or two words. Status is a glyph or a dash, not "Checking the
  weather along the route…".
- If something can only be said in a sentence, it is not shown.
- *Exemption:* the hand-written exposure note on a spot is content, not chrome
  — it may be a sentence, and appears only at L2 depth.
*Check:* grep user-facing JSX for any string containing a full clause. A
reviewer should not find one.

**1.6 — Colour MAY carry good/bad.**
This relaxes an earlier over-reading of 1.2. The sea-state ramp encodes
magnitude and magnitude reads as better/worse — that is fine and intended.
What is banned is the app putting that judgement into *words* (1.1) or using
the reserved warning colour for something it worked out itself (1.3).

---

## 2. The shape of the screen

**2.1 MUST — The chart is the app.** Full-bleed map, outlook strip on top,
one docked card at the bottom, tab row under it. This is not up for redesign.

**2.2 MUST — Opens on the water, not on a trip.**
A fresh install has no destination and no route — and no dock: the chart,
the strip and the badges stand alone, with the Places tab one tap away. A
route appears only after the user picks somewhere. A trip the user *did*
pick survives a reload.

**2.3 MUST — The dock exists only for a subject, slim, at two heights.**
One surface, present only when a place is picked or a trip is under way —
the always-on "Here" bar is superseded by the Places sheet (§0.2), whose top
row is where you stand: your position's wave number and the STANDING facts —
water temperature and sunset, the lake numbers no other surface owns (sunset
is computed locally so the row never depends on a fetch). With a subject, at
rest: a slim bar — the place, its run time and water temperature, the
⚡-today chip when earned, the run's passive facts (distance, time, out/back
seas, worst wind en route), and the plan (window chips, gated Start) once a
time is picked (§0.4). No conditions readout: the strip above is already
describing this subject (§0.1). Raised: per §0.3. Secondaries live on the
map and in the Places sheet (§0.2).

**2.4 MUST — Swipe up is the only "more".**
No `Details` button anywhere. A grab handle at the top of the card is a real
button for keyboard and screen-reader users; the swipe is the enhancement.
What the swipe reveals depends on what the card is about.

**2.5 SHOULD — `RoutePanel` retires.**
The run's detail belongs in the dock's raised detent, not in a separate tab
drawer. The `route` sheet tab goes; saved-trip admin moves elsewhere.

---

## 3. Spots

**3.1 MUST** — Five or six watched spots, from `config.WATCHED_SPOTS`.
**3.2 MUST** — Each datum in its one home (§0.1): the badge carries name +
wave on the ramp; the strip carries the subject's wind and hours; run time
lives on the slim bar; the note appears at L2. Jump-list tiles are name +
wave only — they are a switcher, not a readout.
**3.3 MUST** — Sorted **calmest first** — a fact. Never "best first", which
would be the app ranking where you should go.
**3.4 MUST** — Conditions come from the cached forecast grid. No new network
calls. (Verified: grid agrees with point forecasts to 0.02 m.)
**3.5 MUST** — Tapping a spot (badge or jump-list row) makes it the subject
and plots the run — looking, not committing (§0.4 gates the start).
**3.6 MUST** — Spot badges render on the chart per §0.2, and stay legible over
land and water at bay zoom.

---

## 4. The trip window

**4.1 MUST — Two chips, Out and Back.** They carry the trip's window.
**4.2 MUST — Time at the destination is derived**, never set: window minus the
running. No stay-time setting exists.
**4.3 MUST — The strip is the chips' keypad.** Arming a chip makes the hour
cells set that end, and only hours that still make a valid window are offered.
**4.4 MUST — Too tight is stated plainly** as arithmetic ("59m short"), not as
a disabled control with no explanation.
**4.5 MUST — No setup popover.** `TripSetup` is deleted. Cruise speed is an
inline stepper on the card that opens in place, never over the chart.

---

## 5. The run on the chart

**5.1 MUST — Two lanes**, out and home, each carrying a `line-gradient` of the
sea state at the minute the boat is there. Both use the same positive
`line-offset` so they land on opposite sides.
**5.2 MUST — The course line survives.** The accent line still reads as "your
course"; the sea state rides underneath it.
**5.3 MUST — One label, at most.** The roughest leg, and only when it stands a
band above the rest. Plus whichever dot the user tapped. Never a label per leg.
**5.4 MUST — Leg dots wear the ramp**, coloured by the rougher of their two
passes.
**5.5 MUST — Unknown is grey**, never a pale ramp colour. Pale reads as calm.

---

## 6. Motion

**6.1 MUST — One thing moves:** a faint comet inside each lane's own gradient.
The highlight is a *lightened patch of the water under it*, never a colour of
its own.
**6.2 MUST — No marks travel along the course.** Dashes and particle streams
read as traffic on a road. Rejected.
**6.3 MUST — The rake is swell bands**, always visible when the layer is on:
broad, soft, blended into the chart rather than stamped on it.
**6.4 MUST — The rake is an additive layer**, default off, in the Layers panel.
It composes with the lanes; turning it on does not turn them off.
**6.5 MUST — Motion stops** for `prefers-reduced-motion`, a hidden tab, and no
route. Held still, the chart is still complete and correct.

---

## 7. Under way

**7.1 MUST — Every leg carries two numbers:** time left (dominant, the number
you read at the wheel) and arrival (a clock time, what you tell people).
**7.2 MUST — Time left uses a smoothed speed**, not instantaneous SOG, and
ticks at most once a minute.
**7.3 MUST — Slack is spent in a fixed order:** time ashore absorbs first, then
the home time slips. Every adjustment is stated. The app never suggests
cutting a stay short or opening the throttle.
**7.4 SHOULD — Early is not a warning.** A negative drift does not wear the
late colour.

---

## 8. Known gaps — accepted, not forgotten

- **`applySavedTrip` clobbers the boat.** Loading a saved trip still overwrites
  cruise speed. `SavedTrip` should stop carrying boat settings.
- **No marine warnings source.** §1.3's red has nothing to drive it;
  Environment Canada / NWS Marine is a separate integration.
- **Limits have no first-run ask.** They are set from the spots list instead.
- **Never seen in a real sea.** Every judgement about the ramp, the lanes and
  the spot spread has been made on 0.1–0.4 m days.
- **`precipitation_probability` not yet fetched** — §0.6 needs it added to the
  point and grid requests (one query parameter).

---

## 9. How to verify

The app runs at `https://127.0.0.1:5185/` (self-signed; `ignoreHTTPSErrors`).
In dev the stores are exposed as `window.__map`, `window.__route`, `window.__gps`.

Do **not** wait on `map.isStyleLoaded()` — blocked OpenSeaMap raster tiles keep
it false forever. Wait for a layer instead:
`window.__map && window.__map.getLayer('run-out')`.

A clean browser context is a fresh install. To simulate an existing one, seed
`localStorage['sandies-route']` before navigation.

---

## 10. First run

**10.1 MUST — The welcome says the pitch once, then never again.** Three
cards before the chart, first launch only: the lake's own models (trust
leads — ECCC HRDPS wind, RDWPS 1 km waves, named), offline charts, the
pick-a-place-pick-an-hour grammar. Skippable at every card; finishing or
skipping is permanent (`onboarded`, persisted). This overlay is the ONE
surface exempt from §1.5's no-sentences rule — it is the app introducing
itself, not chrome.

**10.2 MUST — Setup is a dock card until it is done.** Narrow exception to
§2.2's "no dock on fresh install": until location, offline charts and a
home base have all been observed in place at once, a first-voyage card may
hold the dock slot — always yielding to a subject, an under-way trip and
the ruler. Rows are ACTIONS, never toggles: location asks the OS, charts
opens the Offline tab, home arms the chart. All three done → `setupDone`
(persisted) and the card retires forever; its ✕ does the same for the
borrowed-phone case. It never reappears to nag.

**10.3 MUST — Home is picked on the chart.** The home row arms a pick — a
top-bar banner names the listening slot with cancel, the same grammar as
the From/To slots (§0.4) — and the next chart tap saves the point as
"Home dock" and stars it (renameable in Places like any place). The first
tap a new user makes is the tap the whole app runs on.
