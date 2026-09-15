import { ACTIVE_SNAPSHOT_KEY, type ConfigSnapshot, healthKey, parseHeaders, type SteeringPolicy } from './model'

type OriginRow = { id: string; name: string; address: string; region: string; latitude: number; longitude: number; weight: number }
type MonitorRow = { id: string; name: string; type: 'HTTP' | 'HTTPS' | 'TCP'; path: string; interval_seconds: number; timeout_seconds: number; expected_codes: string; consecutive_fails: number; consecutive_successes: number; headers_json: string; follow_redirects: number }
type PoolRow = { id: string; name: string; monitor_id: string; minimum_healthy: number }
type PoolOriginRow = { pool_id: string; origin_id: string; priority: number; weight_override: number | null; origin_weight: number }
type LoadBalancerRow = { id: string; hostname: string; site: string; steering: SteeringPolicy; session_affinity: number; affinity_ttl_seconds: number; proximity_buffer: number }
type LoadBalancerPoolRow = { load_balancer_id: string; pool_id: string; priority: number }
type HealthRow = { pool_id: string; origin_id: string; state: 'healthy' | 'unhealthy' | 'unknown'; last_checked_at: string | null; last_latency_ms: number | null }

function resultRows<T>(result: D1Result<T>) {
  return result.results ?? []
}

export async function buildSnapshot(db: D1Database, version: number): Promise<ConfigSnapshot> {
  const [originsResult, monitorsResult, poolsResult, poolOriginsResult, loadBalancersResult, loadBalancerPoolsResult, healthResult, sampleRateResult] = await Promise.all([
    db.prepare('SELECT id, name, address, region, latitude, longitude, weight FROM origins WHERE enabled = 1 ORDER BY created_at').all<OriginRow>(),
    db.prepare('SELECT id, name, type, path, interval_seconds, timeout_seconds, expected_codes, consecutive_fails, consecutive_successes, headers_json, follow_redirects FROM monitors ORDER BY created_at').all<MonitorRow>(),
    db.prepare('SELECT id, name, monitor_id, minimum_healthy FROM pools WHERE enabled = 1 ORDER BY created_at').all<PoolRow>(),
    db.prepare('SELECT po.pool_id, po.origin_id, po.priority, po.weight_override, o.weight AS origin_weight FROM pool_origins po JOIN origins o ON o.id = po.origin_id WHERE po.enabled = 1 AND o.enabled = 1 ORDER BY po.priority, o.created_at').all<PoolOriginRow>(),
    db.prepare('SELECT id, hostname, site, steering, session_affinity, affinity_ttl_seconds, proximity_buffer FROM load_balancers WHERE enabled = 1 ORDER BY created_at').all<LoadBalancerRow>(),
    db.prepare('SELECT lbp.load_balancer_id, lbp.pool_id, lbp.priority FROM load_balancer_pools lbp JOIN pools p ON p.id = lbp.pool_id WHERE lbp.enabled = 1 AND p.enabled = 1 ORDER BY lbp.priority').all<LoadBalancerPoolRow>(),
    db.prepare('SELECT pool_id, origin_id, state, last_checked_at, last_latency_ms FROM health_states').all<HealthRow>(),
    db.prepare("SELECT value_json FROM settings WHERE key = 'request_log_sample_rate'").first<{ value_json: string }>(),
  ])

  const snapshot: ConfigSnapshot = {
    schemaVersion: 1,
    version,
    publishedAt: new Date().toISOString(),
    requestLogSampleRate: Math.max(0, Math.min(1, Number(sampleRateResult?.value_json ?? 0.01))),
    origins: {},
    monitors: {},
    pools: {},
    loadBalancers: {},
    health: {},
  }

  for (const row of resultRows(originsResult)) snapshot.origins[row.id] = { id: row.id, name: row.name, address: row.address, region: row.region, latitude: row.latitude, longitude: row.longitude, weight: row.weight }
  for (const row of resultRows(monitorsResult)) snapshot.monitors[row.id] = { id: row.id, name: row.name, type: row.type, path: row.path, intervalSeconds: row.interval_seconds, timeoutSeconds: row.timeout_seconds, expectedCodes: row.expected_codes, consecutiveFails: row.consecutive_fails, consecutiveSuccesses: row.consecutive_successes, headers: parseHeaders(row.headers_json), followRedirects: Boolean(row.follow_redirects) }
  for (const row of resultRows(poolsResult)) snapshot.pools[row.id] = { id: row.id, name: row.name, monitorId: row.monitor_id, minimumHealthy: row.minimum_healthy, origins: [] }
  for (const row of resultRows(poolOriginsResult)) snapshot.pools[row.pool_id]?.origins.push({ originId: row.origin_id, priority: row.priority, weight: row.weight_override ?? row.origin_weight })
  for (const row of resultRows(loadBalancersResult)) snapshot.loadBalancers[row.hostname] = { id: row.id, hostname: row.hostname, site: row.site, steering: row.steering, sessionAffinity: Boolean(row.session_affinity), affinityTtlSeconds: row.affinity_ttl_seconds, proximityBuffer: row.proximity_buffer, pools: [] }
  for (const row of resultRows(loadBalancerPoolsResult)) {
    const loadBalancer = Object.values(snapshot.loadBalancers).find((item) => item.id === row.load_balancer_id)
    loadBalancer?.pools.push({ poolId: row.pool_id, priority: row.priority })
  }
  for (const row of resultRows(healthResult)) snapshot.health[healthKey(row.pool_id, row.origin_id)] = { state: row.state, lastCheckedAt: row.last_checked_at, lastLatencyMs: row.last_latency_ms }

  return snapshot
}

