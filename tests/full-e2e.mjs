import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const workerUrl = process.env.WORKER_LB_URL ?? 'http://127.0.0.1:8787'
const suffix = Date.now().toString(36)
const hostname = `full-${suffix}.example.com`

function originServer(name, port) {
  const state = { fail: false }
  const server = createServer((request, response) => {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('healthy')
      return
    }
    response.writeHead(state.fail ? 503 : 200, { 'content-type': 'text/plain', 'x-test-origin': name })
    response.end(state.fail ? `${name}-failed` : `${name}-ok`)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve({ server, state, name }))
  })
}

async function api(path, options = {}, expectedStatus = 200) {
  const response = await fetch(`${workerUrl}${path}`, { ...options, headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers })
  const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null
  assert.equal(response.status, expectedStatus, `${options.method ?? 'GET'} ${path}: ${JSON.stringify(body)}`)
  return body
}

const origins = await Promise.all([originServer('alpha', 9081), originServer('beta', 9082)])
let originIds = []
let monitorId
let poolId
let loadBalancerId

try {
  for (const [index, port] of [9081, 9082].entries()) {
    const result = await api('/api/origins', { method: 'POST', body: JSON.stringify({ name: `Full ${origins[index].name} ${suffix}`, address: `127.0.0.1:${port}`, region: 'Local', latitude: 40 + index, longitude: -74 + index, weight: 50 }) }, 201)
    originIds.push(result.id)
  }
  monitorId = (await api('/api/monitors', { method: 'POST', body: JSON.stringify({ name: `Full Monitor ${suffix}`, type: 'HTTP', path: '/healthz', interval: 60, timeout: 3, expected: '200-299', consecutiveSuccesses: 1 }) }, 201)).id
  poolId = (await api('/api/pools', { method: 'POST', body: JSON.stringify({ name: `Full Pool ${suffix}`, monitor: monitorId, origins: originIds }) }, 201)).id
  loadBalancerId = (await api('/api/load-balancers', { method: 'POST', body: JSON.stringify({ hostname, site: 'Full E2E', steering: 'random', sessionAffinity: true, pools: [poolId] }) }, 201)).id

  const healthResponse = await fetch(`${workerUrl}/__health/run`, { method: 'POST' })
  assert.equal(healthResponse.status, 200)
  const health = await healthResponse.json()
  assert.equal(health.checked, 2)
  assert.equal(health.passed, 2)

  const published = await api('/api/publish', { method: 'POST', body: '{}' })
  assert.ok(published.version > 0)

  const first = await fetch(`${workerUrl}/resource`, { headers: { 'x-worker-lb-test-mode': 'traffic', 'x-worker-lb-test-host': hostname } })
  assert.equal(first.status, 200)
  const selectedName = first.headers.get('x-test-origin')
  assert.ok(selectedName === 'alpha' || selectedName === 'beta')
  const cookie = first.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie?.startsWith('__wlb='))

  const selected = origins.find((item) => item.name === selectedName)
  selected.state.fail = true
  const retried = await fetch(`${workerUrl}/resource`, { headers: { 'x-worker-lb-test-mode': 'traffic', 'x-worker-lb-test-host': hostname, cookie } })
  assert.equal(retried.status, 200)
  assert.notEqual(retried.headers.get('x-test-origin'), selectedName)

  const post = await fetch(`${workerUrl}/resource`, { method: 'POST', headers: { 'x-worker-lb-test-mode': 'traffic', 'x-worker-lb-test-host': hostname, cookie }, body: 'do-not-replay' })
  assert.equal(post.status, 503)

  console.log('Worker LB full health, publish, affinity, and failover test passed')
} finally {
  if (loadBalancerId) await api(`/api/load-balancers/${loadBalancerId}`, { method: 'DELETE' }, 204)
  if (poolId) await api(`/api/pools/${poolId}`, { method: 'DELETE' }, 204)
  if (monitorId) await api(`/api/monitors/${monitorId}`, { method: 'DELETE' }, 204)
  for (const id of originIds) await api(`/api/origins/${id}`, { method: 'DELETE' }, 204)
  await Promise.all(origins.map(({ server }) => new Promise((resolve) => server.close(resolve))))
}
