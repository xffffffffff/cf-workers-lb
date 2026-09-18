export type ViewId = 'dashboard' | 'load-balancers' | 'monitors' | 'pools' | 'origins' | 'logs' | 'settings'

export type HealthState = 'healthy' | 'degraded' | 'unhealthy'

export const REACHABILITY_MONITOR_ID = 'monitor_reachability'

export function isReachabilityExpected(expected: string) {
  const normalized = expected.replaceAll('–', '-').replaceAll('—', '-').trim().toLowerCase()
  return normalized === '*' || normalized === 'any'
}

export interface Endpoint {
  id: string
  name: string
  address: string
  connectionHost?: string | null
  connectionZone?: string | null
  region: string
  coordinates: string
  latency: number
  weight: number
  state: HealthState
  enabled?: boolean
}

export interface Monitor {
  id: string
  name: string
  type: 'HTTPS' | 'HTTP' | 'TCP'
  method: 'GET' | 'HEAD'
  path: string
  port: number | null
  interval: number
  timeout: number
  expected: string
  consecutiveFails: number
  consecutiveSuccesses: number
  headers: Record<string, string>
  followRedirects: boolean
  pools: number
  state: HealthState
}

export interface Pool {
  id: string
  name: string
  description: string
  monitor: string
  origins: string[]
  enabled: boolean
  minimumHealthy?: number
}

export interface LoadBalancer {
  id: string
  hostname: string
  originHost?: string | null
  site: string
  pools: string[]
  steering: '邻近感知' | '动态延迟' | '随机' | '故障转移'
  sessionAffinity: boolean
  state: HealthState
  ttfb: number
  requests: number
  enabled?: boolean
  affinityTtlSeconds?: number
  proximityBuffer?: number
  failovers?: number
  domain?: {
    zone: string
    routePattern: string
    routeManaged: boolean
    dnsManaged: boolean
  } | null
}

export interface CloudflareConnection {
  configured: boolean
  tokenHint: string | null
  verifiedAt: string | null
}

export interface LogEntry {
  id: string
  time: string
  event: 'ROUTE' | 'HEALTH' | 'FAILOVER' | 'CONFIG'
  hostname: string
  origin: string
  result: string
  duration: string
  level: 'success' | 'warning' | 'neutral'
}