export function validateSnapshot(snapshot: ConfigSnapshot) {
  const errors: string[] = []
  const loadBalancerHosts = new Set(Object.keys(snapshot.loadBalancers))

  for (const origin of Object.values(snapshot.origins)) {
    const hostname = origin.address.replace(/^\[|\]$/g, '').split(':')[0]
    if (loadBalancerHosts.has(hostname)) errors.push(`源站 ${origin.name} 不能指向负载平衡器主机名 ${hostname}`)
  }

  for (const pool of Object.values(snapshot.pools)) {
    if (!snapshot.monitors[pool.monitorId]) errors.push(`池 ${pool.name} 没有关联有效监视器`)
    if (!pool.origins.length) errors.push(`池 ${pool.name} 至少需要一个启用的源站`)
    if (pool.origins.length && pool.origins.every((item) => item.weight <= 0)) errors.push(`池 ${pool.name} 至少需要一个权重大于 0 的源站`)
  }

  for (const loadBalancer of Object.values(snapshot.loadBalancers)) {
    if (!loadBalancer.pools.length) errors.push(`负载平衡器 ${loadBalancer.hostname} 至少需要一个启用的池`)
    for (const item of loadBalancer.pools) if (!snapshot.pools[item.poolId]) errors.push(`负载平衡器 ${loadBalancer.hostname} 引用了无效池`)
  }

  return errors
}

export async function writeActiveSnapshot(kv: KVNamespace, snapshot: ConfigSnapshot) {
  await kv.put(ACTIVE_SNAPSHOT_KEY, JSON.stringify(snapshot), { metadata: { version: snapshot.version, publishedAt: snapshot.publishedAt } })
}

export async function refreshActiveSnapshotHealth(db: D1Database, kv: KVNamespace) {
  const snapshot = await kv.get<ConfigSnapshot>(ACTIVE_SNAPSHOT_KEY, 'json')
  if (!snapshot) return null
  const result = await db.prepare('SELECT pool_id, origin_id, state, last_checked_at, last_latency_ms FROM health_states').all<HealthRow>()
  const nextHealth: ConfigSnapshot['health'] = {}
  for (const row of resultRows(result)) nextHealth[healthKey(row.pool_id, row.origin_id)] = { state: row.state, lastCheckedAt: row.last_checked_at, lastLatencyMs: row.last_latency_ms }
  snapshot.health = nextHealth
  await writeActiveSnapshot(kv, snapshot)
  return snapshot
}
