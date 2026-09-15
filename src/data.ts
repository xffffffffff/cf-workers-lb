import type { Endpoint, LoadBalancer, LogEntry, Monitor, Pool } from './types'

export const trafficData = [
  { time: '00:00', requests: 860, ttfb: 204 },
  { time: '02:00', requests: 640, ttfb: 196 },
  { time: '04:00', requests: 520, ttfb: 188 },
  { time: '06:00', requests: 780, ttfb: 191 },
  { time: '08:00', requests: 1480, ttfb: 184 },
  { time: '10:00', requests: 1940, ttfb: 179 },
  { time: '12:00', requests: 2250, ttfb: 176 },
  { time: '14:00', requests: 2480, ttfb: 182 },
  { time: '16:00', requests: 2310, ttfb: 173 },
  { time: '18:00', requests: 2130, ttfb: 169 },
  { time: '20:00', requests: 1850, ttfb: 174 },
  { time: '22:00', requests: 1320, ttfb: 181 },
]

export const requestSplit = [
  { name: '生产官网', value: 32 },
  { name: '公共 API', value: 28 },
  { name: '商城', value: 21 },
  { name: '管理后台', value: 11 },
  { name: '文件站', value: 8 },
]

export const seedEndpoints: Endpoint[] = [
  {
    id: 'origin-phx',
    name: 'Phoenix · VPS 1',
    address: 'origin-a.internal.example',
    region: 'US West',
    coordinates: '33.4484, -112.0740',
    latency: 94,
    weight: 50,
    state: 'healthy',
  },
  {
    id: 'origin-iad',
    name: 'Ashburn · VPS 2',
    address: 'origin-b.internal.example',
    region: 'US East',
    coordinates: '39.0438, -77.4874',
    latency: 71,
    weight: 50,
    state: 'healthy',
  },
]

export const seedMonitors: Monitor[] = [
  { id: 'mon-web', name: 'HTTPS · Web 健康检查', type: 'HTTPS', path: '/healthz', interval: 60, timeout: 5, expected: '200–299', pools: 2, state: 'healthy' },
  { id: 'mon-api', name: 'HTTPS · API 深度检查', type: 'HTTPS', path: '/api/health', interval: 60, timeout: 3, expected: '200', pools: 1, state: 'healthy' },
  { id: 'mon-admin', name: 'TCP · 管理端口', type: 'TCP', path: '443', interval: 120, timeout: 5, expected: '连接成功', pools: 1, state: 'healthy' },
]

export const seedPools: Pool[] = [
  { id: 'pool-primary', name: '生产主池', description: '承载官网、商城和 API 的主要流量', monitor: 'mon-web', origins: ['origin-phx', 'origin-iad'], enabled: true },
  { id: 'pool-api', name: 'API 池', description: '针对 API 路径使用更严格的健康检查', monitor: 'mon-api', origins: ['origin-phx', 'origin-iad'], enabled: true },
  { id: 'pool-admin', name: '后台池', description: '管理后台与内部工具', monitor: 'mon-admin', origins: ['origin-phx', 'origin-iad'], enabled: true },
]

export const seedLoadBalancers: LoadBalancer[] = [
  { id: 'lb-www', hostname: 'www.windx.example', site: '生产官网', pools: ['pool-primary'], steering: '邻近感知', sessionAffinity: true, state: 'healthy', ttfb: 182, requests: 32481 },
  { id: 'lb-shop', hostname: 'shop.windx.example', site: '商城', pools: ['pool-primary'], steering: '动态延迟', sessionAffinity: true, state: 'degraded', ttfb: 214, requests: 18903 },
  { id: 'lb-api', hostname: 'api.windx.example', site: '公共 API', pools: ['pool-api'], steering: '邻近感知', sessionAffinity: false, state: 'healthy', ttfb: 146, requests: 44210 },
  { id: 'lb-admin', hostname: 'admin.windx.example', site: '管理后台', pools: ['pool-admin'], steering: '故障转移', sessionAffinity: true, state: 'healthy', ttfb: 191, requests: 5762 },
]

export const seedLogs: LogEntry[] = [
  { id: 'log-1', time: '14:31:48', event: 'ROUTE', hostname: 'api.windx.example', origin: 'Ashburn · VPS 2', result: '200', duration: '168 ms', level: 'success' },
  { id: 'log-2', time: '14:27:02', event: 'FAILOVER', hostname: 'shop.windx.example', origin: 'Phoenix → Ashburn', result: '已恢复', duration: '412 ms', level: 'warning' },
  { id: 'log-3', time: '14:25:00', event: 'HEALTH', hostname: '全部站点', origin: 'Phoenix · VPS 1', result: '10/10 通过', duration: '94 ms', level: 'success' },
  { id: 'log-4', time: '14:12:33', event: 'CONFIG', hostname: 'www.windx.example', origin: '生产主池', result: '配置已发布', duration: '—', level: 'neutral' },
  { id: 'log-5', time: '13:58:17', event: 'ROUTE', hostname: 'www.windx.example', origin: 'Phoenix · VPS 1', result: '200', duration: '179 ms', level: 'success' },
]
