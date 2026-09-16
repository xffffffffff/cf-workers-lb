import { create } from 'zustand'
import { apiRequest, ApiError, getControlState, setAdminToken, type ControlState } from './api'
import { seedEndpoints, seedLoadBalancers, seedLogs, seedMonitors, seedPools, trafficData } from './data'
import type { CloudflareConnection, Endpoint, LoadBalancer, LogEntry, Monitor, Pool, ViewId } from './types'

type BackendState = 'loading' | 'connected' | 'unauthorized' | 'demo'
export type ResourceKind = 'load-balancers' | 'monitors' | 'pools' | 'origins'

interface ControlPlaneState {
  activeView: ViewId
  theme: 'light' | 'dark'
  sidebarOpen: boolean
  backend: BackendState
  publishedVersion: number | null
  cloudflare: CloudflareConnection
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
  addMonitor: (monitor: Monitor) => Promise<void>
  addPool: (pool: Pool) => Promise<void>
  addLoadBalancer: (loadBalancer: LoadBalancer) => Promise<void>
  togglePool: (id: string) => Promise<void>
  toggleEndpointHealth: (id: string) => Promise<void>
  testMonitor: (monitorId: string) => Promise<{ ok: boolean; latencyMs: number }>
  saveCloudflareToken: (token: string) => Promise<{ zoneCount: number }>
  testCloudflareToken: () => Promise<{ zoneCount: number; zones: string[] }>
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
    cloudflare: state.meta.cloudflare,
    backend: 'connected' as const,
  }
}

function eventEntry(event: LogEntry['event'], origin: string, result: string, level: LogEntry['level']): LogEntry {
  return { id: `log-${Date.now()}`, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), event, hostname: '全部站点', origin, result, duration: '—', level }
}

