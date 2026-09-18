import { create } from 'zustand'
import { apiRequest, ApiError, getControlState, setAdminToken, type ControlState } from './api'
import type { CloudflareConnection, Endpoint, LoadBalancer, LogEntry, Monitor, Pool, ViewId } from './types'

type BackendState = 'loading' | 'connected' | 'unauthorized' | 'unavailable'
export type ResourceKind = 'load-balancers' | 'monitors' | 'pools' | 'origins'
type Theme = 'light' | 'dark'

interface ControlPlaneState {
  activeView: ViewId
  theme: Theme
  sidebarOpen: boolean
  backend: BackendState
  publishedVersion: number | null
  cloudflare: CloudflareConnection
  originDnsZone: string | null
  endpoints: Endpoint[]
  monitors: Monitor[]
  pools: Pool[]
  loadBalancers: LoadBalancer[]
  logs: LogEntry[]
  traffic: Array<{ time: string; requests: number; ttfb: number }>
  failovers: number
  setActiveView: (view: ViewId) => void
  toggleTheme: () => void
  setSidebarOpen: (open: boolean) => void
  hydrate: () => Promise<void>
  connect: (token: string) => Promise<void>
  refresh: () => Promise<void>
  publish: () => Promise<number>
  addEndpoint: (endpoint: Endpoint) => Promise<void>
  updateEndpoint: (endpoint: Endpoint) => Promise<void>
  addMonitor: (monitor: Monitor) => Promise<void>
  updateMonitor: (monitor: Monitor) => Promise<void>
  addPool: (pool: Pool) => Promise<void>
  addLoadBalancer: (loadBalancer: LoadBalancer) => Promise<void>
  togglePool: (id: string) => Promise<void>
  toggleEndpointHealth: (id: string) => Promise<void>
  testMonitor: (monitorId: string) => Promise<{ ok: boolean; latencyMs: number }>
  saveCloudflareToken: (token: string) => Promise<{ zoneCount: number }>
  testCloudflareToken: () => Promise<{ zoneCount: number; zones: string[] }>
  listCloudflareZones: () => Promise<string[]>
  saveOriginDnsZone: (zone: string) => Promise<{ zone: string; provisioned: Array<{ id: string; hostname: string }> }>
  removeCloudflareToken: () => Promise<void>
  deleteResource: (kind: ResourceKind, id: string) => Promise<void>
}

function remotePayload(state: ControlState) {
  return {
    endpoints: state.origins,
    monitors: state.monitors,
    pools: state.pools,
    loadBalancers: state.loadBalancers,
    logs: state.logs,
    traffic: state.analytics.traffic,
    failovers: state.analytics.failovers,
    publishedVersion: state.meta.publishedVersion,
    originDnsZone: state.meta.originDnsZone ?? null,
    cloudflare: state.meta.cloudflare,
    backend: 'connected' as const,
  }
}

function initialTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101113' : '#ffffff')
  try { localStorage.setItem('worker-lb-theme', theme) } catch { /* Storage may be unavailable in hardened browsers. */ }
}

function disconnectedState(backend: Extract<BackendState, 'unauthorized' | 'unavailable'>) {
  return {
    backend,
    publishedVersion: null,
    cloudflare: { configured: false, tokenHint: null, verifiedAt: null },
    originDnsZone: null,
    endpoints: [],
    monitors: [],
    pools: [],
    loadBalancers: [],
    logs: [],
    traffic: [],
    failovers: 0,
  }
}

function requireConnection(backend: BackendState) {
  if (backend !== 'connected') throw new Error('无法连接管理控制面，请刷新后重试')
}

