import { ACTIVE_SNAPSHOT_KEY, type ConfigSnapshot, healthKey, originConnectionHost, type SnapshotLoadBalancer, type SnapshotOrigin, type SnapshotPool } from '../shared/model'

interface Env {
  CONFIG_KV: KVNamespace
  DB: D1Database
  AFFINITY_SECRET: string
  CONFIG_CACHE_SECONDS?: string
  REQUEST_LOG_SAMPLE_RATE?: string
  ENVIRONMENT?: string
}

interface Candidate {
  pool: SnapshotPool
  origin: SnapshotOrigin
  priority: number
  weight: number
  state: 'healthy' | 'unhealthy' | 'unknown'
  latency: number | null
}

let cachedSnapshot: { value: ConfigSnapshot; expiresAt: number } | undefined
let affinityKey: CryptoKey | undefined
let affinityKeySource = ''

async function getSnapshot(env: Env) {
  const now = Date.now()
  if (cachedSnapshot && cachedSnapshot.expiresAt > now) return cachedSnapshot.value
  const value = await env.CONFIG_KV.get<ConfigSnapshot>(ACTIVE_SNAPSHOT_KEY, 'json')
  if (!value || value.schemaVersion !== 1) return null
  const cacheSeconds = Math.max(1, Math.min(60, Number(env.CONFIG_CACHE_SECONDS ?? 5)))
  cachedSnapshot = { value, expiresAt: now + cacheSeconds * 1000 }
  return value
}

function hash(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return result >>> 0
}

function weightedPick(candidates: Candidate[], seed: string) {
  const total = candidates.reduce((sum, item) => sum + Math.max(0, item.weight), 0)
  if (total <= 0) return candidates[hash(seed) % candidates.length]
  let cursor = hash(seed) % total
  for (const candidate of candidates) {
    cursor -= Math.max(0, candidate.weight)
    if (cursor < 0) return candidate
  }
  return candidates[candidates.length - 1]
}

