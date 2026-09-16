import type { SnapshotMonitor, SnapshotOrigin } from '../shared/model'
import { probeOrigin, type ProbeResult } from '../shared/probe'
import { refreshActiveSnapshotHealth } from '../shared/snapshot'

interface Env {
  DB: D1Database
  CONFIG_KV: KVNamespace
  ENVIRONMENT?: string
}

interface CheckRow {
  pool_id: string
  origin_id: string
  origin_name: string
  address: string
  connection_host: string | null
  region: string
  latitude: number
  longitude: number
  weight: number
  monitor_id: string
  monitor_name: string
  monitor_type: 'HTTP' | 'HTTPS' | 'TCP'
  monitor_method: 'GET' | 'HEAD'
  monitor_path: string
  monitor_port: number | null
  interval_seconds: number
  timeout_seconds: number
  expected_codes: string
  consecutive_fails: number
  consecutive_successes: number
  headers_json: string
  follow_redirects: number
  state: 'healthy' | 'unhealthy' | 'unknown'
  current_failures: number
  current_successes: number
  last_checked_at: string | null
}

function asOrigin(row: CheckRow): SnapshotOrigin {
  return { id: row.origin_id, name: row.origin_name, address: row.address, connectionHost: row.connection_host, region: row.region, latitude: row.latitude, longitude: row.longitude, weight: row.weight }
}

function asMonitor(row: CheckRow): SnapshotMonitor {
  let headers: Record<string, string> = {}
  try { headers = JSON.parse(row.headers_json || '{}') as Record<string, string> } catch { /* Invalid legacy headers are ignored. */ }
  return { id: row.monitor_id, name: row.monitor_name, type: row.monitor_type, method: row.monitor_method, path: row.monitor_path, port: row.monitor_port, intervalSeconds: row.interval_seconds, timeoutSeconds: row.timeout_seconds, expectedCodes: row.expected_codes, consecutiveFails: row.consecutive_fails, consecutiveSuccesses: row.consecutive_successes, headers, followRedirects: Boolean(row.follow_redirects) }
}

