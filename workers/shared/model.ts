export type HealthState = 'healthy' | 'unhealthy' | 'unknown'
export type SteeringPolicy = 'proximity' | 'latency' | 'random' | 'failover'

export interface SnapshotOrigin {
  id: string
  name: string
  address: string
  region: string
  latitude: number
  longitude: number
  weight: number
}

export interface SnapshotMonitor {
  id: string
  name: string
  type: 'HTTP' | 'HTTPS' | 'TCP'
  path: string
  intervalSeconds: number
  timeoutSeconds: number
  expectedCodes: string
  consecutiveFails: number
  consecutiveSuccesses: number
  headers: Record<string, string>
  followRedirects: boolean
}

export interface SnapshotPoolOrigin {
  originId: string
  priority: number
  weight: number
}

export interface SnapshotPool {
  id: string
  name: string
  monitorId: string
  minimumHealthy: number
  origins: SnapshotPoolOrigin[]
}

export interface SnapshotLoadBalancer {
  id: string
  hostname: string
  site: string
  steering: SteeringPolicy
  sessionAffinity: boolean
  affinityTtlSeconds: number
  proximityBuffer: number
  pools: Array<{ poolId: string; priority: number }>
}

export interface SnapshotHealth {
  state: HealthState
  lastCheckedAt: string | null
  lastLatencyMs: number | null
}

export interface ConfigSnapshot {
  schemaVersion: 1
  version: number
  publishedAt: string
  requestLogSampleRate?: number
  origins: Record<string, SnapshotOrigin>
  monitors: Record<string, SnapshotMonitor>
  pools: Record<string, SnapshotPool>
  loadBalancers: Record<string, SnapshotLoadBalancer>
  health: Record<string, SnapshotHealth>
}

export const ACTIVE_SNAPSHOT_KEY = 'config:active'

export function healthKey(poolId: string, originId: string) {
  return `${poolId}:${originId}`
}

export function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

export function normalizeHostname(value: unknown) {
  const hostname = String(value ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!hostname || hostname.length > 253 || hostname.includes('://') || hostname.includes('/') || hostname.includes(':')) {
    throw new Error('主机名格式无效')
  }
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
    throw new Error('主机名格式无效')
  }
  return hostname
}

export function normalizeOriginAddress(value: unknown) {
  const address = String(value ?? '').trim().toLowerCase()
  if (!address || address.length > 255 || address.includes('://') || /[/?#@\s]/.test(address)) {
    throw new Error('源站地址应为 IP、主机名，或带端口的地址')
  }
  if (!/^[a-z0-9.:[\]-]+$/.test(address)) {
    throw new Error('源站地址包含不支持的字符')
  }
  try {
    new URL(`https://${address}`)
  } catch {
    throw new Error('源站地址格式无效')
  }
  return address
}

export function numberInRange(value: unknown, min: number, max: number, label: string) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${label}必须在 ${min}–${max} 之间`)
  return parsed
}

export function integerInRange(value: unknown, min: number, max: number, label: string) {
  const parsed = numberInRange(value, min, max, label)
  if (!Number.isInteger(parsed)) throw new Error(`${label}必须是整数`)
  return parsed
}

export function requiredText(value: unknown, label: string, max = 120) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${label}不能为空`)
  if (text.length > max) throw new Error(`${label}不能超过 ${max} 个字符`)
  return text
}

export function parseHeaders(value: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]))
  } catch {
    return {}
  }
}
