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
CREATE INDEX IF NOT EXISTS circles_last_post ON circles (last_post);
