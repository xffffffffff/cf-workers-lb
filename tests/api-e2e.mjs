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
  body: JSON.stringify({ name: `Test VPS ${suffix}`, address: `origin-${suffix}.example.net`, region: 'Test Region', latitude: 40.7, longitude: -74, weight: 50 }),
}, 201)

const monitor = await request('/api/monitors', {
  method: 'POST',
  body: JSON.stringify({ name: `Test Monitor ${suffix}`, type: 'HTTPS', path: '/healthz', interval: 60, timeout: 3, expected: '200-299' }),
}, 201)

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
  body: JSON.stringify({ hostname: `test-${suffix}.example.com`, site: 'Integration Test', steering: 'proximity', sessionAffinity: true, pools: [pool.id] }),
}, 201)

const state = await request('/api/state')
assert.equal(state.meta.cloudflare.configured, true)
assert.ok(!JSON.stringify(state).includes(testCloudflareToken), '控制状态不得包含 Cloudflare Token 明文')
assert.ok(state.origins.some((item) => item.id === origin.id))
assert.ok(state.monitors.some((item) => item.id === monitor.id))
assert.ok(state.pools.some((item) => item.id === pool.id))
const savedLoadBalancer = state.loadBalancers.find((item) => item.id === loadBalancer.id)
assert.ok(savedLoadBalancer)
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
