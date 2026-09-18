INSERT OR IGNORE INTO monitors (
  id, name, type, method, path, interval_seconds, timeout_seconds,
  expected_codes, consecutive_fails, consecutive_successes, headers_json, follow_redirects
) VALUES (
  'monitor_reachability',
  '源站可达性',
  'HTTPS',
  'GET',
  '/',
  60,
  5,
  '*',
  2,
  1,
  '{}',
  0
);
