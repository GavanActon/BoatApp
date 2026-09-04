# Usage stats

What the app counts, where it goes, and how to read it.

## The promise

Counted, never watched. An event is a short name and a few numbers or words:
which tab opened, how long the router took, that a trip ended after 95 minutes
and 11 miles. Never a position, never a name, never a track. The only identity
is a random id the app makes on first run (`sandies-stats-id` in localStorage),
so "how many boats" can be answered without knowing whose.

The switch is the last row of Settings, **Usage stats**, on by default. Off
records nothing and empties the queue. The Report a problem email is separate
and unchanged: it only goes when tapped, and the user sees it first.

## How it moves

`app/src/stats/core.ts` — `track(name, props)` appends to a queue in
localStorage and returns. It never touches the network: the same rule routing
follows. The queue is capped at 500 (oldest dropped) and goes to
`POST api.sandies.app/stats` in batches of up to 150 when there is a chance —
eight seconds after launch, on the `online` event, when the app goes to the
background (with `keepalive`, so the request outlives the page), every five
minutes, and when 60 pile up. The phone's clock stamps the event; the server
adds its own arrival time.

`app/src/stats/hooks.ts` — the list of events. The stores are watched from one
place rather than sprinkling `track()` through the handlers, so that file is
the inventory. The three exceptions live where the timing is: the router
(`planner.ts`, ms per plan), the forecast fetchers (`openMeteo.ts`, failures,
fallbacks, one timing per half hour) and the error log (`diagnostics.ts`,
uncaught errors, once per line per session).

## The events

| name | props | when |
|---|---|---|
| `open` | build, installed, platform, w, h, dpr, online, sw, charts, storage_mb, grid_h, wind, wind_h, waves, waves_h, cores, mem, net, resume | launch, or back from ≥ 30 min in the background |
| `close` | sec | the app goes to the background |
| `boot` | ms | navigation to the chart's style being up |
| `tab` | tab | a sheet opened |
| `helm`, `low_power`, `wx_strip`, `round_trip`, `share` | on | a switch |
| `heading_up`, `follow`, `measure`, `gpx`, `stats_on` | | a control used |
| `layer` | key, on | a chart or motion layer toggled |
| `unit` | kind, value | units changed |
| `dest` | named, round | a destination set |
| `via` | n | a via point added |
| `plan_time` | hours_ahead | a departure time picked |
| `route` | ok, ms, nm, round | the router ran (the user's replans, not the 2-minute progress ticks) |
| `trip_start` | round, nm | cast-off |
| `trip_end` | min, nm, arrived | dock |
| `gps` | status, err | a GPS status change (at most once a minute) |
| `earn`, `level` | id / n | Discover |
| `circle` | n | circles joined or left |
| `place` | n | a place saved |
| `charts` | files, ok | an offline chart bundle downloaded |
| `report` | how | Report a problem tapped |
| `wx_fetch` | ms | one Open-Meteo timing per half hour |
| `wx_fail` | reason | an Open-Meteo failure, once per reason per ten minutes |
| `wx_source` | src | the strip fell back to met.no or the disk copy |
| `error` | level, text | an uncaught error or rejection, once per line per session |

## The server

One table in the same D1 as the circles (`worker/schema.sql`):

```
events (id, install, build, at, received, name, props)
```

`POST /stats` checks every event by hand — a name outside `[a-z0-9_]`, a
non-object prop bag, a clock more than 15 minutes fast or 400 days slow — and
skips the bad event, not the batch. Rows purge after 400 days on the hourly
cron. Free-tier D1 has room for decades of this.

## Reading it

Set the token once (it is a Worker secret, not in the repo):

```
cd worker
npx wrangler@4.128.0 secret put STATS_TOKEN
```

Then:

```
curl -H "authorization: Bearer $STATS_TOKEN" "https://api.sandies.app/stats/summary?days=30"
```

gives installs (total, new in the window, active over the last day / week /
window), installs and opens by day, a count and install-count per event
name, builds in use, platforms and whether they are on the Home Screen, p50 /
p90 / max for `boot`, `route` and `wx_fetch`, the trips (count, mean minutes,
mean miles, share that arrived), and the top errors and forecast failures.

Anything else is SQL:

```
cd worker
npx wrangler@4.128.0 d1 execute sandies-api --remote --command \
  "SELECT id, name, props, json_extract(props,'$.n') AS n FROM events WHERE name='level' ORDER BY at DESC LIMIT 20"
```

Discover in particular: `earn` by id and `level` by n say whether anyone gets
past the first chapter, which is the question the whole onboarding bet rests on.

## Testing locally

```
cd worker
npx wrangler@4.128.0 d1 execute sandies-api --local --yes --file=schema.sql
npx wrangler@4.128.0 dev --port 8787 --var STATS_TOKEN:test
```

and build the app with `VITE_API=http://127.0.0.1:8787` so the phone-side
queue posts to it. `wrangler d1 execute sandies-api --local --command "SELECT …"`
reads the local rows.