export const useControlPlane = create<ControlPlaneState>((set, get) => ({
  activeView: 'dashboard',
  theme: 'light',
  sidebarOpen: false,
  backend: 'loading',
  publishedVersion: null,
  cloudflare: { configured: false, tokenHint: null, verifiedAt: null },
  endpoints: seedEndpoints,
  monitors: seedMonitors,
  pools: seedPools,
  loadBalancers: seedLoadBalancers,
  logs: seedLogs,
  traffic: trafficData,
  failovers: 7,
  setActiveView: (activeView) => set({ activeView, sidebarOpen: false }),
  toggleTheme: () => set((state) => ({ theme: state.theme === 'light' ? 'dark' : 'light' })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  hydrate: async () => {
    try { set(remotePayload(await getControlState())) } catch (error) { set({ backend: error instanceof ApiError && error.status === 401 ? 'unauthorized' : 'demo' }) }
  },
  connect: async (token) => {
    setAdminToken(token.trim())
    try { set(remotePayload(await getControlState())) } catch (error) {
      setAdminToken('')
      set({ backend: error instanceof ApiError && error.status === 401 ? 'unauthorized' : 'demo' })
      throw error
    }
  },
  refresh: async () => {
    if (get().backend !== 'connected') return
    set(remotePayload(await getControlState()))
  },
  publish: async () => {
    if (get().backend !== 'connected') {
      await new Promise((resolve) => window.setTimeout(resolve, 650))
      return 0
    }
    const result = await apiRequest<{ version: number }>('/api/publish', { method: 'POST', body: '{}' })
    await get().refresh()
    return result.version
  },
  addEndpoint: async (endpoint) => {
    if (get().backend === 'connected') {
      const [latitude, longitude] = endpoint.coordinates.split(',').map(Number)
      await apiRequest('/api/origins', { method: 'POST', body: JSON.stringify({ name: endpoint.name, address: endpoint.address, region: endpoint.region, latitude, longitude, weight: endpoint.weight }) })
      await get().refresh()
      return
    }
    set((state) => ({ endpoints: [endpoint, ...state.endpoints], logs: [eventEntry('CONFIG', endpoint.name, '源站已添加', 'neutral'), ...state.logs] }))
  },
  addMonitor: async (monitor) => {
    if (get().backend === 'connected') {
      await apiRequest('/api/monitors', { method: 'POST', body: JSON.stringify(monitor) })
      await get().refresh()
      return
    }
    set((state) => ({ monitors: [monitor, ...state.monitors] }))
  },
  addPool: async (pool) => {
    if (get().backend === 'connected') {
      await apiRequest('/api/pools', { method: 'POST', body: JSON.stringify(pool) })
      await get().refresh()
      return
    }
    set((state) => ({ pools: [pool, ...state.pools] }))
  },
  addLoadBalancer: async (loadBalancer) => {
    if (get().backend === 'connected') {
      const steering = { 邻近感知: 'proximity', 动态延迟: 'latency', 随机: 'random', 故障转移: 'failover' }[loadBalancer.steering]
      await apiRequest('/api/load-balancers', { method: 'POST', body: JSON.stringify({ ...loadBalancer, steering, pools: loadBalancer.pools }) })
      await get().refresh()
      return
    }
    set((state) => ({ loadBalancers: [loadBalancer, ...state.loadBalancers] }))
  },
  togglePool: async (id) => {
    const pool = get().pools.find((item) => item.id === id)
    if (!pool) return
    if (get().backend === 'connected') {
      await apiRequest(`/api/pools/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !pool.enabled }) })
      await get().refresh()
      return
    }
    set((state) => ({ pools: state.pools.map((item) => item.id === id ? { ...item, enabled: !item.enabled } : item) }))
  },
  toggleEndpointHealth: async (id) => {
    const endpoint = get().endpoints.find((item) => item.id === id)
    if (!endpoint) return
    const nextState = endpoint.state === 'unhealthy' ? 'healthy' : 'unhealthy'
    if (get().backend === 'connected') {
      await apiRequest(`/api/origins/${encodeURIComponent(id)}/health`, { method: 'POST', body: JSON.stringify({ state: nextState }) })
      await get().refresh()
      return
    }
    set((state) => ({
      endpoints: state.endpoints.map((item) => item.id === id ? { ...item, state: nextState } : item),
      logs: [eventEntry('HEALTH', endpoint.name, nextState === 'healthy' ? '已恢复' : '已移出', nextState === 'healthy' ? 'success' : 'warning'), ...state.logs],
    }))
  },
  testMonitor: async (monitorId) => {
    const origin = get().endpoints.find((item) => item.enabled !== false)
    if (!origin) throw new Error('请先添加一个源站')
    if (get().backend !== 'connected') {
      await new Promise((resolve) => window.setTimeout(resolve, 350))
      return { ok: true, latencyMs: origin.latency }
    }
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
  removeCloudflareToken: async () => {
    if (get().backend !== 'connected') throw new Error('请先连接已部署的管理控制面')
    await apiRequest('/api/cloudflare/token', { method: 'DELETE' })
    await get().refresh()
  },
  deleteResource: async (kind, id) => {
    if (get().backend === 'connected') {
      await apiRequest(`/api/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await get().refresh()
      return
    }
    if (kind === 'origins' && get().pools.some((pool) => pool.origins.includes(id))) throw new Error('该源站仍被池引用，请先从池中移除')
    if (kind === 'monitors' && get().pools.some((pool) => pool.monitor === id)) throw new Error('该监视器仍被池引用，请先修改或删除相关池')
    if (kind === 'pools' && get().loadBalancers.some((item) => item.pools.includes(id))) throw new Error('该池仍被负载平衡器引用，请先修改或删除相关负载平衡器')
    set((state) => ({
      endpoints: kind === 'origins' ? state.endpoints.filter((item) => item.id !== id) : state.endpoints,
      monitors: kind === 'monitors' ? state.monitors.filter((item) => item.id !== id) : state.monitors,
      pools: kind === 'pools' ? state.pools.filter((item) => item.id !== id) : state.pools,
      loadBalancers: kind === 'load-balancers' ? state.loadBalancers.filter((item) => item.id !== id) : state.loadBalancers,
    }))
  },
}))