function haversine(latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number) {
  const radians = (degrees: number) => degrees * Math.PI / 180
  const deltaLatitude = radians(latitudeB - latitudeA)
  const deltaLongitude = radians(longitudeB - longitudeA)
  const a = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(deltaLongitude / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function requestSeed(request: Request<unknown, IncomingRequestCfProperties>, hostname: string) {
  return `${request.headers.get('cf-connecting-ip') ?? 'anonymous'}:${hostname}:${new URL(request.url).pathname}`
}

function candidatesForLoadBalancer(snapshot: ConfigSnapshot, loadBalancer: SnapshotLoadBalancer, excludedOriginIds = new Set<string>()) {
  const fallback: Candidate[][] = []
  for (const poolReference of [...loadBalancer.pools].sort((left, right) => left.priority - right.priority)) {
    const pool = snapshot.pools[poolReference.poolId]
    if (!pool) continue
    const candidates = pool.origins.flatMap((item) => {
      const origin = snapshot.origins[item.originId]
      if (!origin || excludedOriginIds.has(origin.id)) return []
      const health = snapshot.health[healthKey(pool.id, origin.id)]
      return [{ pool, origin, priority: item.priority, weight: item.weight, state: health?.state ?? 'unknown', latency: health?.lastLatencyMs ?? null } satisfies Candidate]
    })
    const healthy = candidates.filter((item) => item.state === 'healthy')
    if (healthy.length >= pool.minimumHealthy) return healthy
    const unknown = candidates.filter((item) => item.state === 'unknown')
    if (healthy.length || unknown.length) fallback.push([...healthy, ...unknown])
    else if (candidates.length) fallback.push(candidates)
  }
  return fallback[0] ?? []
}

function chooseCandidate(request: Request<unknown, IncomingRequestCfProperties>, loadBalancer: SnapshotLoadBalancer, candidates: Candidate[]) {
  const seed = requestSeed(request, loadBalancer.hostname)
  if (candidates.length <= 1) return candidates[0]
  if (loadBalancer.steering === 'failover') {
    const priority = Math.min(...candidates.map((item) => item.priority))
    return weightedPick(candidates.filter((item) => item.priority === priority), seed)
  }
  if (loadBalancer.steering === 'latency') {
    const measured = candidates.filter((item) => item.latency !== null)
    if (!measured.length) return weightedPick(candidates, seed)
    const fastest = Math.min(...measured.map((item) => item.latency as number))
    return weightedPick(measured.filter((item) => (item.latency as number) <= fastest * 1.15), seed)
  }
  if (loadBalancer.steering === 'proximity') {
    const cf = request.cf as IncomingRequestCfProperties | undefined
    const latitude = Number(cf?.latitude)
    const longitude = Number(cf?.longitude)
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      const withDistance = candidates.map((item) => ({ item, distance: haversine(latitude, longitude, item.origin.latitude, item.origin.longitude) }))
      const closest = Math.min(...withDistance.map((item) => item.distance))
      const nearby = withDistance.filter((item) => item.distance <= closest * (1 + loadBalancer.proximityBuffer)).map((item) => item.item)
      return weightedPick(nearby, seed)
    }
  }
  return weightedPick(candidates, `${seed}:${crypto.getRandomValues(new Uint32Array(1))[0]}`)
}

function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function getAffinityKey(secret: string) {
  if (!affinityKey || affinityKeySource !== secret) {
    affinityKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    affinityKeySource = secret
  }
  return affinityKey
}

async function signAffinity(originId: string, secret: string) {
  const signature = await crypto.subtle.sign('HMAC', await getAffinityKey(secret), new TextEncoder().encode(originId))
  return `${originId}.${base64Url(new Uint8Array(signature)).slice(0, 22)}`
}

async function affinityOrigin(request: Request, candidates: Candidate[], secret: string) {
  if (!secret) return undefined
  const cookie = request.headers.get('cookie')?.split(';').map((item) => item.trim()).find((item) => item.startsWith('__wlb='))?.slice(6)
  if (!cookie) return undefined
  const splitAt = cookie.lastIndexOf('.')
  if (splitAt <= 0) return undefined
  const originId = cookie.slice(0, splitAt)
  const expected = await signAffinity(originId, secret)
  if (expected !== cookie) return undefined
  return candidates.find((item) => item.origin.id === originId && item.state !== 'unhealthy')
}

function originRequest(request: Request<unknown, unknown>, origin: SnapshotOrigin, loadBalancer: SnapshotLoadBalancer): Request<unknown, IncomingRequestCfProperties> {
  const incomingUrl = new URL(request.url)
  const connectionHost = originConnectionHost(origin)
  if (loadBalancer.originHost && !connectionHost) throw new Error('自定义源站 Host 需要为源站设置连接主机名，不能直接使用 IP')
  if (connectionHost) {
    const address = new URL(`https://${origin.address}`)
    incomingUrl.hostname = loadBalancer.originHost ?? loadBalancer.hostname
    incomingUrl.port = address.port
  } else {
    incomingUrl.host = origin.address
  }
  const headers = new Headers(request.headers)
  headers.set('x-forwarded-host', new URL(request.url).host)
  headers.set('x-forwarded-proto', new URL(request.url).protocol.replace(':', ''))
  headers.set('x-worker-lb-origin-id', origin.id)
  return new Request(incomingUrl, { method: request.method, headers, body: request.body, redirect: 'manual', cf: connectionHost ? { resolveOverride: connectionHost } : undefined }) as Request<unknown, IncomingRequestCfProperties>
}

function retryable(response: Response) {
  return [500, 502, 503, 504].includes(response.status)
}

async function recordRequest(env: Env, request: Request, loadBalancer: SnapshotLoadBalancer, candidate: Candidate, response: Response | null, durationMs: number, failover: boolean, sampleRateValue?: number, error?: string) {
  const sampleRate = Math.max(0, Math.min(1, Number(sampleRateValue ?? env.REQUEST_LOG_SAMPLE_RATE ?? 0.01)))
  const sampled = Math.random() < sampleRate
  if (!sampled && !failover && !error && (!response || response.status < 500)) return
  const level = error || failover || (response && response.status >= 500) ? 'warning' : 'success'
  await env.DB.prepare('INSERT INTO events(event_type, hostname, pool_id, origin_id, status_code, duration_ms, level, message, cf_ray, sampled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(failover ? 'FAILOVER' : 'ROUTE', loadBalancer.hostname, candidate.pool.id, candidate.origin.id, response?.status ?? null, durationMs, level, error || (response ? String(response.status) : '请求失败'), request.headers.get('cf-ray'), sampled ? 1 : 0).run()
}

function unavailable(message: string) {
  return new Response(message, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '5' } })
}

