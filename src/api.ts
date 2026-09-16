import type { CloudflareConnection, Endpoint, LoadBalancer, LogEntry, Monitor, Pool } from './types'

const tokenKey = 'worker-lb-admin-token'

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export function setAdminToken(token: string) {
  if (token) sessionStorage.setItem(tokenKey, token)
  else sessionStorage.removeItem(tokenKey)
}

export interface ControlState {
  origins: Endpoint[]
  monitors: Monitor[]
  pools: Pool[]
  loadBalancers: LoadBalancer[]
  logs: LogEntry[]
  analytics: {
    traffic: Array<{ time: string; requests: number; ttfb: number }>
    sampleRate: number
    failovers: number
  }
  meta: {
    connected: boolean
    publishedVersion: number | null
    publishedAt: string | null
    cloudflare: CloudflareConnection
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body) headers.set('content-type', 'application/json')
  const token = sessionStorage.getItem(tokenKey)
  if (token) headers.set('authorization', `Bearer ${token}`)
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() as { error?: string } & T : undefined
  if (!response.ok) throw new ApiError(body?.error || `请求失败（${response.status}）`, response.status)
  return body as T
}

export function getControlState() {
  return apiRequest<ControlState>('/api/state')
}
