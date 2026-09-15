export type ViewId = 'dashboard' | 'load-balancers' | 'monitors' | 'pools' | 'origins' | 'logs' | 'settings'

export type HealthState = 'healthy' | 'degraded' | 'unhealthy'

export interface Endpoint {
  id: string
  name: string
  address: string
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
  path: string
  interval: number
  timeout: number
  expected: string
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
