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
-- name, boat, when they joined, and the plan they have posted (a
-- destination and a time, never a position). Position and trip live in
-- `boats`, which expires after 12 h of silence; this row does not, until
-- the member leaves or the circle lapses.
CREATE TABLE IF NOT EXISTS members (
  circle_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_key_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  boat TEXT NOT NULL,
  joined INTEGER NOT NULL,
  plan TEXT,
  updated INTEGER NOT NULL,
  PRIMARY KEY (circle_id, device_id)
);
CREATE INDEX IF NOT EXISTS circles_last_post ON circles (last_post);

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
