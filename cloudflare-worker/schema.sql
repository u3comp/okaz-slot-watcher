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
