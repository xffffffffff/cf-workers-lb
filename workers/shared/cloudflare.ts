const apiBase = 'https://api.cloudflare.com/client/v4'

export interface CloudflareControlEnv {
  DB: D1Database
  TOKEN_ENCRYPTION_KEY?: string
  WORKER_NAME?: string
  ENVIRONMENT?: string
}

interface ApiEnvelope<T> {
  success: boolean
  result: T
  errors?: Array<{ code?: number; message?: string }>
  result_info?: { page?: number; total_pages?: number; total_count?: number }
}

interface Zone {
  id: string
  name: string
  status?: string
}

interface WorkerRoute {
  id: string
  pattern: string
  script?: string
}

interface DnsRecord {
  id: string
  type: string
  name: string
  content: string
  proxied?: boolean
}

interface CredentialRow {
  encrypted_token: string
  iv: string
  token_hint: string
  verified_at: string
}

export interface ProvisionedHostname {
  zoneId: string
  zoneName: string
  routeId: string
  routePattern: string
  routeCreated: boolean
  dnsRecordId: string | null
  dnsCreated: boolean
}

export class CloudflareApiError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

async function encryptionKey(secret: string) {
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function encryptionSecret(env: CloudflareControlEnv) {
  if (env.TOKEN_ENCRYPTION_KEY) return env.TOKEN_ENCRYPTION_KEY
  if (env.ENVIRONMENT === 'development') return 'local-development-token-encryption-key-change-me'
  throw new CloudflareApiError('尚未配置 TOKEN_ENCRYPTION_KEY Worker Secret', 503)
}

async function encryptToken(token: string, env: CloudflareControlEnv) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(encryptionSecret(env)), new TextEncoder().encode(token))
  return { encryptedToken: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) }
}

async function decryptToken(row: CredentialRow, env: CloudflareControlEnv) {
  try {
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(row.iv) }, await encryptionKey(encryptionSecret(env)), base64ToBytes(row.encrypted_token))
    return new TextDecoder().decode(decrypted)
  } catch {
    throw new CloudflareApiError('Cloudflare API Token 无法解密，请在设置中重新保存', 503)
  }
}

async function cloudflareRequest<T>(token: string, path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set('authorization', `Bearer ${token}`)
  if (init?.body) headers.set('content-type', 'application/json')
  const response = await fetch(`${apiBase}${path}`, { ...init, headers })
  let payload: ApiEnvelope<T> | undefined
  try { payload = await response.json<ApiEnvelope<T>>() } catch { /* Cloudflare returned a non-JSON error. */ }
  if (!response.ok || !payload?.success) {
    const detail = payload?.errors?.map((item) => item.message).filter(Boolean).join('；')
    throw new CloudflareApiError(detail || `Cloudflare API 请求失败（${response.status}）`, response.status || 502)
  }
  return payload
}

async function listZones(token: string) {
  const zones: Zone[] = []
  for (let page = 1; page <= 20; page += 1) {
    const payload = await cloudflareRequest<Zone[]>(token, `/zones?status=active&per_page=50&page=${page}`)
    zones.push(...payload.result)
    if (page >= Number(payload.result_info?.total_pages ?? 1)) break
  }
  return zones
}

async function verifyToken(token: string, env: CloudflareControlEnv) {
  if (env.ENVIRONMENT === 'development' && token.startsWith('test_cf_token_')) return { zones: [{ id: 'local-zone', name: 'example.com' }] satisfies Zone[] }
  await cloudflareRequest<{ status?: string }>(token, '/user/tokens/verify')
  const zones = await listZones(token)
  if (!zones.length) throw new CloudflareApiError('Token 没有可访问的活动 Zone，请检查 Zone Read 权限和资源范围', 403)
  return { zones }
}

async function credentialRow(db: D1Database) {
  return db.prepare('SELECT encrypted_token, iv, token_hint, verified_at FROM cloudflare_credentials WHERE id = 1').first<CredentialRow>()
}

export async function cloudflareCredentialStatus(db: D1Database) {
  const row = await credentialRow(db)
  return { configured: Boolean(row), tokenHint: row?.token_hint ?? null, verifiedAt: row?.verified_at ?? null }
}

