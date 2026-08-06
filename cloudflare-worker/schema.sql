CREATE TABLE IF NOT EXISTS watcher_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state_json TEXT NOT NULL,
  updated_at_jst TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS watcher_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL,
  lease_until_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dry_run_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at_jst TEXT NOT NULL
);

-- Isolated, opt-in acceptance state. This table is never used by normal
-- monitoring and contains no canonical watcher state or credentials.
CREATE TABLE IF NOT EXISTS acceptance_state (
  test_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
