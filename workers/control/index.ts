import {
  createId,
  integerInRange,
  isIpAddress,
  isPrivateOrLocalIp,
  normalizeHostname,
  normalizeOriginAddress,
  numberInRange,
  originDnsLabel,
  originHostname,
  parseHeaders,
  REACHABILITY_MONITOR_ID,
  REACHABILITY_MONITOR_NAME,
  requiredText,
  type ConfigSnapshot,
  type SteeringPolicy,
} from '../shared/model'
import { buildSnapshot, refreshActiveSnapshotHealth, validateSnapshot, writeActiveSnapshot } from '../shared/snapshot'
import { probeOrigin } from '../shared/probe'
import {
  CloudflareApiError,
  deleteOriginDnsRecord,
  deprovisionHostname,
  listCredentialZones,
  provisionHostname,
  provisionOriginDns,
  removeCloudflareCredential,
  saveCloudflareCredential,
  testCloudflareCredential,
  updateOriginDnsRecord,
  type OriginDnsRecord,
  type ProvisionedHostname,
} from '../shared/cloudflare'

interface Env {
  DB: D1Database
  CONFIG_KV: KVNamespace
  ASSETS: Fetcher
  ENVIRONMENT?: string
  ADMIN_TOKEN?: string
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  TOKEN_ENCRYPTION_KEY?: string
  WORKER_NAME?: string
  ADMIN_HOSTS?: string
}

type JsonObject = Record<string, unknown>

const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

function json(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...securityHeaders, ...headers } })
}

async function readJson(request: Request): Promise<JsonObject> {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > 64 * 1024) throw new Error('请求内容过大')
  const value: unknown = await request.json()
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求内容必须是 JSON 对象')
  return value as JsonObject
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback
}

function optionalPort(value: unknown, fallback: number | null = null) {
  if (value === undefined) return fallback
  if (value === null || value === '') return null
  return integerInRange(value, 1, 65535, '端口')
}

function requestMethod(value: unknown, fallback: 'GET' | 'HEAD' = 'GET') {
  const method = String(value ?? fallback).toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') throw new Error('监视器请求方法只支持 GET 或 HEAD')
  return method as 'GET' | 'HEAD'
}

function requestHeaders(value: unknown, fallback: Record<string, string> = {}) {
  if (value === undefined) return fallback
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求头必须是 JSON 对象')
  const entries = Object.entries(value)
  if (entries.length > 32) throw new Error('请求头不能超过 32 项')
  const headers: Record<string, string> = {}
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim()
    const headerValue = String(rawValue).trim()
    if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`请求头名称无效：${rawName}`)
    if (name.length > 128 || headerValue.length > 2048 || /[\r\n]/.test(headerValue)) throw new Error(`请求头内容无效：${name}`)
    headers[name] = headerValue
  }
  return headers
}

function stringArray(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`)
  const result = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]
  if (!result.length) throw new Error(`${label}至少需要一项`)
  return result
}

function steeringValue(value: unknown): SteeringPolicy {
  const steering = String(value ?? 'proximity') as SteeringPolicy
  if (!['proximity', 'latency', 'random', 'failover'].includes(steering)) throw new Error('流量转向策略无效')
  return steering
}

async function constantTimeEqual(left: string, right: string) {
  const encoder = new TextEncoder()
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ])
  const leftBytes = new Uint8Array(leftHash)
  const rightBytes = new Uint8Array(rightHash)
  let difference = leftBytes.length ^ rightBytes.length
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index]
  return difference === 0
}

function decodeJwtPart(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  return JSON.parse(atob(normalized)) as JsonObject
}

type AccessJsonWebKey = JsonWebKey & { kid?: string }
let accessKeys: { expiresAt: number; keys: AccessJsonWebKey[] } | undefined

async function verifyAccessJwt(token: string, env: Env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false
  try {
    const [headerPart, payloadPart, signaturePart] = token.split('.')
    if (!headerPart || !payloadPart || !signaturePart) return false
    const header = decodeJwtPart(headerPart)
    if (header.alg !== 'RS256') return false
    const payload = decodeJwtPart(payloadPart)
    const now = Math.floor(Date.now() / 1000)
    const audience = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud ?? '')]
    const expectedIssuer = `https://${env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
    if (!audience.includes(env.ACCESS_AUD) || Number(payload.exp ?? 0) <= now || String(payload.iss ?? '') !== expectedIssuer) return false

    if (!accessKeys || accessKeys.expiresAt < Date.now()) {
      const response = await fetch(`${expectedIssuer}/cdn-cgi/access/certs`)
      if (!response.ok) return false
      const body = await response.json<{ keys?: AccessJsonWebKey[] }>()
      accessKeys = { keys: body.keys ?? [], expiresAt: Date.now() + 60 * 60 * 1000 }
    }
    const jwk = accessKeys.keys.find((item) => item.kid === String(header.kid ?? ''))
    if (!jwk) return false
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    const signature = Uint8Array.from(atob(signaturePart.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(signaturePart.length / 4) * 4, '=')), (character) => character.charCodeAt(0))
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(`${headerPart}.${payloadPart}`))
  } catch {
    return false
  }
}

async function authorized(request: Request, env: Env) {
  if (env.ENVIRONMENT === 'development' && !env.ADMIN_TOKEN && !env.ACCESS_AUD) return true
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (bearer && env.ADMIN_TOKEN && await constantTimeEqual(bearer, env.ADMIN_TOKEN)) return true
  const accessJwt = request.headers.get('cf-access-jwt-assertion')
  return Boolean(accessJwt && await verifyAccessJwt(accessJwt, env))
}

async function ensureReachabilityMonitor(db: D1Database) {
  const existing = await db.prepare('SELECT id FROM monitors WHERE id = ?').bind(REACHABILITY_MONITOR_ID).first<{ id: string }>()
  if (existing) return existing.id
  await db.prepare("INSERT OR IGNORE INTO monitors(id, name, type, method, path, port, interval_seconds, timeout_seconds, expected_codes, consecutive_fails, consecutive_successes, headers_json, follow_redirects) VALUES (?, ?, 'HTTPS', 'GET', '/', NULL, 60, 5, '*', 2, 1, '{}', 0)").bind(REACHABILITY_MONITOR_ID, REACHABILITY_MONITOR_NAME).run()
  return REACHABILITY_MONITOR_ID
}