export const useControlPlane = create<ControlPlaneState>((set, get) => ({
  activeView: 'dashboard',
  theme: initialTheme(),
  sidebarOpen: false,
  backend: 'loading',
  publishedVersion: null,
  cloudflare: { configured: false, tokenHint: null, verifiedAt: null },
  originDnsZone: null,
  endpoints: [],
  monitors: [],
  pools: [],
  loadBalancers: [],
  logs: [],
  traffic: [],
  failovers: 0,
  setActiveView: (activeView) => set({ activeView, sidebarOpen: false }),
  toggleTheme: () => set((state) => {
    const theme = state.theme === 'light' ? 'dark' : 'light'
    applyTheme(theme)
    return { theme }
  }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  hydrate: async () => {
    set({ backend: 'loading' })
    try { set(remotePayload(await getControlState())) } catch (error) {
      set(disconnectedState(error instanceof ApiError && error.status === 401 ? 'unauthorized' : 'unavailable'))
    }
  },
  connect: async (token) => {
    setAdminToken(token.trim())
    try { set(remotePayload(await getControlState())) } catch (error) {
      setAdminToken('')
      set(disconnectedState(error instanceof ApiError && error.status === 401 ? 'unauthorized' : 'unavailable'))
      throw error
    }
  },
  refresh: async () => {
    if (get().backend !== 'connected') return
    set(remotePayload(await getControlState()))
  },
  publish: async () => {
    requireConnection(get().backend)
    const result = await apiRequest<{ version: number }>('/api/publish', { method: 'POST', body: '{}' })
    await get().refresh()
    return result.version
  },
  addEndpoint: async (endpoint) => {
    requireConnection(get().backend)
    const [latitude, longitude] = endpoint.coordinates.split(',').map(Number)
    await apiRequest('/api/origins', { method: 'POST', body: JSON.stringify({ name: endpoint.name, address: endpoint.address, connectionHost: endpoint.connectionHost || undefined, region: endpoint.region, latitude, longitude, weight: endpoint.weight }) })
    await get().refresh()
  },
  updateEndpoint: async (endpoint) => {
    requireConnection(get().backend)
    const [latitude, longitude] = endpoint.coordinates.split(',').map(Number)
    await apiRequest(`/api/origins/${encodeURIComponent(endpoint.id)}`, { method: 'PATCH', body: JSON.stringify({ name: endpoint.name, address: endpoint.address, connectionHost: endpoint.connectionHost || undefined, region: endpoint.region, latitude, longitude, weight: endpoint.weight }) })
    await get().refresh()
  },
  addMonitor: async (monitor) => {
    requireConnection(get().backend)
    await apiRequest('/api/monitors', { method: 'POST', body: JSON.stringify(monitor) })
    await get().refresh()
  },
  updateMonitor: async (monitor) => {
    requireConnection(get().backend)
    await apiRequest(`/api/monitors/${encodeURIComponent(monitor.id)}`, { method: 'PATCH', body: JSON.stringify(monitor) })
    await get().refresh()
  },
  addPool: async (pool) => {
    requireConnection(get().backend)
    await apiRequest('/api/pools', { method: 'POST', body: JSON.stringify(pool) })
    await get().refresh()
  },
  addLoadBalancer: async (loadBalancer) => {
    requireConnection(get().backend)
    const steering = { 邻近感知: 'proximity', 动态延迟: 'latency', 随机: 'random', 故障转移: 'failover' }[loadBalancer.steering]
    await apiRequest('/api/load-balancers', { method: 'POST', body: JSON.stringify({ ...loadBalancer, steering, pools: loadBalancer.pools }) })
    await get().refresh()
  },
  togglePool: async (id) => {
    const pool = get().pools.find((item) => item.id === id)
    if (!pool) return
    requireConnection(get().backend)
    await apiRequest(`/api/pools/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !pool.enabled }) })
    await get().refresh()
  },
  toggleEndpointHealth: async (id) => {
    const endpoint = get().endpoints.find((item) => item.id === id)
    if (!endpoint) return
    const nextState = endpoint.state === 'unhealthy' ? 'healthy' : 'unhealthy'
    requireConnection(get().backend)
    await apiRequest(`/api/origins/${encodeURIComponent(id)}/health`, { method: 'POST', body: JSON.stringify({ state: nextState }) })
    await get().refresh()
  },
  testMonitor: async (monitorId) => {
    const origin = get().endpoints.find((item) => item.enabled !== false)
    if (!origin) throw new Error('请先添加一个源站')
    requireConnection(get().backend)
    return apiRequest('/api/monitors/test', { method: 'POST', body: JSON.stringify({ monitorId, originId: origin.id }) })
  },
  saveCloudflareToken: async (token) => {
    if (get().backend !== 'connected') throw new Error('请先连接已部署的管理控制面')
    const result = await apiRequest<{ zoneCount: number }>('/api/cloudflare/token', { method: 'PUT', body: JSON.stringify({ token }) })
    await get().refresh()
    return result
  },
  testCloudflareToken: async () => {
    if (get().backend !== 'connected') throw new Error('请先连接已部署的管理控制面')
    return apiRequest<{ zoneCount: number; zones: string[] }>('/api/cloudflare/test', { method: 'POST', body: '{}' })
  },
  listCloudflareZones: async () => {
    if (get().backend !== 'connected') throw new Error('请先连接已部署的管理控制面')
    return (await apiRequest<{ zones: string[] }>('/api/cloudflare/zones')).zones
  },
  saveOriginDnsZone: async (zone) => {
    requireConnection(get().backend)
    const result = await apiRequest<{ zone: string; provisioned: Array<{ id: string; hostname: string }> }>('/api/origin-dns-zone', { method: 'PUT', body: JSON.stringify({ zone }) })
    await get().refresh()
    return result
  },
  removeCloudflareToken: async () => {
    if (get().backend !== 'connected') throw new Error('请先连接已部署的管理控制面')
    await apiRequest('/api/cloudflare/token', { method: 'DELETE' })
    await get().refresh()
  },
  deleteResource: async (kind, id) => {
    requireConnection(get().backend)
    await apiRequest(`/api/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await get().refresh()
  },
}))
