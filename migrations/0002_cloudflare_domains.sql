CREATE TABLE IF NOT EXISTS cloudflare_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  encrypted_token TEXT NOT NULL,
  iv TEXT NOT NULL,
  token_hint TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS load_balancer_routes (
  load_balancer_id TEXT PRIMARY KEY REFERENCES load_balancers(id) ON DELETE CASCADE,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  route_id TEXT NOT NULL,
  route_pattern TEXT NOT NULL,
  route_created INTEGER NOT NULL DEFAULT 0 CHECK (route_created IN (0, 1)),
  dns_record_id TEXT,
  dns_created INTEGER NOT NULL DEFAULT 0 CHECK (dns_created IN (0, 1)),
  configured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS load_balancer_routes_zone_idx ON load_balancer_routes(zone_id);