async function recordEvent(db: D1Database, eventType: string, message: string, values: { hostname?: string; poolId?: string; originId?: string; level?: string } = {}) {
  await db.prepare('INSERT INTO events(event_type, hostname, pool_id, origin_id, level, message) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(eventType, values.hostname ?? null, values.poolId ?? null, values.originId ?? null, values.level ?? 'neutral', message).run()
}

function aggregateHealth(states: string[]) {
  if (!states.length || states.some((state) => state === 'unknown')) return 'degraded'
  const healthy = states.filter((state) => state === 'healthy').length
  if (healthy === states.length) return 'healthy'
  return healthy > 0 ? 'degraded' : 'unhealthy'
}

async function getControlState(db: D1Database) {
  const [originsQuery, monitorsQuery, poolsQuery, poolOriginsQuery, loadBalancersQuery, loadBalancerPoolsQuery, healthQuery, logsQuery, versionQuery, analyticsQuery, trafficQuery, sampleRateQuery, credentialQuery, routesQuery, originZoneQuery] = await Promise.all([
    db.prepare('SELECT id, name, address, connection_host, connection_zone_name, region, latitude, longitude, weight, enabled FROM origins ORDER BY created_at DESC').all<Record<string, unknown>>(),
    db.prepare('SELECT m.id, m.name, m.type, m.method, m.path, m.port, m.interval_seconds, m.timeout_seconds, m.expected_codes, m.consecutive_fails, m.consecutive_successes, m.headers_json, m.follow_redirects, COUNT(p.id) AS pools FROM monitors m LEFT JOIN pools p ON p.monitor_id = m.id GROUP BY m.id ORDER BY m.created_at DESC').all<Record<string, unknown>>(),
    db.prepare('SELECT id, name, description, monitor_id, minimum_healthy, enabled FROM pools ORDER BY created_at DESC').all<Record<string, unknown>>(),
    db.prepare('SELECT pool_id, origin_id, priority, weight_override, enabled FROM pool_origins ORDER BY priority').all<Record<string, unknown>>(),
    db.prepare('SELECT id, hostname, origin_host, site, steering, session_affinity, affinity_ttl_seconds, proximity_buffer, enabled FROM load_balancers ORDER BY created_at DESC').all<Record<string, unknown>>(),
    db.prepare('SELECT load_balancer_id, pool_id, priority, enabled FROM load_balancer_pools ORDER BY priority').all<Record<string, unknown>>(),
    db.prepare('SELECT pool_id, origin_id, state, last_latency_ms, last_checked_at FROM health_states').all<Record<string, unknown>>(),
    db.prepare('SELECT id, occurred_at, event_type, hostname, pool_id, origin_id, status_code, duration_ms, level, message FROM events ORDER BY occurred_at DESC LIMIT 200').all<Record<string, unknown>>(),
    db.prepare("SELECT version, published_at FROM config_versions WHERE status = 'published' ORDER BY version DESC LIMIT 1").first<Record<string, unknown>>(),
    db.prepare("SELECT e.hostname, SUM(CASE WHEN e.sampled = 1 THEN 1 ELSE 0 END) AS samples, AVG(CASE WHEN e.sampled = 1 THEN e.duration_ms END) AS ttfb, SUM(CASE WHEN e.event_type = 'FAILOVER' THEN 1 ELSE 0 END) AS failovers FROM events e JOIN load_balancers lb ON lb.hostname = e.hostname WHERE julianday(e.occurred_at) >= julianday('now', '-24 hours') GROUP BY e.hostname").all<Record<string, unknown>>(),
    db.prepare("SELECT strftime('%Y-%m-%dT%H:00:00Z', e.occurred_at) AS bucket, SUM(CASE WHEN e.sampled = 1 THEN 1 ELSE 0 END) AS samples, AVG(CASE WHEN e.sampled = 1 THEN e.duration_ms END) AS ttfb FROM events e JOIN load_balancers lb ON lb.hostname = e.hostname WHERE julianday(e.occurred_at) >= julianday('now', '-24 hours') GROUP BY bucket HAVING SUM(CASE WHEN e.sampled = 1 THEN 1 ELSE 0 END) > 0 ORDER BY bucket").all<Record<string, unknown>>(),
    db.prepare("SELECT value_json FROM settings WHERE key = 'request_log_sample_rate'").first<{ value_json: string }>(),
    db.prepare('SELECT token_hint, verified_at FROM cloudflare_credentials WHERE id = 1').first<{ token_hint: string; verified_at: string }>(),
    db.prepare('SELECT load_balancer_id, zone_name, route_pattern, route_created, dns_created FROM load_balancer_routes').all<Record<string, unknown>>(),
    db.prepare("SELECT value_json FROM settings WHERE key = 'origin_dns_zone'").first<{ value_json: string }>(),
  ])

  const healthRows = healthQuery.results ?? []
  const poolOriginRows = poolOriginsQuery.results ?? []
  const healthForOrigin = (originId: string) => healthRows.filter((row) => row.origin_id === originId)
  const healthForPool = (poolId: string) => healthRows.filter((row) => row.pool_id === poolId)

  const origins = (originsQuery.results ?? []).map((row) => {
    const health = healthForOrigin(String(row.id))
    const latencies = health.map((item) => Number(item.last_latency_ms)).filter(Number.isFinite)
    return { id: row.id, name: row.name, address: row.address, connectionHost: row.connection_host, connectionZone: row.connection_zone_name, region: row.region, coordinates: `${Number(row.latitude).toFixed(4)}, ${Number(row.longitude).toFixed(4)}`, latitude: row.latitude, longitude: row.longitude, latency: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0, weight: row.weight, enabled: Boolean(row.enabled), state: aggregateHealth(health.map((item) => String(item.state))) }
  })

  const pools = (poolsQuery.results ?? []).map((row) => ({ id: row.id, name: row.name, description: row.description, monitor: row.monitor_id, minimumHealthy: row.minimum_healthy, enabled: Boolean(row.enabled), origins: poolOriginRows.filter((item) => item.pool_id === row.id && item.enabled).map((item) => item.origin_id), state: aggregateHealth(healthForPool(String(row.id)).map((item) => String(item.state))) }))

  const monitors = (monitorsQuery.results ?? []).map((row) => {
    const monitorPoolIds = pools.filter((pool) => pool.monitor === row.id).map((pool) => String(pool.id))
    const states = healthRows.filter((item) => monitorPoolIds.includes(String(item.pool_id))).map((item) => String(item.state))
    return { id: row.id, name: row.name, type: row.type, method: row.method, path: row.path, port: row.port, interval: row.interval_seconds, timeout: row.timeout_seconds, expected: row.expected_codes, consecutiveFails: row.consecutive_fails, consecutiveSuccesses: row.consecutive_successes, headers: parseHeaders(String(row.headers_json ?? '{}')), followRedirects: Boolean(row.follow_redirects), pools: row.pools, state: aggregateHealth(states) }
  })

  const steeringLabels: Record<string, string> = { proximity: '邻近感知', latency: '动态延迟', random: '随机', failover: '故障转移' }
  const lbPoolRows = loadBalancerPoolsQuery.results ?? []
  const sampleRate = Math.max(0.0001, Math.min(1, Number(sampleRateQuery?.value_json ?? 0.01)))
  const analyticsByHost = new Map((analyticsQuery.results ?? []).map((row) => [String(row.hostname), row]))
  const routesByLoadBalancer = new Map((routesQuery.results ?? []).map((row) => [String(row.load_balancer_id), row]))
  const loadBalancers = (loadBalancersQuery.results ?? []).map((row) => {
    const poolIds = lbPoolRows.filter((item) => item.load_balancer_id === row.id && item.enabled).map((item) => String(item.pool_id))
    const states = pools.filter((pool) => poolIds.includes(String(pool.id))).map((pool) => String(pool.state))
    const analytics = analyticsByHost.get(String(row.hostname))
    const route = routesByLoadBalancer.get(String(row.id))
    return { id: row.id, hostname: row.hostname, originHost: row.origin_host, site: row.site, pools: poolIds, steering: steeringLabels[String(row.steering)] ?? '故障转移', sessionAffinity: Boolean(row.session_affinity), affinityTtlSeconds: row.affinity_ttl_seconds, proximityBuffer: row.proximity_buffer, enabled: Boolean(row.enabled), state: aggregateHealth(states), ttfb: Math.round(Number(analytics?.ttfb ?? 0)), requests: Math.round(Number(analytics?.samples ?? 0) / sampleRate), failovers: Number(analytics?.failovers ?? 0), domain: route ? { zone: route.zone_name, routePattern: route.route_pattern, routeManaged: Boolean(route.route_created), dnsManaged: Boolean(route.dns_created) } : null }
  })

  const originNames = new Map(origins.map((origin) => [String(origin.id), String(origin.name)]))
  const poolNames = new Map(pools.map((pool) => [String(pool.id), String(pool.name)]))
  const logs = (logsQuery.results ?? []).map((row) => ({ id: String(row.id), time: String(row.occurred_at).slice(11, 19), event: row.event_type, hostname: row.hostname ?? '全部站点', origin: originNames.get(String(row.origin_id)) ?? poolNames.get(String(row.pool_id)) ?? '系统', result: row.message, duration: row.duration_ms == null ? '—' : `${row.duration_ms} ms`, level: row.level }))

  const traffic = (trafficQuery.results ?? []).map((row) => ({ time: String(row.bucket).slice(11, 16), requests: Math.round(Number(row.samples ?? 0) / sampleRate), ttfb: Math.round(Number(row.ttfb ?? 0)) }))
  const originDnsZone = parseSettingText(originZoneQuery?.value_json).trim().toLowerCase()
  return { origins, monitors, pools, loadBalancers, logs, analytics: { traffic, sampleRate, failovers: loadBalancers.reduce((sum, item) => sum + Number(item.failovers ?? 0), 0) }, meta: { connected: true, publishedVersion: versionQuery?.version ?? null, publishedAt: versionQuery?.published_at ?? null, originDnsZone: originDnsZone || null, cloudflare: { configured: Boolean(credentialQuery), tokenHint: credentialQuery?.token_hint ?? null, verifiedAt: credentialQuery?.verified_at ?? null } } }
}

function parseSettingText(value: string | null | undefined) {
  if (!value) return ''
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'string' ? parsed : String(value)
  } catch {
    return value.replace(/^"|"$/g, '')
  }
}