async function handleTraffic(request: Request<unknown, IncomingRequestCfProperties>, env: Env, context: ExecutionContext) {
  context.passThroughOnException()
  const snapshot: ConfigSnapshot | null = await getSnapshot(env)
  if (!snapshot) throw new Error('尚未发布活动配置')
  const hostname = (env.ENVIRONMENT === 'development' ? request.headers.get('x-worker-lb-test-host') : null) ?? new URL(request.url).hostname.toLowerCase()
  const loadBalancer = snapshot.loadBalancers[hostname]
  if (!loadBalancer) throw new Error(`活动配置中不存在 ${hostname}`)

  const candidates = candidatesForLoadBalancer(snapshot, loadBalancer)
  if (!candidates.length) return unavailable('当前没有可用源站')
  const sticky = loadBalancer.sessionAffinity ? await affinityOrigin(request, candidates, env.AFFINITY_SECRET) : undefined
  const first = sticky ?? chooseCandidate(request, loadBalancer, candidates)
  if (!first) return unavailable('当前没有可用源站')

  const started = Date.now()
  let firstResponse: Response | null = null
  let firstError: string | undefined
  try {
    firstResponse = await fetch(originRequest(request.clone(), first.origin, loadBalancer))
  } catch (error) {
    firstError = error instanceof Error ? error.message : '源站连接失败'
  }

  const canRetry = request.method === 'GET' || request.method === 'HEAD'
  let selected = first
  let response = firstResponse
  let failedOver = false
  if (canRetry && (!firstResponse || retryable(firstResponse))) {
    const alternatives = candidatesForLoadBalancer(snapshot, loadBalancer, new Set([first.origin.id]))
    const second = chooseCandidate(request, loadBalancer, alternatives)
    if (second) {
      try {
        const secondResponse = await fetch(originRequest(request.clone(), second.origin, loadBalancer))
        selected = second
        response = secondResponse
        failedOver = true
      } catch {
        response = firstResponse
      }
    }
  }

  const durationMs = Date.now() - started
  if (!response) {
    context.waitUntil(recordRequest(env, request, loadBalancer, first, null, durationMs, failedOver, snapshot.requestLogSampleRate, firstError))
    return unavailable('所有源站连接失败')
  }

  context.waitUntil(recordRequest(env, request, loadBalancer, selected, response, durationMs, failedOver, snapshot.requestLogSampleRate, firstError))
  const headers = new Headers(response.headers)
  headers.set('server-timing', `worker-lb;dur=${durationMs}`)
  headers.set('x-worker-lb-version', String(snapshot.version))
  if (loadBalancer.sessionAffinity && env.AFFINITY_SECRET) {
    const value = await signAffinity(selected.origin.id, env.AFFINITY_SECRET)
    headers.append('set-cookie', `__wlb=${value}; Path=/; Max-Age=${loadBalancer.affinityTtlSeconds}; HttpOnly; Secure; SameSite=Lax`)
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers, webSocket: response.webSocket })
}

export default {
  fetch(request: Request<unknown, IncomingRequestCfProperties>, env: Env, context: ExecutionContext) {
    return handleTraffic(request, env, context)
  },
} satisfies ExportedHandler<Env>
