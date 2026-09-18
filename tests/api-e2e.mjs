import assert from 'node:assert/strict'

const baseUrl = process.env.WORKER_LB_TEST_URL ?? 'http://127.0.0.1:8787'
const suffix = Date.now().toString(36)

async function request(path, options = {}, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  })
  const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null
  assert.equal(response.status, expectedStatus, `${options.method ?? 'GET'} ${path}: ${JSON.stringify(body)}`)
  return body
}

const service = await request('/api/health')
assert.equal(service.ok, true)

const testCloudflareToken = `test_cf_token_${suffix}_0123456789abcdef`
const cloudflare = await request('/api/cloudflare/token', {
  method: 'PUT',
  body: JSON.stringify({ token: testCloudflareToken }),
})
assert.equal(cloudflare.configured, true)
assert.equal(cloudflare.zoneCount, 1)
const cloudflareTest = await request('/api/cloudflare/test', { method: 'POST', body: '{}' })
assert.equal(cloudflareTest.ok, true)

const origin = await request('/api/origins', {
  method: 'POST',
  body: JSON.stringify({ name: `Test VPS ${suffix}`, address: `origin-${suffix}.example.net`, connectionHost: `connect-${suffix}.example.net`, region: 'Test Region', latitude: 40.7, longitude: -74, weight: 50 }),
}, 201)

const stateWithDefault = await request('/api/state')
const reachability = stateWithDefault.monitors.find((item) => item.id === 'monitor_reachability')
assert.ok(reachability, '应自动提供源站可达性监视器')
assert.equal(reachability.expected, '*')
assert.equal(reachability.path, '/')

const autoPool = await request('/api/pools', {
  method: 'POST',
  body: JSON.stringify({ name: `Auto Pool ${suffix}`, description: 'default reachability monitor', origins: [origin.id] }),
}, 201)
const stateAfterAutoPool = await request('/api/state')
assert.equal(stateAfterAutoPool.pools.find((item) => item.id === autoPool.id).monitor, 'monitor_reachability')
await request(`/api/pools/${autoPool.id}`, { method: 'DELETE' }, 204)
const protectedMonitor = await request('/api/monitors/monitor_reachability', { method: 'DELETE' }, 409)
assert.equal(protectedMonitor.code, 'RESOURCE_PROTECTED')

const simpleMonitor = await request('/api/monitors', {
  method: 'POST',
  body: JSON.stringify({ name: `Simple Monitor ${suffix}`, type: 'HTTP' }),
}, 201)
const savedSimple = (await request('/api/state')).monitors.find((item) => item.id === simpleMonitor.id)
assert.equal(savedSimple.path, '/')
assert.equal(savedSimple.expected, '*')
assert.equal(savedSimple.consecutiveSuccesses, 1)
await request(`/api/monitors/${simpleMonitor.id}`, { method: 'DELETE' }, 204)

const monitor = await request('/api/monitors', {
  method: 'POST',
  body: JSON.stringify({ name: `Test Monitor ${suffix}`, type: 'HTTPS', method: 'GET', path: '/healthz', port: 443, interval: 60, timeout: 3, expected: '200-299', consecutiveFails: 3, consecutiveSuccesses: 1, headers: { Host: `health-${suffix}.example.net`, 'X-Health-Check': 'worker-lb' }, followRedirects: false }),
}, 201)

await request(`/api/monitors/${monitor.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ headers: { Host: `updated-${suffix}.example.net` }, port: null, followRedirects: true }),
})

const pool = await request('/api/pools', {
  method: 'POST',
  body: JSON.stringify({ name: `Test Pool ${suffix}`, description: 'API integration test', monitor: monitor.id, origins: [origin.id] }),
}, 201)

const adminDomainConflict = await request('/api/load-balancers', {
  method: 'POST',
  body: JSON.stringify({ hostname: 'admin.example.com', site: 'Invalid Admin Domain', steering: 'proximity', sessionAffinity: true, pools: [pool.id] }),
}, 400)
assert.match(adminDomainConflict.error, /管理界面域名/)

const loadBalancer = await request('/api/load-balancers', {
  method: 'POST',
  body: JSON.stringify({ hostname: `test-${suffix}.example.com`, originHost: `backend-${suffix}.example.net`, site: 'Integration Test', steering: 'proximity', sessionAffinity: true, pools: [pool.id] }),
}, 201)

const state = await request('/api/state')
assert.equal(state.meta.cloudflare.configured, true)
assert.ok(!JSON.stringify(state).includes(testCloudflareToken), '控制状态不得包含 Cloudflare Token 明文')
assert.ok(state.origins.some((item) => item.id === origin.id))
assert.equal(state.origins.find((item) => item.id === origin.id).connectionHost, `connect-${suffix}.example.net`)
assert.ok(state.monitors.some((item) => item.id === monitor.id))
const savedMonitor = state.monitors.find((item) => item.id === monitor.id)
assert.equal(savedMonitor.headers.Host, `updated-${suffix}.example.net`)
assert.equal(savedMonitor.port, null)
assert.equal(savedMonitor.followRedirects, true)
assert.ok(state.pools.some((item) => item.id === pool.id))
const savedLoadBalancer = state.loadBalancers.find((item) => item.id === loadBalancer.id)
assert.ok(savedLoadBalancer)
assert.equal(savedLoadBalancer.originHost, `backend-${suffix}.example.net`)
assert.equal(savedLoadBalancer.domain.zone, 'example.com')
assert.equal(savedLoadBalancer.domain.routePattern, `test-${suffix}.example.com/*`)
assert.equal(savedLoadBalancer.domain.routeManaged, true)
assert.equal(savedLoadBalancer.domain.dnsManaged, true)

const tokenDependency = await request('/api/cloudflare/token', { method: 'DELETE' }, 409)
assert.match(tokenDependency.error, /已接入域名/)

const originDependency = await request(`/api/origins/${origin.id}`, { method: 'DELETE' }, 409)
assert.equal(originDependency.code, 'RESOURCE_IN_USE')
const poolDependency = await request(`/api/pools/${pool.id}`, { method: 'DELETE' }, 409)
assert.equal(poolDependency.code, 'RESOURCE_IN_USE')

const invalidPublish = await request('/api/publish', { method: 'POST', body: '{}' }, 422)
assert.equal(invalidPublish.error, '配置验证失败')
assert.ok(invalidPublish.details.some((item) => item.includes('健康源站')))

await request(`/api/load-balancers/${loadBalancer.id}`, { method: 'DELETE' }, 204)
await request(`/api/pools/${pool.id}`, { method: 'DELETE' }, 204)
await request(`/api/monitors/${monitor.id}`, { method: 'DELETE' }, 204)
await request(`/api/origins/${origin.id}`, { method: 'DELETE' }, 204)

const finalState = await request('/api/state')
assert.ok(!finalState.origins.some((item) => item.id === origin.id))
assert.ok(!finalState.loadBalancers.some((item) => item.id === loadBalancer.id))

await request('/api/cloudflare/token', { method: 'DELETE' }, 204)

console.log('Worker LB API integration test passed')
