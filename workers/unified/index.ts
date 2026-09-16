import controlWorker from '../control'
import { runHealthChecks } from '../health'
import trafficWorker from '../traffic'

interface Env {
  DB: D1Database
  CONFIG_KV: KVNamespace
  ASSETS: Fetcher
  AFFINITY_SECRET: string
  TOKEN_ENCRYPTION_KEY?: string
  ADMIN_TOKEN?: string
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  ADMIN_HOSTS?: string
  WORKER_NAME?: string
  CONFIG_CACHE_SECONDS?: string
  REQUEST_LOG_SAMPLE_RATE?: string
  ENVIRONMENT?: string
}

function isAdminHost(request: Request, env: Env) {
  if (env.ENVIRONMENT === 'development') return request.headers.get('x-worker-lb-test-mode') !== 'traffic'
  const hostname = new URL(request.url).hostname.toLowerCase()
  const configured = String(env.ADMIN_HOSTS ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
  return hostname.endsWith('.workers.dev') || configured.includes(hostname)
}

export default {
  async fetch(request: Request<unknown, IncomingRequestCfProperties>, env: Env, context: ExecutionContext) {
    const url = new URL(request.url)
    if (env.ENVIRONMENT === 'development' && request.method === 'POST' && url.pathname === '/__health/run') {
      return new Response(JSON.stringify(await runHealthChecks(env)), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
    }
    if (isAdminHost(request, env)) return controlWorker.fetch(request, env)
    return trafficWorker.fetch(request, env, context)
  },
  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext) {
    context.waitUntil(runHealthChecks(env))
  },
} satisfies ExportedHandler<Env>
