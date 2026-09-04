-- The Sandies API schema. Idempotent: applied on every deploy.

-- A circle: a small invited group. The secret inside the invite IS
-- membership; only its hash is kept here.
CREATE TABLE IF NOT EXISTS circles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_post INTEGER NOT NULL
);

-- One record per boat per circle: the LATEST position and trip, never a
-- trail. The device key hash stops one member posting as another's boat.
CREATE TABLE IF NOT EXISTS boats (
  circle_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_key_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  boat TEXT NOT NULL,
  mark TEXT NOT NULL DEFAULT '',
  flair TEXT,
  color TEXT,
  lon REAL,
  lat REAL,
  sog_kn REAL,
  cog REAL,
  fix_ts INTEGER,
  trip TEXT,
  updated INTEGER NOT NULL,
  PRIMARY KEY (circle_id, device_id)
);

CREATE INDEX IF NOT EXISTS boats_updated ON boats (updated);

-- The crew: one row per member per circle from the moment they join —
-- name, boat, the mark (an emoji) and its flair, when they joined, and the
-- plan they have posted (a destination and a time, never a position).
-- `mark`, `flair` and `color` arrived after the first databases: the Worker adds
-- them to an existing table on first use (ensureColumns). Position and trip live in
-- `boats`, which expires after 12 h of silence; this row does not, until
-- the member leaves or the circle lapses.
CREATE TABLE IF NOT EXISTS members (
  circle_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_key_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  boat TEXT NOT NULL,
  mark TEXT NOT NULL DEFAULT '',
  flair TEXT,
  color TEXT,
  joined INTEGER NOT NULL,
  plan TEXT,
  updated INTEGER NOT NULL,
  PRIMARY KEY (circle_id, device_id)
);
CREATE INDEX IF NOT EXISTS circles_last_post ON circles (last_post);

-- Push notifications. `config` holds the Worker's own VAPID key pair (made
-- on first use — nothing to set by hand). One subscription per device; the
-- crew hears about a device's moments through its circles. `push_log` is
-- the once-only ledger: one "departed" per trip, one "planning" per plan
-- per day, whatever the phone re-posts.
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subs (
  device_id TEXT PRIMARY KEY,
  device_key_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_ok INTEGER
);

CREATE TABLE IF NOT EXISTS push_log (
  circle_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (circle_id, device_id, kind, key)
);

CREATE INDEX IF NOT EXISTS push_log_at ON push_log (at);

-- Usage stats (app/src/stats): one row per event, posted in batches by the
-- app. `install` is the app's own random id, `at` the phone's clock when
-- it happened, `received` the server's when it arrived. Never a position.
-- Rows older than 400 days are purged.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  install TEXT NOT NULL,
  build TEXT,
  at INTEGER NOT NULL,
  received INTEGER NOT NULL,
  name TEXT NOT NULL,
  props TEXT
);

CREATE INDEX IF NOT EXISTS events_at ON events (at);
CREATE INDEX IF NOT EXISTS events_name_at ON events (name, at);
CREATE INDEX IF NOT EXISTS events_install_at ON events (install, at);
