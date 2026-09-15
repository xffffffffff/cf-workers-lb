import { connect } from 'cloudflare:sockets'
import type { SnapshotMonitor, SnapshotOrigin } from './model'

export interface ProbeResult {
  ok: boolean
  statusCode: number | null
  latencyMs: number
  error: string | null
}

function expectedStatus(expression: string, status: number) {
  const normalized = expression.replaceAll('–', '-').replaceAll('—', '-').trim()
  return normalized.split(',').some((part) => {
    const [start, end] = part.trim().split('-').map(Number)
    if (!Number.isFinite(start)) return false
    return Number.isFinite(end) ? status >= start && status <= end : status === start
  })
}

async function probeTcp(origin: SnapshotOrigin, monitor: SnapshotMonitor): Promise<ProbeResult> {
  const started = Date.now()
  const parsed = new URL(`tcp://${origin.address}`)
  const portFromPath = Number(monitor.path)
  const port = parsed.port ? Number(parsed.port) : Number.isInteger(portFromPath) && portFromPath > 0 ? portFromPath : 443
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  let socket: Socket | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    socket = connect({ hostname, port })
    await Promise.race([
      socket.opened,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('连接超时')), monitor.timeoutSeconds * 1000) }),
    ])
    return { ok: true, statusCode: null, latencyMs: Date.now() - started, error: null }
  } catch (error) {
    return { ok: false, statusCode: null, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : 'TCP 检查失败' }
  } finally {
    if (timeout) clearTimeout(timeout)
    try { await socket?.close() } catch { /* Socket may already be closed. */ }
  }
}

export async function probeOrigin(origin: SnapshotOrigin, monitor: SnapshotMonitor): Promise<ProbeResult> {
  if (monitor.type === 'TCP') return probeTcp(origin, monitor)

  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('健康检查超时'), monitor.timeoutSeconds * 1000)
  try {
    const protocol = monitor.type === 'HTTPS' ? 'https:' : 'http:'
    const path = monitor.path.startsWith('/') ? monitor.path : `/${monitor.path}`
    const response = await fetch(`${protocol}//${origin.address}${path}`, {
      method: 'GET',
      headers: { 'User-Agent': 'Worker-LB-Health/1.0', ...monitor.headers },
      redirect: monitor.followRedirects ? 'follow' : 'manual',
      signal: controller.signal,
    })
    const latencyMs = Date.now() - started
    return { ok: expectedStatus(monitor.expectedCodes, response.status), statusCode: response.status, latencyMs, error: expectedStatus(monitor.expectedCodes, response.status) ? null : `状态码 ${response.status} 不符合 ${monitor.expectedCodes}` }
  } catch (error) {
    return { ok: false, statusCode: null, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : 'HTTP 检查失败' }
  } finally {
    clearTimeout(timer)
  }
}