async function readOriginDnsZone(db: D1Database) {
  const row = await db.prepare("SELECT value_json FROM settings WHERE key = 'origin_dns_zone'").first<{ value_json: string }>()
  const zone = parseSettingText(row?.value_json).trim().toLowerCase()
  return zone ? normalizeHostname(zone) : ''
}

async function writeOriginDnsZone(db: D1Database, zone: string) {
  await db.prepare("INSERT INTO settings(key, value_json) VALUES ('origin_dns_zone', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").bind(JSON.stringify(zone)).run()
}

async function reservedOriginHostnames(db: D1Database, env: Env, exceptOriginId?: string) {
  const adminHosts = String(env.ADMIN_HOSTS ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
  const [loadBalancers, origins] = await Promise.all([
    db.prepare('SELECT hostname FROM load_balancers').all<{ hostname: string }>(),
    db.prepare('SELECT id, connection_host FROM origins').all<{ id: string; connection_host: string | null }>(),
  ])
  return [
    ...adminHosts,
    ...(loadBalancers.results ?? []).map((item) => item.hostname),
    ...(origins.results ?? []).filter((item) => item.connection_host && item.id !== exceptOriginId).map((item) => String(item.connection_host)),
  ]
}

async function nextOriginDnsLabel(db: D1Database, zoneName: string, reserved: string[], exceptOriginId?: string) {
  const suffix = `.${zoneName}`
  const used = new Set(reserved.map((item) => item.toLowerCase()))
  const rows = await db.prepare('SELECT id, connection_host FROM origins WHERE connection_host IS NOT NULL').all<{ id: string; connection_host: string }>()
  for (const row of rows.results ?? []) {
    if (exceptOriginId && row.id === exceptOriginId) continue
    used.add(String(row.connection_host).toLowerCase())
  }
  let index = 1
  while (used.has(`${originDnsLabel(index)}${suffix}`)) index += 1
  return originDnsLabel(index)
}

async function resolveOriginZone(body: JsonObject, env: Env) {
  const fromBody = String(body.zone ?? '').trim()
  const saved = await readOriginDnsZone(env.DB)
  const zone = fromBody || saved
  if (!zone) throw new Error('请先设置源站接入域名')
  const normalized = normalizeHostname(zone)
  if (!saved) await writeOriginDnsZone(env.DB, normalized)
  return normalized
}

async function attachOriginDns(body: JsonObject, address: string, env: Env, exceptOriginId?: string): Promise<OriginDnsRecord | null> {
  if (body.connectionHost) return null
  const hostname = originHostname(address)
  if (!isIpAddress(hostname) || isPrivateOrLocalIp(hostname)) return null
  const zone = await resolveOriginZone(body, env)
  const reserved = await reservedOriginHostnames(env.DB, env, exceptOriginId)
  const label = await nextOriginDnsLabel(env.DB, zone, reserved, exceptOriginId)
  return provisionOriginDns(zone, label, address, env, reserved)
}

async function provisionUnattachedOrigins(env: Env, zone: string) {
  const rows = await env.DB.prepare('SELECT id, name, address, connection_host FROM origins ORDER BY created_at').all<Record<string, unknown>>()
  const attached: Array<{ id: string; hostname: string }> = []
  for (const row of rows.results ?? []) {
    if (row.connection_host) continue
    const address = String(row.address)
    const hostname = originHostname(address)
    if (!isIpAddress(hostname) || isPrivateOrLocalIp(hostname)) continue
    const reserved = await reservedOriginHostnames(env.DB, env, String(row.id))
    const label = await nextOriginDnsLabel(env.DB, zone, reserved, String(row.id))
    const dns = await provisionOriginDns(zone, label, address, env, reserved)
    await env.DB.prepare("UPDATE origins SET connection_host = ?, connection_zone_id = ?, connection_zone_name = ?, connection_dns_record_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(dns.hostname, dns.zoneId, dns.zoneName, dns.recordId, row.id).run()
    attached.push({ id: String(row.id), hostname: dns.hostname })
  }
  return attached
}

async function saveOriginDnsZone(request: Request, env: Env) {
  const body = await readJson(request)
  const zone = normalizeHostname(requiredText(body.zone, '接入域名'))
  if (env.ENVIRONMENT !== 'development') {
    const zones = await listCredentialZones(env)
    if (!zones.some((item) => zone === item || zone.endsWith(`.${item}`))) throw new CloudflareApiError(`Token 无权访问 ${zone} 所属的 Cloudflare Zone`, 403)
  }
  await writeOriginDnsZone(env.DB, zone)
  const provisioned = await provisionUnattachedOrigins(env, zone)
  await recordEvent(env.DB, 'CONFIG', provisioned.length ? `源站接入域名已设为 ${zone}，已为 ${provisioned.length} 个源站补齐灰云记录` : `源站接入域名已设为 ${zone}`)
  return json({ zone, provisioned })
}

async function createOrigin(request: Request, env: Env) {
  const body = await readJson(request)
  const origin = {
    id: createId('origin'),
    name: requiredText(body.name, '源站名称'),
    address: normalizeOriginAddress(body.address),
    connectionHost: body.connectionHost ? normalizeHostname(body.connectionHost) : null,
    region: requiredText(body.region, '区域'),
    latitude: numberInRange(body.latitude, -90, 90, '纬度'),
    longitude: numberInRange(body.longitude, -180, 180, '经度'),
    weight: integerInRange(body.weight ?? 50, 0, 100, '权重'),
  }
  const dns = await attachOriginDns(body, origin.address, env)
  if (dns) origin.connectionHost = dns.hostname
  try {
    await env.DB.prepare('INSERT INTO origins(id, name, address, connection_host, connection_zone_id, connection_zone_name, connection_dns_record_id, region, latitude, longitude, weight, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').bind(origin.id, origin.name, origin.address, origin.connectionHost, dns?.zoneId ?? null, dns?.zoneName ?? null, dns?.recordId ?? null, origin.region, origin.latitude, origin.longitude, origin.weight).run()
  } catch (error) {
    if (dns) await deleteOriginDnsRecord(dns.zoneId, dns.recordId, env).catch(() => undefined)
    throw error
  }
  await recordEvent(env.DB, 'CONFIG', dns ? `源站已添加，已接入 ${dns.hostname}` : '源站已添加', { originId: origin.id })
  return json({ id: origin.id, connectionHost: origin.connectionHost }, 201)
}

async function updateOrigin(id: string, request: Request, env: Env) {
  const current = await env.DB.prepare('SELECT * FROM origins WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (!current) return json({ error: '源站不存在' }, 404)
  const body = await readJson(request)
  const next = {
    name: body.name === undefined ? String(current.name) : requiredText(body.name, '源站名称'),
    address: body.address === undefined ? String(current.address) : normalizeOriginAddress(body.address),
    connectionHost: body.connectionHost === undefined ? (current.connection_host ? String(current.connection_host) : null) : body.connectionHost ? normalizeHostname(body.connectionHost) : null,
    region: body.region === undefined ? String(current.region) : requiredText(body.region, '区域'),
    latitude: body.latitude === undefined ? Number(current.latitude) : numberInRange(body.latitude, -90, 90, '纬度'),
    longitude: body.longitude === undefined ? Number(current.longitude) : numberInRange(body.longitude, -180, 180, '经度'),
    weight: body.weight === undefined ? Number(current.weight) : integerInRange(body.weight, 0, 100, '权重'),
    enabled: body.enabled === undefined ? current.enabled : Number(booleanValue(body.enabled, true)),
  }
  let zoneId = current.connection_zone_id ? String(current.connection_zone_id) : null
  let zoneName = current.connection_zone_name ? String(current.connection_zone_name) : null
  let recordId = current.connection_dns_record_id ? String(current.connection_dns_record_id) : null
  const requestedZone = String(body.zone ?? '').trim()
  const zoneChanged = Boolean(requestedZone && (!zoneName || normalizeHostname(requestedZone) !== zoneName))
  if (zoneChanged || !next.connectionHost) {
    const dns = await attachOriginDns(body, next.address, env, id)
    if (dns) {
      if (recordId && recordId !== dns.recordId) await deleteOriginDnsRecord(zoneId ?? dns.zoneId, recordId, env).catch(() => undefined)
      next.connectionHost = dns.hostname
      zoneId = dns.zoneId
      zoneName = dns.zoneName
      recordId = dns.recordId
    }
  } else if (recordId && zoneId && next.address !== current.address) {
    await updateOriginDnsRecord(zoneId, recordId, next.address, env)
  }
  await env.DB.prepare("UPDATE origins SET name = ?, address = ?, connection_host = ?, connection_zone_id = ?, connection_zone_name = ?, connection_dns_record_id = ?, region = ?, latitude = ?, longitude = ?, weight = ?, enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(next.name, next.address, next.connectionHost, zoneId, zoneName, recordId, next.region, next.latitude, next.longitude, next.weight, next.enabled, id).run()
  await recordEvent(env.DB, 'CONFIG', '源站已更新', { originId: id })
  return json({ ok: true, connectionHost: next.connectionHost })
}

async function createMonitor(request: Request, env: Env) {
  const body = await readJson(request)
  const type = String(body.type ?? 'HTTPS').toUpperCase()
  if (!['HTTP', 'HTTPS', 'TCP'].includes(type)) throw new Error('监视器协议无效')
  const monitor = {
    id: createId('monitor'), name: requiredText(body.name, '监视器名称'), type,
    method: requestMethod(body.method),
    path: requiredText(body.path ?? '/', '路径或端口'),
    port: optionalPort(body.port),
    interval: integerInRange(body.interval ?? 60, 60, 3600, '检查间隔'),
    timeout: integerInRange(body.timeout ?? 5, 1, 30, '超时'),
    expected: requiredText(body.expected ?? '*', '预期状态码'),
    consecutiveFails: integerInRange(body.consecutiveFails ?? 2, 1, 10, '失败阈值'),
    consecutiveSuccesses: integerInRange(body.consecutiveSuccesses ?? 1, 1, 10, '恢复阈值'),
    headers: requestHeaders(body.headers),
    followRedirects: booleanValue(body.followRedirects, false),
  }
  await env.DB.prepare('INSERT INTO monitors(id, name, type, method, path, port, interval_seconds, timeout_seconds, expected_codes, consecutive_fails, consecutive_successes, headers_json, follow_redirects) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(monitor.id, monitor.name, monitor.type, monitor.method, monitor.path, monitor.port, monitor.interval, monitor.timeout, monitor.expected, monitor.consecutiveFails, monitor.consecutiveSuccesses, JSON.stringify(monitor.headers), Number(monitor.followRedirects)).run()
  await recordEvent(env.DB, 'CONFIG', '监视器已创建')
  return json({ id: monitor.id }, 201)
}

async function updateMonitor(id: string, request: Request, env: Env) {
  const current = await env.DB.prepare('SELECT * FROM monitors WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (!current) return json({ error: '监视器不存在' }, 404)
  const body = await readJson(request)
  const type = body.type === undefined ? String(current.type) : String(body.type).toUpperCase()
  if (!['HTTP', 'HTTPS', 'TCP'].includes(type)) throw new Error('监视器协议无效')
  const headers = requestHeaders(body.headers, parseHeaders(String(current.headers_json ?? '{}')))
  await env.DB.prepare("UPDATE monitors SET name = ?, type = ?, method = ?, path = ?, port = ?, interval_seconds = ?, timeout_seconds = ?, expected_codes = ?, consecutive_fails = ?, consecutive_successes = ?, headers_json = ?, follow_redirects = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(
    body.name === undefined ? current.name : requiredText(body.name, '监视器名称'),
    type,
    requestMethod(body.method, String(current.method) as 'GET' | 'HEAD'),
    body.path === undefined ? current.path : requiredText(body.path, '路径或端口'),
    optionalPort(body.port, current.port == null ? null : Number(current.port)),
    body.interval === undefined ? current.interval_seconds : integerInRange(body.interval, 60, 3600, '检查间隔'),
    body.timeout === undefined ? current.timeout_seconds : integerInRange(body.timeout, 1, 30, '超时'),
    body.expected === undefined ? current.expected_codes : requiredText(body.expected, '预期状态码'),
    body.consecutiveFails === undefined ? current.consecutive_fails : integerInRange(body.consecutiveFails, 1, 10, '失败阈值'),
    body.consecutiveSuccesses === undefined ? current.consecutive_successes : integerInRange(body.consecutiveSuccesses, 1, 10, '恢复阈值'),
    JSON.stringify(headers),
    body.followRedirects === undefined ? current.follow_redirects : Number(booleanValue(body.followRedirects, false)),
    id,
  ).run()
  await recordEvent(env.DB, 'CONFIG', '监视器已更新')
  return json({ ok: true })
}

async function createPool(request: Request, env: Env) {
  const body = await readJson(request)
  const id = createId('pool')
  const name = requiredText(body.name, '池名称')
  const monitorId = String(body.monitor ?? '').trim() || await ensureReachabilityMonitor(env.DB)
  const origins = stringArray(body.origins, '源站')
  const statements = [
    env.DB.prepare('INSERT INTO pools(id, name, description, monitor_id, minimum_healthy, enabled) VALUES (?, ?, ?, ?, ?, 1)').bind(id, name, String(body.description ?? '').trim(), monitorId, integerInRange(body.minimumHealthy ?? 1, 1, origins.length, '最低健康源站数')),
    ...origins.map((originId, priority) => env.DB.prepare('INSERT INTO pool_origins(pool_id, origin_id, priority, enabled) VALUES (?, ?, ?, 1)').bind(id, originId, priority)),
    ...origins.map((originId) => env.DB.prepare("INSERT OR IGNORE INTO health_states(pool_id, origin_id, state) VALUES (?, ?, 'unknown')").bind(id, originId)),
  ]
  await env.DB.batch(statements)
  await recordEvent(env.DB, 'CONFIG', '池已创建', { poolId: id })
  return json({ id }, 201)
}

async function updatePool(id: string, request: Request, env: Env) {
  const current = await env.DB.prepare('SELECT * FROM pools WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (!current) return json({ error: '池不存在' }, 404)
  const body = await readJson(request)
  await env.DB.prepare("UPDATE pools SET name = ?, description = ?, monitor_id = ?, minimum_healthy = ?, enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(
    body.name === undefined ? current.name : requiredText(body.name, '池名称'),
    body.description === undefined ? current.description : String(body.description).trim(),
    body.monitor === undefined ? current.monitor_id : requiredText(body.monitor, '监视器'),
    body.minimumHealthy === undefined ? current.minimum_healthy : integerInRange(body.minimumHealthy, 1, 100, '最低健康源站数'),
    body.enabled === undefined ? current.enabled : Number(booleanValue(body.enabled, true)), id,
  ).run()
  if (body.origins !== undefined) {
    const origins = stringArray(body.origins, '源站')
    await env.DB.batch([
      env.DB.prepare('DELETE FROM pool_origins WHERE pool_id = ?').bind(id),
      env.DB.prepare('DELETE FROM health_states WHERE pool_id = ?').bind(id),
      ...origins.map((originId, priority) => env.DB.prepare('INSERT INTO pool_origins(pool_id, origin_id, priority, enabled) VALUES (?, ?, ?, 1)').bind(id, originId, priority)),
      ...origins.map((originId) => env.DB.prepare("INSERT OR IGNORE INTO health_states(pool_id, origin_id, state) VALUES (?, ?, 'unknown')").bind(id, originId)),
    ])
  }
  await recordEvent(env.DB, 'CONFIG', '池已更新', { poolId: id })
  return json({ ok: true })
}

async function createLoadBalancer(request: Request, env: Env) {
  const body = await readJson(request)
  const id = createId('lb')
  const hostname = normalizeHostname(body.hostname)
  const adminHosts = String(env.ADMIN_HOSTS ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
  if (adminHosts.includes(hostname)) throw new Error('管理界面域名不能同时作为负载平衡业务域名')
  const pools = stringArray(body.pools, '池')
  const fallback = await env.DB.prepare(`
    SELECT o.address
    FROM pool_origins po
    JOIN origins o ON o.id = po.origin_id AND o.enabled = 1
    WHERE po.pool_id = ? AND po.enabled = 1
    ORDER BY po.priority, o.created_at
    LIMIT 1
  `).bind(pools[0]).first<{ address: string }>()
  if (!fallback?.address) throw new Error('所选池没有可用的 DNS 保底源站')
  const provisioned = await provisionHostname(hostname, fallback.address, env)
  const statements = [
    env.DB.prepare('INSERT INTO load_balancers(id, hostname, origin_host, site, steering, session_affinity, affinity_ttl_seconds, proximity_buffer, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)').bind(id, hostname, body.originHost ? normalizeHostname(body.originHost) : null, requiredText(body.site, '站点名称'), steeringValue(body.steering), Number(booleanValue(body.sessionAffinity, true)), integerInRange(body.affinityTtlSeconds ?? 1800, 60, 604800, '会话保持时间'), numberInRange(body.proximityBuffer ?? 0.15, 0, 1, '距离缓冲')),
    ...pools.map((poolId, priority) => env.DB.prepare('INSERT INTO load_balancer_pools(load_balancer_id, pool_id, priority, enabled) VALUES (?, ?, ?, 1)').bind(id, poolId, priority)),
    env.DB.prepare('INSERT INTO load_balancer_routes(load_balancer_id, zone_id, zone_name, route_id, route_pattern, route_created, dns_record_id, dns_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, provisioned.zoneId, provisioned.zoneName, provisioned.routeId, provisioned.routePattern, Number(provisioned.routeCreated), provisioned.dnsRecordId, Number(provisioned.dnsCreated)),
  ]
  try {
    await env.DB.batch(statements)
  } catch (error) {
    await deprovisionHostname(provisioned, env, true).catch(() => undefined)
    throw error
  }
  await recordEvent(env.DB, 'CONFIG', '负载平衡器已创建', { hostname })
  return json({ id, domain: provisioned }, 201)
}

async function testMonitor(request: Request, env: Env) {
  const body = await readJson(request)
  const originId = requiredText(body.originId, '源站')
  const monitorId = requiredText(body.monitorId, '监视器')
  const [origin, monitor] = await Promise.all([
    env.DB.prepare('SELECT id, name, address, connection_host, region, latitude, longitude, weight FROM origins WHERE id = ?').bind(originId).first<Record<string, unknown>>(),
    env.DB.prepare('SELECT id, name, type, method, path, port, interval_seconds, timeout_seconds, expected_codes, consecutive_fails, consecutive_successes, headers_json, follow_redirects FROM monitors WHERE id = ?').bind(monitorId).first<Record<string, unknown>>(),
  ])
  if (!origin || !monitor) return json({ error: '源站或监视器不存在' }, 404)
  const result = await probeOrigin({ id: String(origin.id), name: String(origin.name), address: String(origin.address), connectionHost: origin.connection_host ? String(origin.connection_host) : null, region: String(origin.region), latitude: Number(origin.latitude), longitude: Number(origin.longitude), weight: Number(origin.weight) }, { id: String(monitor.id), name: String(monitor.name), type: String(monitor.type) as 'HTTP' | 'HTTPS' | 'TCP', method: requestMethod(monitor.method), path: String(monitor.path), port: monitor.port == null ? null : Number(monitor.port), intervalSeconds: Number(monitor.interval_seconds), timeoutSeconds: Number(monitor.timeout_seconds), expectedCodes: String(monitor.expected_codes), consecutiveFails: Number(monitor.consecutive_fails), consecutiveSuccesses: Number(monitor.consecutive_successes), headers: parseHeaders(String(monitor.headers_json || '{}')), followRedirects: Boolean(monitor.follow_redirects) })
  return json(result, result.ok ? 200 : 422)
}

async function overrideHealth(id: string, request: Request, env: Env) {
  const body = await readJson(request)
  const state = String(body.state)
  if (!['healthy', 'unhealthy'].includes(state)) throw new Error('健康状态无效')
  const result = await env.DB.prepare("UPDATE health_states SET state = ?, consecutive_failures = CASE WHEN ? = 'unhealthy' THEN 2 ELSE 0 END, consecutive_successes = CASE WHEN ? = 'healthy' THEN 2 ELSE 0 END, last_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_error = CASE WHEN ? = 'unhealthy' THEN '由管理员模拟' ELSE NULL END WHERE origin_id = ?").bind(state, state, state, state, id).run()
  if (!result.meta.changes) return json({ error: '该源站尚未加入任何池' }, 409)
  await recordEvent(env.DB, 'HEALTH', state === 'healthy' ? '已恢复' : '已移出', { originId: id, level: state === 'healthy' ? 'success' : 'warning' })
  await refreshActiveSnapshotHealth(env.DB, env.CONFIG_KV)
  return json({ ok: true })
}

async function publishConfiguration(request: Request, env: Env) {
  const body: JsonObject = await readJson(request).catch(() => ({}))
  const versionRow = await env.DB.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM config_versions').first<{ version: number }>()
  const version = Number(versionRow?.version ?? 1)
  const snapshot = await buildSnapshot(env.DB, version)
  const errors = validateSnapshot(snapshot)
  for (const pool of Object.values(snapshot.pools)) {
    const healthy = pool.origins.filter((item) => snapshot.health[`${pool.id}:${item.originId}`]?.state === 'healthy').length
    if (healthy < pool.minimumHealthy) errors.push(`池 ${pool.name} 只有 ${healthy} 个健康源站，低于最低要求 ${pool.minimumHealthy}`)
  }
  if (errors.length) return json({ error: '配置验证失败', details: errors }, 422)
  const note = String(body.note ?? '').trim().slice(0, 240)
  const insert = await env.DB.prepare("INSERT INTO config_versions(version, status, snapshot_json, note) VALUES (?, 'staging', ?, ?)").bind(version, JSON.stringify(snapshot), note).run()
  try {
    await writeActiveSnapshot(env.CONFIG_KV, snapshot)
    await env.DB.batch([
      env.DB.prepare("UPDATE config_versions SET status = 'superseded' WHERE status = 'published'"),
      env.DB.prepare("UPDATE config_versions SET status = 'published', published_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(insert.meta.last_row_id),
      env.DB.prepare("INSERT INTO events(event_type, level, message) VALUES ('CONFIG', 'success', ?)").bind(`配置 v${version} 已发布`),
    ])
    return json({ version, publishedAt: snapshot.publishedAt })
  } catch (error) {
    await env.DB.prepare("UPDATE config_versions SET status = 'failed' WHERE id = ?").bind(insert.meta.last_row_id).run()
    throw error
  }
}

async function rollbackConfiguration(id: string, env: Env) {
  const previous = await env.DB.prepare('SELECT version, snapshot_json FROM config_versions WHERE id = ?').bind(id).first<{ version: number; snapshot_json: string }>()
  if (!previous) return json({ error: '配置版本不存在' }, 404)
  const versionRow = await env.DB.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM config_versions').first<{ version: number }>()
  const nextVersion = Number(versionRow?.version ?? 1)
  const snapshot = JSON.parse(previous.snapshot_json) as ConfigSnapshot
  snapshot.version = nextVersion
  snapshot.publishedAt = new Date().toISOString()
  const errors = validateSnapshot(snapshot)
  if (errors.length) return json({ error: '历史配置已经不完整', details: errors }, 422)
  const insert = await env.DB.prepare("INSERT INTO config_versions(version, status, snapshot_json, note) VALUES (?, 'staging', ?, ?)").bind(nextVersion, JSON.stringify(snapshot), `回滚自 v${previous.version}`).run()
  await writeActiveSnapshot(env.CONFIG_KV, snapshot)
  await env.DB.batch([
    env.DB.prepare("UPDATE config_versions SET status = 'superseded' WHERE status = 'published'"),
    env.DB.prepare("UPDATE config_versions SET status = 'published', published_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(insert.meta.last_row_id),
    env.DB.prepare("UPDATE config_versions SET status = 'rolled_back' WHERE id = ?").bind(id),
    env.DB.prepare("INSERT INTO events(event_type, level, message) VALUES ('CONFIG', 'warning', ?)").bind(`已从 v${previous.version} 回滚为 v${nextVersion}`),
  ])
  return json({ version: nextVersion, rolledBackFrom: previous.version })
}

async function listVersions(env: Env) {
  const result = await env.DB.prepare('SELECT id, version, status, note, created_at AS createdAt, published_at AS publishedAt FROM config_versions ORDER BY version DESC LIMIT 50').all()
  return json(result.results ?? [])
}

async function deleteOrigin(id: string, env: Env) {
  const row = await env.DB.prepare('SELECT connection_zone_id, connection_dns_record_id FROM origins WHERE id = ?').bind(id).first<{ connection_zone_id: string | null; connection_dns_record_id: string | null }>()
  const result = await deleteEntity('origins', id, env)
  if (result.status === 204 && row?.connection_zone_id && row.connection_dns_record_id) {
    await deleteOriginDnsRecord(row.connection_zone_id, row.connection_dns_record_id, env).catch(() => undefined)
  }
  return result
}

async function deleteEntity(table: 'origins' | 'monitors' | 'pools' | 'load_balancers', id: string, env: Env) {
  if (table === 'monitors' && id === REACHABILITY_MONITOR_ID) return json({ error: '默认的源站可达性检查不能删除', code: 'RESOURCE_PROTECTED' }, 409)
  const dependencyQueries = {
    origins: ['SELECT COUNT(*) AS count FROM pool_origins WHERE origin_id = ?', '该源站仍被池引用，请先从池中移除'],
    monitors: ['SELECT COUNT(*) AS count FROM pools WHERE monitor_id = ?', '该监视器仍被池引用，请先修改或删除相关池'],
    pools: ['SELECT COUNT(*) AS count FROM load_balancer_pools WHERE pool_id = ?', '该池仍被负载平衡器引用，请先修改或删除相关负载平衡器'],
    load_balancers: ["SELECT 0 AS count", ''],
  } as const
  const [dependencySql, dependencyMessage] = dependencyQueries[table]
  const dependency = table === 'load_balancers' ? await env.DB.prepare(dependencySql).first<{ count: number }>() : await env.DB.prepare(dependencySql).bind(id).first<{ count: number }>()
  if (Number(dependency?.count ?? 0) > 0) return json({ error: dependencyMessage, code: 'RESOURCE_IN_USE' }, 409)
  const result = await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run()
  if (!result.meta.changes) return json({ error: '记录不存在' }, 404)
  await recordEvent(env.DB, 'CONFIG', '记录已删除')
  return new Response(null, { status: 204, headers: securityHeaders })
}

async function deleteLoadBalancer(id: string, request: Request, env: Env) {
  const row = await env.DB.prepare('SELECT zone_id, zone_name, route_id, route_pattern, route_created, dns_record_id, dns_created FROM load_balancer_routes WHERE load_balancer_id = ?').bind(id).first<Record<string, unknown>>()
  if (row) {
    const provisioned: ProvisionedHostname = {
      zoneId: String(row.zone_id), zoneName: String(row.zone_name), routeId: String(row.route_id), routePattern: String(row.route_pattern),
      routeCreated: Boolean(row.route_created), dnsRecordId: row.dns_record_id ? String(row.dns_record_id) : null, dnsCreated: Boolean(row.dns_created),
    }
    const removeDns = new URL(request.url).searchParams.get('removeDns') === 'true'
    await deprovisionHostname(provisioned, env, removeDns)
  }
  return deleteEntity('load_balancers', id, env)
}

async function routeApi(request: Request, env: Env) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent)

  if (request.method === 'GET' && path === '/api/health') return json({ ok: true, service: 'worker-lb', time: new Date().toISOString() })
  if (!await authorized(request, env)) return json({ error: '需要 Cloudflare Access 登录或有效管理令牌', code: 'UNAUTHORIZED' }, 401, { 'www-authenticate': 'Bearer realm="Worker LB"' })

  if (request.method === 'GET' && path === '/api/state') {
    await ensureReachabilityMonitor(env.DB)
    return json(await getControlState(env.DB))
  }
  if (request.method === 'PUT' && path === '/api/cloudflare/token') {
    const body = await readJson(request)
    return json(await saveCloudflareCredential(body.token, env))
  }
  if (request.method === 'POST' && path === '/api/cloudflare/test') return json(await testCloudflareCredential(env))
  if (request.method === 'GET' && path === '/api/cloudflare/zones') return json({ zones: await listCredentialZones(env) })
  if (request.method === 'PUT' && path === '/api/origin-dns-zone') return saveOriginDnsZone(request, env)
  if (request.method === 'DELETE' && path === '/api/cloudflare/token') {
    await removeCloudflareCredential(env)
    return new Response(null, { status: 204, headers: securityHeaders })
  }
  if (request.method === 'GET' && path === '/api/versions') return listVersions(env)
  if (request.method === 'POST' && path === '/api/publish') return publishConfiguration(request, env)
  if (request.method === 'POST' && parts[1] === 'versions' && parts[3] === 'rollback') return rollbackConfiguration(parts[2], env)
  if (request.method === 'POST' && path === '/api/origins') return createOrigin(request, env)
  if (request.method === 'PATCH' && parts[1] === 'origins' && parts.length === 3) return updateOrigin(parts[2], request, env)
  if (request.method === 'POST' && parts[1] === 'origins' && parts[3] === 'health') return overrideHealth(parts[2], request, env)
  if (request.method === 'POST' && path === '/api/monitors') return createMonitor(request, env)
  if (request.method === 'PATCH' && parts[1] === 'monitors' && parts.length === 3) return updateMonitor(parts[2], request, env)
  if (request.method === 'POST' && path === '/api/monitors/test') return testMonitor(request, env)
  if (request.method === 'POST' && path === '/api/pools') return createPool(request, env)
  if (request.method === 'PATCH' && parts[1] === 'pools' && parts.length === 3) return updatePool(parts[2], request, env)
  if (request.method === 'POST' && path === '/api/load-balancers') return createLoadBalancer(request, env)
  if (request.method === 'DELETE' && parts.length === 3) {
    const tables = { origins: 'origins', monitors: 'monitors', pools: 'pools', 'load-balancers': 'load_balancers' } as const
    const table = tables[parts[1] as keyof typeof tables]
    if (table === 'load_balancers') return deleteLoadBalancer(parts[2], request, env)
    if (table === 'origins') return deleteOrigin(parts[2], env)
    if (table) return deleteEntity(table, parts[2], env)
  }
  return json({ error: 'API 路径不存在' }, 404)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await routeApi(request, env)
      const response = await env.ASSETS.fetch(request)
      const headers = new Headers(response.headers)
      for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value)
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      if (error instanceof CloudflareApiError) return json({ error: message, code: 'CLOUDFLARE_API_ERROR' }, error.status)
      const conflict = /UNIQUE constraint|FOREIGN KEY constraint/i.test(message)
      return json({ error: conflict ? '记录重复，或仍被其他配置引用' : message }, conflict ? 409 : 400)
    }
  },
} satisfies ExportedHandler<Env>
