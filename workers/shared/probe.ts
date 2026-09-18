import { connect } from 'cloudflare:sockets'
import { isAnyStatusExpected, isIpAddress, isPrivateOrLocalIp, ORIGIN_IP_REQUIRES_HOST, originConnectionHost, originHostname, type SnapshotMonitor, type SnapshotOrigin } from './model'

export interface ProbeResult {
  ok: boolean
  statusCode: number | null
  latencyMs: number
  error: string | null
}

export async function cloudflareErrorCode(response: Response) {
  if (response.status < 400 || response.status >= 500) return null
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/html') && !contentType.includes('text/plain')) return null
  const snippet = (await response.clone().text()).slice(0, 4000)
  return snippet.match(/error code:\s*(\d{4})/i)?.[1] ?? null
}

function expectedStatus(expression: string, status: number) {
  if (isAnyStatusExpected(expression)) return true
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
  const port = monitor.port ?? (parsed.port ? Number(parsed.port) : Number.isInteger(portFromPath) && portFromPath > 0 ? portFromPath : 443)
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
    const hostEntry = Object.entries(monitor.headers).find(([name]) => name.toLowerCase() === 'host')
    const host = hostEntry?.[1]?.trim()
    const ipOrigin = isIpAddress(originHostname(origin.address))
    const resolveOverride = host || ipOrigin ? originConnectionHost(origin) : null
    if ((host || (ipOrigin && !isPrivateOrLocalIp(originHostname(origin.address)))) && !resolveOverride) throw new Error(ORIGIN_IP_REQUIRES_HOST)
    const originTarget = new URL(`${protocol}//${origin.address}`)
    const requestHost = host || (ipOrigin && origin.connectionHost ? origin.connectionHost : origin.address)
    const target = new URL(`${protocol}//${requestHost}${path}`)
    if (monitor.port !== null) target.port = String(monitor.port)
    else if ((host || (ipOrigin && origin.connectionHost)) && originTarget.port) target.port = originTarget.port
    const headers = new Headers({ 'User-Agent': 'Worker-LB-Health/1.0', ...monitor.headers })
    if (hostEntry) headers.delete(hostEntry[0])
    const response = await fetch(target, {
      method: monitor.method,
      headers,
      redirect: monitor.followRedirects ? 'follow' : 'manual',
      signal: controller.signal,
      cf: resolveOverride ? { resolveOverride } : undefined,
    })
    const latencyMs = Date.now() - started
    const blocked = await cloudflareErrorCode(response)
    if (blocked) return { ok: false, statusCode: response.status, latencyMs, error: blocked === '1003' ? ORIGIN_IP_REQUIRES_HOST : `源站请求被 Cloudflare 拦截（${blocked}）` }
    return { ok: expectedStatus(monitor.expectedCodes, response.status), statusCode: response.status, latencyMs, error: expectedStatus(monitor.expectedCodes, response.status) ? null : `状态码 ${response.status} 不符合 ${monitor.expectedCodes}` }
  } catch (error) {
    return { ok: false, statusCode: null, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : 'HTTP 检查失败' }
  } finally {
    clearTimeout(timer)
  }
}