function isDue(row: CheckRow, now: number) {
  if (!row.last_checked_at) return true
  const checkedAt = Date.parse(row.last_checked_at)
  return !Number.isFinite(checkedAt) || now - checkedAt >= row.interval_seconds * 1000 - 5000
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number) {
  const results: T[] = []
  let cursor = 0
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor
      cursor += 1
      results[index] = await tasks[index]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

function nextHealth(row: CheckRow, result: ProbeResult) {
  if (result.ok) {
    const successes = row.current_successes + 1
    return { state: row.state === 'healthy' || successes >= row.consecutive_successes ? 'healthy' : row.state, failures: 0, successes }
  }
  const failures = row.current_failures + 1
  return { state: row.state === 'unhealthy' || failures >= row.consecutive_fails ? 'unhealthy' : row.state, failures, successes: 0 }
}

async function applyResult(env: Env, rows: CheckRow[], result: ProbeResult) {
  const checkedAt = new Date().toISOString()
  const statements: D1PreparedStatement[] = []
  for (const row of rows) {
    const next = nextHealth(row, result)
    statements.push(
      env.DB.prepare('INSERT INTO health_states(pool_id, origin_id, state, consecutive_failures, consecutive_successes, last_checked_at, last_status_code, last_latency_ms, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(pool_id, origin_id) DO UPDATE SET state = excluded.state, consecutive_failures = excluded.consecutive_failures, consecutive_successes = excluded.consecutive_successes, last_checked_at = excluded.last_checked_at, last_status_code = excluded.last_status_code, last_latency_ms = excluded.last_latency_ms, last_error = excluded.last_error').bind(row.pool_id, row.origin_id, next.state, next.failures, next.successes, checkedAt, result.statusCode, result.latencyMs, result.error),
      env.DB.prepare('INSERT INTO health_history(pool_id, origin_id, state, status_code, latency_ms, error, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(row.pool_id, row.origin_id, next.state, result.statusCode, result.latencyMs, result.error, checkedAt),
    )
    if (next.state !== row.state && next.state !== 'unknown') {
      statements.push(env.DB.prepare('INSERT INTO events(event_type, pool_id, origin_id, status_code, duration_ms, level, message) VALUES (?, ?, ?, ?, ?, ?, ?)').bind('HEALTH', row.pool_id, row.origin_id, result.statusCode, result.latencyMs, next.state === 'healthy' ? 'success' : 'warning', next.state === 'healthy' ? '源站已恢复' : `源站已移出：${result.error ?? '检查失败'}`))
    }
  }
  if (statements.length) await env.DB.batch(statements)
}

export async function runHealthChecks(env: Env) {
  const query = await env.DB.prepare(`
    SELECT p.id AS pool_id, o.id AS origin_id, o.name AS origin_name, o.address, o.connection_host, o.region, o.latitude, o.longitude, COALESCE(po.weight_override, o.weight) AS weight,
      m.id AS monitor_id, m.name AS monitor_name, m.type AS monitor_type, m.method AS monitor_method, m.path AS monitor_path, m.port AS monitor_port, m.interval_seconds, m.timeout_seconds,
      m.expected_codes, m.consecutive_fails, m.consecutive_successes, m.headers_json, m.follow_redirects,
      COALESCE(h.state, 'unknown') AS state, COALESCE(h.consecutive_failures, 0) AS current_failures,
      COALESCE(h.consecutive_successes, 0) AS current_successes, h.last_checked_at
    FROM pools p
    JOIN monitors m ON m.id = p.monitor_id
    JOIN pool_origins po ON po.pool_id = p.id AND po.enabled = 1
    JOIN origins o ON o.id = po.origin_id AND o.enabled = 1
    LEFT JOIN health_states h ON h.pool_id = p.id AND h.origin_id = o.id
    WHERE p.enabled = 1
    ORDER BY o.id, m.id, p.id
  `).all<CheckRow>()
  const dueRows = (query.results ?? []).filter((row) => isDue(row, Date.now()))
  const groups = new Map<string, CheckRow[]>()
  for (const row of dueRows) {
    const key = `${row.origin_id}:${row.monitor_id}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }

  const checks = [...groups.values()].map((rows) => async () => {
    const result = await probeOrigin(asOrigin(rows[0]), asMonitor(rows[0]))
    await applyResult(env, rows, result)
    return { originId: rows[0].origin_id, monitorId: rows[0].monitor_id, ok: result.ok }
  })
  const results = await runWithConcurrency(checks, 6)
  await refreshActiveSnapshotHealth(env.DB, env.CONFIG_KV)

  const [healthRetention, eventRetention] = await Promise.all([
    env.DB.prepare("SELECT value_json FROM settings WHERE key = 'health_history_retention_days'").first<{ value_json: string }>(),
    env.DB.prepare("SELECT value_json FROM settings WHERE key = 'event_retention_days'").first<{ value_json: string }>(),
  ])
  const healthDays = Math.max(1, Math.min(90, Number(healthRetention?.value_json ?? 7)))
  const eventDays = Math.max(1, Math.min(90, Number(eventRetention?.value_json ?? 14)))
  await env.DB.batch([
    env.DB.prepare("DELETE FROM health_history WHERE julianday(checked_at) < julianday('now', ?)").bind(`-${healthDays} days`),
    env.DB.prepare("DELETE FROM events WHERE julianday(occurred_at) < julianday('now', ?)").bind(`-${eventDays} days`),
  ])
  return { checked: results.length, passed: results.filter((item) => item.ok).length }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext) {
    context.waitUntil(runHealthChecks(env))
  },
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return new Response(JSON.stringify({ ok: true, service: 'worker-lb-health' }), { headers: { 'content-type': 'application/json' } })
    if (env.ENVIRONMENT === 'development' && request.method === 'POST' && url.pathname === '/run') return new Response(JSON.stringify(await runHealthChecks(env)), { headers: { 'content-type': 'application/json' } })
    return new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
