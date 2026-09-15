PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS origins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL COLLATE NOCASE UNIQUE,
  region TEXT NOT NULL,
  latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  weight INTEGER NOT NULL DEFAULT 50 CHECK (weight BETWEEN 0 AND 100),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('HTTP', 'HTTPS', 'TCP')),
  path TEXT NOT NULL DEFAULT '/healthz',
  interval_seconds INTEGER NOT NULL DEFAULT 60 CHECK (interval_seconds BETWEEN 60 AND 3600),
  timeout_seconds INTEGER NOT NULL DEFAULT 5 CHECK (timeout_seconds BETWEEN 1 AND 30),
  expected_codes TEXT NOT NULL DEFAULT '200-299',
  consecutive_fails INTEGER NOT NULL DEFAULT 2 CHECK (consecutive_fails BETWEEN 1 AND 10),
  consecutive_successes INTEGER NOT NULL DEFAULT 2 CHECK (consecutive_successes BETWEEN 1 AND 10),
  headers_json TEXT NOT NULL DEFAULT '{}',
  follow_redirects INTEGER NOT NULL DEFAULT 0 CHECK (follow_redirects IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE RESTRICT,
  minimum_healthy INTEGER NOT NULL DEFAULT 1 CHECK (minimum_healthy >= 1),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS pool_origins (
  pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  origin_id TEXT NOT NULL REFERENCES origins(id) ON DELETE RESTRICT,
  priority INTEGER NOT NULL DEFAULT 0,
  weight_override INTEGER CHECK (weight_override BETWEEN 0 AND 100),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  PRIMARY KEY (pool_id, origin_id)
);

CREATE TABLE IF NOT EXISTS load_balancers (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL COLLATE NOCASE UNIQUE,
  site TEXT NOT NULL,
  steering TEXT NOT NULL DEFAULT 'proximity' CHECK (steering IN ('proximity', 'latency', 'random', 'failover')),
  session_affinity INTEGER NOT NULL DEFAULT 1 CHECK (session_affinity IN (0, 1)),
  affinity_ttl_seconds INTEGER NOT NULL DEFAULT 1800 CHECK (affinity_ttl_seconds BETWEEN 60 AND 604800),
  proximity_buffer REAL NOT NULL DEFAULT 0.15 CHECK (proximity_buffer BETWEEN 0 AND 1),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS load_balancer_pools (
  load_balancer_id TEXT NOT NULL REFERENCES load_balancers(id) ON DELETE CASCADE,
  pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE RESTRICT,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  PRIMARY KEY (load_balancer_id, pool_id)
);

CREATE TABLE IF NOT EXISTS health_states (
  pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  origin_id TEXT NOT NULL REFERENCES origins(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('healthy', 'unhealthy', 'unknown')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  last_status_code INTEGER,
  last_latency_ms INTEGER,
  last_error TEXT,
  PRIMARY KEY (pool_id, origin_id)
);

CREATE TABLE IF NOT EXISTS health_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id TEXT NOT NULL,
  origin_id TEXT NOT NULL,
  state TEXT NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT,
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS config_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('staging', 'published', 'superseded', 'rolled_back', 'failed')),
  snapshot_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  event_type TEXT NOT NULL,
  hostname TEXT,
  pool_id TEXT,
  origin_id TEXT,
  status_code INTEGER,
  duration_ms INTEGER,
  level TEXT NOT NULL DEFAULT 'neutral',
  message TEXT NOT NULL DEFAULT '',
  cf_ray TEXT,
  sampled INTEGER NOT NULL DEFAULT 0 CHECK (sampled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS analytics_hourly (
  bucket TEXT NOT NULL,
  hostname TEXT NOT NULL,
  origin_id TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  failovers INTEGER NOT NULL DEFAULT 0,
  ttfb_sum_ms INTEGER NOT NULL DEFAULT 0,
  ttfb_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, hostname, origin_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS pool_origins_origin_idx ON pool_origins(origin_id);
CREATE INDEX IF NOT EXISTS health_states_origin_idx ON health_states(origin_id);
CREATE INDEX IF NOT EXISTS health_history_checked_idx ON health_history(checked_at);
CREATE INDEX IF NOT EXISTS events_occurred_idx ON events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_hostname_idx ON events(hostname, occurred_at DESC);
CREATE INDEX IF NOT EXISTS config_versions_status_idx ON config_versions(status, version DESC);

INSERT OR IGNORE INTO settings(key, value_json) VALUES
  ('health_history_retention_days', '7'),
  ('event_retention_days', '14'),
  ('request_log_sample_rate', '0.01');