export async function saveCloudflareCredential(tokenValue: unknown, env: CloudflareControlEnv) {
  const token = String(tokenValue ?? '').trim()
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw new CloudflareApiError('Cloudflare API Token 格式无效')
  const verification = await verifyToken(token, env)
  const encrypted = await encryptToken(token, env)
  const verifiedAt = new Date().toISOString()
  const tokenHint = `•••• ${token.slice(-4)}`
  await env.DB.prepare("INSERT INTO cloudflare_credentials(id, encrypted_token, iv, token_hint, verified_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET encrypted_token = excluded.encrypted_token, iv = excluded.iv, token_hint = excluded.token_hint, verified_at = excluded.verified_at, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
    .bind(encrypted.encryptedToken, encrypted.iv, tokenHint, verifiedAt).run()
  return { configured: true, tokenHint, verifiedAt, zoneCount: verification.zones.length }
}

export async function removeCloudflareCredential(env: CloudflareControlEnv) {
  const routeCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM load_balancer_routes').first<{ count: number }>()
  if (Number(routeCount?.count ?? 0) > 0) throw new CloudflareApiError('仍有已接入域名，请先删除对应负载平衡器以清理 Worker Route', 409)
  await env.DB.prepare('DELETE FROM cloudflare_credentials WHERE id = 1').run()
}

async function savedToken(env: CloudflareControlEnv) {
  const row = await credentialRow(env.DB)
  if (!row) throw new CloudflareApiError('请先在设置中添加 Cloudflare API Token', 409)
  return decryptToken(row, env)
}

export async function testCloudflareCredential(env: CloudflareControlEnv) {
  const token = await savedToken(env)
  const verification = await verifyToken(token, env)
  return { ok: true, zoneCount: verification.zones.length, zones: verification.zones.map((zone) => zone.name).sort() }
}

function dnsTarget(address: string) {
  let target = address.trim().toLowerCase()
  if (target.startsWith('[')) {
    const closing = target.indexOf(']')
    if (closing > 1) target = target.slice(1, closing)
  } else if ((target.match(/:/g) ?? []).length === 1 && /:\d+$/.test(target)) {
    target = target.replace(/:\d+$/, '')
  }
  const ipv4 = target.split('.').length === 4 && target.split('.').every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  return { type: ipv4 ? 'A' : target.includes(':') ? 'AAAA' : 'CNAME', content: target }
}

async function findZone(token: string, hostname: string) {
  const zones = await listZones(token)
  return zones.filter((zone) => hostname === zone.name || hostname.endsWith(`.${zone.name}`)).sort((left, right) => right.name.length - left.name.length)[0]
}

export async function provisionHostname(hostname: string, fallbackAddress: string, env: CloudflareControlEnv): Promise<ProvisionedHostname> {
  if (env.ENVIRONMENT === 'development') {
    return { zoneId: 'local-zone', zoneName: hostname.split('.').slice(-2).join('.'), routeId: `local-route-${crypto.randomUUID()}`, routePattern: `${hostname}/*`, routeCreated: true, dnsRecordId: `local-dns-${crypto.randomUUID()}`, dnsCreated: true }
  }
  if (!env.WORKER_NAME) throw new CloudflareApiError('尚未配置 WORKER_NAME', 503)
  const token = await savedToken(env)
  const zone = await findZone(token, hostname)
  if (!zone) throw new CloudflareApiError(`Token 无权访问 ${hostname} 所属的 Cloudflare Zone`, 403)
  const routePattern = `${hostname}/*`
  const routes = (await cloudflareRequest<WorkerRoute[]>(token, `/zones/${zone.id}/workers/routes`)).result
  const existingRoute = routes.find((route) => route.pattern.toLowerCase() === routePattern)
  if (existingRoute?.script && existingRoute.script !== env.WORKER_NAME) throw new CloudflareApiError(`${routePattern} 已绑定到另一个 Worker：${existingRoute.script}`, 409)

  let route = existingRoute
  let routeCreated = false
  if (!route) {
    route = (await cloudflareRequest<WorkerRoute>(token, `/zones/${zone.id}/workers/routes`, { method: 'POST', body: JSON.stringify({ pattern: routePattern, script: env.WORKER_NAME }) })).result
    routeCreated = true
  }

  try {
    const records = (await cloudflareRequest<DnsRecord[]>(token, `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`)).result
    let dnsRecord = records.find((record) => ['A', 'AAAA', 'CNAME'].includes(record.type))
    let dnsCreated = false
    if (dnsRecord && !dnsRecord.proxied) {
      dnsRecord = (await cloudflareRequest<DnsRecord>(token, `/zones/${zone.id}/dns_records/${dnsRecord.id}`, { method: 'PATCH', body: JSON.stringify({ proxied: true }) })).result
    } else if (!dnsRecord) {
      const target = dnsTarget(fallbackAddress)
      dnsRecord = (await cloudflareRequest<DnsRecord>(token, `/zones/${zone.id}/dns_records`, { method: 'POST', body: JSON.stringify({ type: target.type, name: hostname, content: target.content, ttl: 1, proxied: true }) })).result
      dnsCreated = true
    }
    return { zoneId: zone.id, zoneName: zone.name, routeId: route.id, routePattern, routeCreated, dnsRecordId: dnsRecord?.id ?? null, dnsCreated }
  } catch (error) {
    if (routeCreated) await cloudflareRequest<unknown>(token, `/zones/${zone.id}/workers/routes/${route.id}`, { method: 'DELETE' }).catch(() => undefined)
    throw error
  }
}

export async function deprovisionHostname(provisioned: ProvisionedHostname, env: CloudflareControlEnv, removeDns = false) {
  if (env.ENVIRONMENT === 'development') return
  const token = await savedToken(env)
  if (provisioned.routeCreated) await cloudflareRequest<unknown>(token, `/zones/${provisioned.zoneId}/workers/routes/${provisioned.routeId}`, { method: 'DELETE' })
  if (removeDns && provisioned.dnsCreated && provisioned.dnsRecordId) await cloudflareRequest<unknown>(token, `/zones/${provisioned.zoneId}/dns_records/${provisioned.dnsRecordId}`, { method: 'DELETE' })
}
