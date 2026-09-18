import { Dialog } from '@base-ui/react/dialog'
import { cva } from 'class-variance-authority'
import clsx from 'clsx'
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Toaster, toast } from 'sonner'
import { Icon, type IconName } from './icons'
import { useControlPlane, type ResourceKind } from './store'
import { isReachabilityExpected, REACHABILITY_MONITOR_ID, type Endpoint, type HealthState, type LoadBalancer, type Monitor, type Pool, type ViewId } from './types'
import { worldLandPath } from './world-land'

const button = cva('button', {
  variants: {
    intent: {
      primary: 'button-primary',
      secondary: 'button-secondary',
      ghost: 'button-ghost',
      danger: 'button-danger',
    },
    compact: { true: 'button-compact' },
  },
  defaultVariants: { intent: 'secondary' },
})

const navItems: Array<{ id: ViewId; label: string; icon: IconName }> = [
  { id: 'dashboard', label: '仪表台', icon: 'dashboard' },
  { id: 'load-balancers', label: '负载平衡器', icon: 'globe' },
  { id: 'monitors', label: '监视器', icon: 'pulse' },
  { id: 'pools', label: '池', icon: 'layers' },
  { id: 'origins', label: '源站', icon: 'server' },
  { id: 'logs', label: '日志', icon: 'list' },
]

const titles: Record<ViewId, { title: string; eyebrow: string }> = {
  dashboard: { title: '负载平衡分析', eyebrow: '概览' },
  'load-balancers': { title: '负载平衡器', eyebrow: '流量管理' },
  monitors: { title: '监视器', eyebrow: '健康检查' },
  pools: { title: '池', eyebrow: '流量管理' },
  origins: { title: '源站', eyebrow: '基础设施' },
  logs: { title: '负载平衡日志', eyebrow: '可观测性' },
  settings: { title: '设置', eyebrow: '系统' },
}

const stateText: Record<HealthState, string> = {
  healthy: '健康',
  degraded: '已故障转移',
  unhealthy: '不健康',
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请稍后重试'
}

function addressLooksLikeIp(address: string) {
  try {
    const hostname = new URL(`https://${address.trim()}`).hostname.replace(/^\[|\]$/g, '')
    return hostname.includes(':') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)
  } catch {
    return false
  }
}

function nextOriginHost(zone: string, endpoints: Endpoint[], editingId?: string) {
  const domain = zone.trim().toLowerCase().replace(/\.$/, '')
  if (!domain) return ''
  const used = new Set(endpoints.filter((item) => item.id !== editingId && item.connectionHost).map((item) => String(item.connectionHost).toLowerCase()))
  let index = 1
  while (used.has(`origin-${index}.${domain}`)) index += 1
  return `origin-${index}.${domain}`
}

function projectOrigin(endpoint: Endpoint) {
  const [latitude, longitude] = endpoint.coordinates.split(',').map(Number)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  return { endpoint, x: longitude + 180, y: 90 - latitude }
}

function isSimpleMonitor(monitor: Monitor) {
  const extraHeaders = Object.keys(monitor.headers).filter((key) => key.toLowerCase() !== 'host')
  return isReachabilityExpected(monitor.expected)
    && monitor.method === 'GET'
    && (monitor.path === '/' || monitor.type === 'TCP')
    && extraHeaders.length === 0
    && !monitor.followRedirects
    && monitor.port == null
    && monitor.interval === 60
    && monitor.timeout === 5
    && monitor.consecutiveFails === 2
    && monitor.consecutiveSuccesses === 1
}

function monitorSuccessLabel(monitor: Pick<Monitor, 'expected'>) {
  return isReachabilityExpected(monitor.expected) ? '能访问即正常' : monitor.expected
}

export function App() {
  const activeView = useControlPlane((state) => state.activeView)
  const theme = useControlPlane((state) => state.theme)
  const backend = useControlPlane((state) => state.backend)
  const sidebarOpen = useControlPlane((state) => state.sidebarOpen)
  const setSidebarOpen = useControlPlane((state) => state.setSidebarOpen)
  const hydrate = useControlPlane((state) => state.hydrate)

  useEffect(() => { void hydrate() }, [hydrate])

  if (backend === 'loading') return <StartupScreen theme={theme} />
  if (backend === 'unavailable') return <StartupScreen theme={theme} unavailable onRetry={() => { void hydrate() }} />

  return (
    <div className="app-shell" data-theme={theme}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <div className={clsx('mobile-scrim', sidebarOpen && 'is-open')} onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      <Sidebar />
      <main className="app-main" id="main-content">
        <AppHeader />
        <div className="page-body">
          {activeView === 'dashboard' && <DashboardPage />}
          {activeView === 'load-balancers' && <LoadBalancersPage />}
          {activeView === 'monitors' && <MonitorsPage />}
          {activeView === 'pools' && <PoolsPage />}
          {activeView === 'origins' && <OriginsPage />}
          {activeView === 'logs' && <LogsPage />}
          {activeView === 'settings' && <SettingsPage />}
        </div>
      </main>
      <Toaster position="bottom-right" theme={theme} mobileOffset={16} />
      <AuthGate />
    </div>
  )
}

function StartupScreen({ theme, unavailable = false, onRetry }: { theme: 'light' | 'dark'; unavailable?: boolean; onRetry?: () => void }) {
  return (
    <div className="boot-screen" data-theme={theme} role={unavailable ? 'alert' : 'status'}>
      <span className="boot-mark">W</span>
      {unavailable
        ? <><strong>无法连接管理控制面</strong><p>请通过已部署的 Worker 管理域名打开，或在本地运行 <code>npm run dev:cloudflare</code>。</p><button className={button({ intent: 'secondary' })} type="button" onClick={onRetry}>重新连接</button></>
        : <><span className="boot-spinner" aria-hidden="true" /><strong>正在连接 Worker LB</strong><span className="sr-only">正在载入</span></>}
    </div>
  )
}

function AuthGate() {
  const backend = useControlPlane((state) => state.backend)
  const connect = useControlPlane((state) => state.connect)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const token = String(new FormData(event.currentTarget).get('token') ?? '')
    try {
      await connect(token)
      toast.success('已连接 Cloudflare 控制面')
    } catch (error) { toast.error(errorMessage(error)) }
  }

  return (
    <Modal open={backend === 'unauthorized'} onOpenChange={() => undefined} title="连接管理控制面" description="若未使用 Cloudflare Access，请输入安装完成时生成的管理令牌。">
      <form className="form-stack" onSubmit={submit}>
        <Field label="管理令牌"><input name="token" type="password" required autoComplete="current-password" placeholder="wlb_…" autoFocus /></Field>
        <p className="form-hint">令牌仅保存在当前浏览器标签的 sessionStorage 中，关闭标签后自动清除。</p>
        <div className="modal-actions"><button className={button({ intent: 'primary' })} type="submit">连接</button></div>
      </form>
    </Modal>
  )
}

function Sidebar() {
  const activeView = useControlPlane((state) => state.activeView)
  const theme = useControlPlane((state) => state.theme)
  const sidebarOpen = useControlPlane((state) => state.sidebarOpen)
  const setActiveView = useControlPlane((state) => state.setActiveView)
  const setSidebarOpen = useControlPlane((state) => state.setSidebarOpen)
  const toggleTheme = useControlPlane((state) => state.toggleTheme)
  const backend = useControlPlane((state) => state.backend)
  const loadBalancerCount = useControlPlane((state) => state.loadBalancers.length)

  return (
    <aside className={clsx('sidebar', sidebarOpen && 'is-open')} aria-label="主导航">
      <div>
        <div className="workspace-button">
          <span className="brand-mark">W</span>
          <span className="workspace-copy"><strong>Worker LB</strong><small>{backend === 'connected' ? 'Cloudflare 已连接' : '等待管理认证'}</small></span>
        </div>

        <nav className="nav-list">
          <span className="nav-label">工作区</span>
          {navItems.map((item) => (
            <button
              className={clsx('nav-item', activeView === item.id && 'is-active')}
              type="button"
              key={item.id}
              aria-current={activeView === item.id ? 'page' : undefined}
              onClick={() => setActiveView(item.id)}
            >
              <Icon name={item.icon} width={18} height={18} />
              <span>{item.label}</span>
              {item.id === 'load-balancers' && <span className="nav-count">{loadBalancerCount}</span>}
            </button>
          ))}
        </nav>
      </div>

      <div className="sidebar-bottom">
        <div className="theme-switch" aria-label="主题">
          <button type="button" className={theme === 'light' ? 'is-active' : ''} onClick={theme === 'dark' ? toggleTheme : undefined} aria-label="浅色主题">
            <Icon name="sun" width={17} height={17} />
          </button>
          <button type="button" className={theme === 'dark' ? 'is-active' : ''} onClick={theme === 'light' ? toggleTheme : undefined} aria-label="深色主题">
            <Icon name="moon" width={17} height={17} />
          </button>
        </div>
        <button className="nav-item" type="button" onClick={() => setActiveView('settings')}>
          <Icon name="settings" width={18} height={18} />
          <span>设置</span>
        </button>
        <div className="account-card">
          <span className="account-avatar">A</span>
          <span><strong>管理员</strong><small>Cloudflare 控制面</small></span>
        </div>
        <button className="sidebar-close" type="button" onClick={() => setSidebarOpen(false)} aria-label="关闭导航">
          <Icon name="x" width={20} height={20} />
        </button>
      </div>
    </aside>
  )
}

function AppHeader() {
  const activeView = useControlPlane((state) => state.activeView)
  const setSidebarOpen = useControlPlane((state) => state.setSidebarOpen)
  const publish = useControlPlane((state) => state.publish)
  const current = titles[activeView]

  return (
    <header className="app-header">
      <div className="header-leading">
        <button className="mobile-menu" type="button" onClick={() => setSidebarOpen(true)} aria-label="打开导航">
          <Icon name="menu" width={20} height={20} />
        </button>
        <div className="breadcrumb"><span>Worker LB</span><Icon name="chevron-right" width={14} height={14} /><span>{current.eyebrow}</span></div>
        <h1>{current.title}</h1>
      </div>
      <div className="header-actions">
        <button
          className={button({ intent: 'primary' })}
          type="button"
          onClick={() => {
            toast.promise(publish(), {
              loading: '正在验证并发布配置…',
              success: (version) => `配置 v${version} 已发布到边缘`,
              error: (error) => errorMessage(error),
            })
          }}
        >
          <Icon name="shield" width={17} height={17} /><span>发布配置</span>
        </button>
      </div>
    </header>
  )
}

function PageIntro({ description, action }: { description: string; action?: ReactNode }) {
  return (
    <div className="page-intro">
      <p>{description}</p>
      {action}
    </div>
  )
}

function StatusBadge({ state, label }: { state: HealthState; label?: string }) {
  return <span className={clsx('status-badge', `is-${state}`)}><span className="status-dot" />{label ?? stateText[state]}</span>
}

function StatCard({ label, value, detail, tone = 'blue' }: { label: string; value: string; detail: string; tone?: 'blue' | 'green' | 'violet' | 'orange' }) {
  return (
    <section className="stat-card">
      <div className={clsx('stat-icon', `tone-${tone}`)}><Icon name={label.includes('TTFB') ? 'activity' : label.includes('端点') ? 'server' : label.includes('转移') ? 'shield' : 'globe'} width={18} height={18} /></div>
      <div className="stat-copy"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
    </section>
  )
}

function DashboardPage() {
  const endpoints = useControlPlane((state) => state.endpoints)
  const loadBalancers = useControlPlane((state) => state.loadBalancers)
  const logs = useControlPlane((state) => state.logs)
  const liveTraffic = useControlPlane((state) => state.traffic)
  const failovers = useControlPlane((state) => state.failovers)
  const toggleEndpointHealth = useControlPlane((state) => state.toggleEndpointHealth)
  const healthyCount = endpoints.filter((endpoint) => endpoint.state === 'healthy').length
  const firstEndpoint = endpoints[0]
  const chartData = liveTraffic
  const requestTotal = loadBalancers.reduce((sum, item) => sum + item.requests, 0)
  const measuredTtfb = loadBalancers.map((item) => item.ttfb).filter((value) => value > 0)
  const averageTtfb = Math.round(measuredTtfb.reduce((sum, value) => sum + value, 0) / (measuredTtfb.length || 1))
  const siteRequestTotal = loadBalancers.reduce((sum, item) => sum + item.requests, 0)
  const siteSplit = siteRequestTotal ? loadBalancers.map((item) => ({ name: item.site, value: Math.round(item.requests / siteRequestTotal * 100) })) : []
  const availability = endpoints.length ? healthyCount / endpoints.length * 100 : 0

  return (
    <>
      <PageIntro
        description={`${loadBalancers.length} 个域名 · ${endpoints.length} 个源站。数据来自 Cloudflare 控制面。`}
      />

      <div className="stat-grid">
        <StatCard label="负载平衡请求" value={formatNumber(requestTotal)} detail="过去 24 小时" tone="blue" />
        <StatCard label="边缘 TTFB 平均值" value={averageTtfb ? `${averageTtfb} ms` : '—'} detail="过去 24 小时采样" tone="violet" />
        <StatCard label="健康端点" value={`${healthyCount} / ${endpoints.length}`} detail="主动检查每 60 秒" tone="green" />
        <StatCard label="自动故障转移" value={formatNumber(failovers)} detail="过去 24 小时" tone="orange" />
      </div>

      <div className="dashboard-primary-grid">
        <section className="surface network-card">
          <div className="surface-heading">
            <div><span className="section-kicker">实时健康</span><h2>网络状态</h2></div>
            <StatusBadge state={!endpoints.length ? 'unhealthy' : healthyCount === endpoints.length ? 'healthy' : 'degraded'} />
          </div>
          <div className="origin-stack">
            {endpoints.map((endpoint) => (
              <div className="origin-summary" key={endpoint.id}>
                <span className={clsx('origin-orb', `is-${endpoint.state}`)}><span /></span>
                <div><strong>{endpoint.name}</strong><small>{endpoint.region} · {endpoint.coordinates}</small></div>
                <div className="origin-time"><strong>{endpoint.state === 'unhealthy' ? '超时' : `${endpoint.latency} ms`}</strong><small>{endpoint.state === 'unhealthy' ? '连续失败 2 次' : '全部检查通过'}</small></div>
              </div>
            ))}
          </div>
          {firstEndpoint && <button
            className={button({ intent: 'secondary' })}
            type="button"
            onClick={async () => {
              try {
                await toggleEndpointHealth(firstEndpoint.id)
                const recovering = firstEndpoint.state === 'unhealthy'
                recovering ? toast.success(`${firstEndpoint.name} 已恢复`) : toast.warning(`${firstEndpoint.name} 已移出路由`)
              } catch (error) { toast.error(errorMessage(error)) }
            }}
          >
            {firstEndpoint.state === 'unhealthy' ? `恢复 ${firstEndpoint.name}` : `模拟 ${firstEndpoint.name} 故障`}
          </button>}
        </section>

        <section className="surface request-chart-card">
          <div className="surface-heading chart-title-row">
            <div><span className="section-kicker">24 小时</span><h2>负载平衡请求</h2><strong className="hero-metric">{formatNumber(requestTotal)}</strong></div>
          </div>
          <div className="chart-box tall-chart" aria-label="请求量柱状图">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} barCategoryGap="28%">
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="3 5" />
                <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }} interval={1} />
                <YAxis axisLine={false} tickLine={false} width={34} tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--chart-hover)' }} />
                <Bar dataKey="requests" radius={[8, 8, 8, 8]} fill="var(--accent-lime)" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <div className="dashboard-secondary-grid">
        <section className="surface latency-card">
          <div className="surface-heading chart-title-row">
            <div><span className="section-kicker">性能监控</span><h2>边缘 TTFB</h2><strong className="hero-metric">{averageTtfb ? `${averageTtfb} ms` : '—'}</strong></div>
          </div>
          <div className="chart-box" aria-label="TTFB 趋势图">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="ttfbFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent-violet)" stopOpacity=".28" /><stop offset="100%" stopColor="var(--accent-violet)" stopOpacity="0" /></linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="3 5" />
                <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }} interval={1} />
                <YAxis axisLine={false} tickLine={false} width={44} tickFormatter={(value) => `${value}ms`} tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }} />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="ttfb" stroke="var(--accent-violet)" strokeWidth={2.4} fill="url(#ttfbFill)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="surface split-card">
          <div className="surface-heading"><div><span className="section-kicker">请求份额</span><h2>站点分布</h2></div></div>
          <div className="split-content">
            <div className="donut-wrap" aria-label="站点请求份额环形图">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart><Pie data={siteSplit} dataKey="value" innerRadius={48} outerRadius={72} paddingAngle={3} stroke="none" isAnimationActive={false}>{siteSplit.map((_, index) => <Cell key={index} fill={['#7c3aed', '#2878ff', '#98e900', '#ff9f2e', '#c8cad0'][index % 5]} />)}</Pie></PieChart>
              </ResponsiveContainer>
              <span><strong>{endpoints.length ? `${availability.toFixed(1)}%` : '—'}</strong><small>可用性</small></span>
            </div>
            <div className="split-list">
              {siteSplit.map((item, index) => <div key={item.name}><span><i style={{ background: ['#7c3aed', '#2878ff', '#98e900', '#ff9f2e', '#c8cad0'][index % 5] }} />{item.name}</span><strong>{item.value}%</strong></div>)}
              {!siteSplit.length && <p className="empty-copy">暂无请求数据</p>}
            </div>
          </div>
        </section>
      </div>

      <section className="surface table-surface recent-logs">
        <div className="surface-heading">
          <div><span className="section-kicker">最近事件</span><h2>负载平衡日志</h2></div>
          <button className={button({ intent: 'ghost', compact: true })} type="button" onClick={() => useControlPlane.getState().setActiveView('logs')}>查看全部<Icon name="chevron-right" width={15} height={15} /></button>
        </div>
        <LogsTable logs={logs.slice(0, 4)} />
      </section>
    </>
  )
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null
  return <div className="chart-tooltip"><span>{label}</span>{payload.map((item) => <strong key={item.name}>{item.name === 'ttfb' ? `${item.value} ms` : formatNumber(item.value)}</strong>)}</div>
}

function LoadBalancersPage() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const backend = useControlPlane((state) => state.backend)
  const cloudflare = useControlPlane((state) => state.cloudflare)
  const loadBalancers = useControlPlane((state) => state.loadBalancers)
  const pools = useControlPlane((state) => state.pools)
  const addLoadBalancer = useControlPlane((state) => state.addLoadBalancer)
  const setActiveView = useControlPlane((state) => state.setActiveView)
  const filtered = loadBalancers.filter((item) => `${item.hostname} ${item.site}`.toLowerCase().includes(query.toLowerCase()))
  const needsCloudflareToken = backend === 'connected' && !cloudflare.configured

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const hostname = String(form.get('hostname'))
    const next: LoadBalancer = {
      id: `lb-${Date.now()}`,
      hostname,
      originHost: String(form.get('originHost') ?? '').trim() || null,
      site: String(form.get('site')),
      pools: [String(form.get('pool'))],
      steering: String(form.get('steering')) as LoadBalancer['steering'],
      sessionAffinity: form.get('affinity') === 'on',
      state: 'healthy',
      ttfb: 0,
      requests: 0,
    }
    try {
      await addLoadBalancer(next)
      setOpen(false)
      toast.success(`${hostname} 已创建`, { description: 'DNS 与 Worker Route 已接入；发布配置后将在边缘生效。' })
    } catch (error) { toast.error(errorMessage(error)) }
  }

  return (
    <>
      <PageIntro description="将主机名连接到池，并配置邻近感知、会话保持与故障转移策略。" action={needsCloudflareToken
        ? <button className={button({ intent: 'primary' })} type="button" onClick={() => setActiveView('settings')}><Icon name="settings" width={17} height={17} />先配置 Cloudflare Token</button>
        : <button className={button({ intent: 'primary' })} type="button" onClick={() => setOpen(true)}><Icon name="plus" width={17} height={17} />创建负载平衡器</button>} />
      {needsCloudflareToken && <section className="connection-notice" role="status">
        <span className="connection-notice-icon"><Icon name="globe" width={18} height={18} /></span>
        <div><strong>先连接 Cloudflare API</strong><p>创建负载平衡器需要自动检查橙色云 DNS，并把该主机名精确绑定到当前 Worker。</p></div>
        <button className={button({ intent: 'secondary', compact: true })} type="button" onClick={() => setActiveView('settings')}>前往设置</button>
      </section>}
      <section className="surface table-surface">
        <DataToolbar count={filtered.length} unit="个负载平衡器" query={query} setQuery={setQuery} placeholder="搜索主机名或站点" />
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>主机名</th><th>站点</th><th>池</th><th>转向策略</th><th>接入</th><th>状态</th><th>TTFB</th><th>24 小时请求</th><th><span className="sr-only">操作</span></th></tr></thead>
            <tbody>{filtered.map((item) => <tr key={item.id}><td><button className="table-link" type="button" onClick={() => toast.info(item.hostname, { description: item.domain ? `${item.domain.routePattern} 已绑定到当前 Worker。` : '该记录尚无 Cloudflare 域名接入信息。' })}>{item.hostname}</button></td><td>{item.site}</td><td><div className="pool-chips">{item.pools.map((pool) => <span key={pool}>{pool.replace('pool-', '')}</span>)}</div></td><td>{item.steering}</td><td><span className={clsx('domain-status', item.domain && 'is-connected')}><span />{item.domain ? '已接入' : '未接入'}</span>{item.domain && <small className="domain-zone">{item.domain.zone}</small>}</td><td><StatusBadge state={item.state} /></td><td className="numeric">{item.ttfb ? `${item.ttfb} ms` : '—'}</td><td className="numeric">{formatNumber(item.requests)}</td><td><DeleteResourceButton kind="load-balancers" id={item.id} name={item.hostname} compact /></td></tr>)}</tbody>
          </table>
        </div>
      </section>
      <Modal open={open} onOpenChange={setOpen} title="创建负载平衡器" description="设置公开主机名和默认路由策略。Cloudflare 接入会在创建时一次完成。">
        <form className="form-stack" onSubmit={submit}>
          <div className="domain-provision-note"><Icon name="globe" width={18} height={18} /><div><strong>自动接入域名</strong><p>系统将查找所属 Zone，检查或创建橙色云 DNS，再创建 <code>hostname/*</code> 精确 Worker Route。</p></div></div>
          <Field label="主机名"><input name="hostname" required placeholder="www.example.com" /></Field>
          <Field label="源站 Host（可选）"><input name="originHost" placeholder="默认使用上面的公开主机名" /><small className="field-help">仅在源站虚拟主机与公开主机名不同时填写。</small></Field>
          <Field label="站点名称"><input name="site" required placeholder="生产官网" /></Field>
          <div className="field-row">
            <Field label="默认池"><select name="pool" defaultValue={pools[0]?.id}>{pools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name}</option>)}</select></Field>
            <Field label="流量转向"><select name="steering" defaultValue="邻近感知"><option>邻近感知</option><option>动态延迟</option><option>随机</option><option>故障转移</option></select></Field>
          </div>
          <label className="switch-row"><span><strong>会话保持</strong><small>使用 Cloudflare Cookie，默认 30 分钟</small></span><input type="checkbox" name="affinity" defaultChecked /></label>
          <ModalActions onCancel={() => setOpen(false)} submit="创建负载平衡器" />
        </form>
      </Modal>
    </>
  )
}

function MonitorsPage() {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Monitor | null>(null)
  const [checkMode, setCheckMode] = useState<'reachability' | 'custom'>('reachability')
  const monitors = useControlPlane((state) => state.monitors)
  const addMonitor = useControlPlane((state) => state.addMonitor)
  const updateMonitor = useControlPlane((state) => state.updateMonitor)
  const testMonitor = useControlPlane((state) => state.testMonitor)

  function openCreate() {
    setEditing(null)
    setCheckMode('reachability')
    setOpen(true)
  }

  function openEdit(monitor: Monitor) {
    setEditing(monitor)
    setCheckMode(isSimpleMonitor(monitor) ? 'reachability' : 'custom')
    setOpen(true)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name'))
    const type = String(form.get('type')) as Monitor['type']
    let extraHeaders: unknown = {}
    const headersJson = checkMode === 'custom' ? String(form.get('headersJson') ?? '').trim() : ''
    try { extraHeaders = headersJson ? JSON.parse(headersJson) : {} } catch { toast.error('附加请求头必须是有效的 JSON 对象'); return }
    if (!extraHeaders || typeof extraHeaders !== 'object' || Array.isArray(extraHeaders)) { toast.error('附加请求头必须是 JSON 对象'); return }
    const headers = Object.fromEntries(Object.entries(extraHeaders).map(([key, value]) => [key, String(value)]))
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'host') delete headers[key]
    const host = String(form.get('host') ?? '').trim()
    if (host) headers.Host = host
    const reachability = checkMode === 'reachability'
    const next: Monitor = {
      id: editing?.id ?? `mon-${Date.now()}`,
      name,
      type,
      method: reachability ? 'GET' : String(form.get('method')) as Monitor['method'],
      path: reachability ? (type === 'TCP' ? '443' : '/') : String(form.get('path')),
      port: reachability ? null : (String(form.get('port') ?? '').trim() ? Number(form.get('port')) : null),
      interval: reachability ? 60 : Number(form.get('interval')),
      timeout: reachability ? 5 : Number(form.get('timeout')),
      expected: reachability ? '*' : String(form.get('expected')),
      consecutiveFails: reachability ? 2 : Number(form.get('consecutiveFails')),
      consecutiveSuccesses: reachability ? 1 : Number(form.get('consecutiveSuccesses')),
      headers,
      followRedirects: reachability ? false : form.get('followRedirects') === 'on',
      pools: editing?.pools ?? 0,
      state: editing?.state ?? 'healthy',
    }
    try {
      if (editing) await updateMonitor(next)
      else await addMonitor(next)
      setOpen(false)
      toast.success(`${name} 已${editing ? '更新' : '创建'}`)
    } catch (error) { toast.error(errorMessage(error)) }
  }

  const editingHost = editing ? Object.entries(editing.headers).find(([key]) => key.toLowerCase() === 'host')?.[1] ?? '' : ''
  const editingExtraHeaders = editing ? Object.fromEntries(Object.entries(editing.headers).filter(([key]) => key.toLowerCase() !== 'host')) : {}

  return (
    <>
      <PageIntro description="默认只确认源站能否访问。只有需要专用健康接口或指定状态码时，才创建自定义监视器。" action={<button className={button({ intent: 'primary' })} type="button" onClick={openCreate}><Icon name="plus" width={17} height={17} />创建监视器</button>} />
      <div className="monitor-grid">
        {monitors.map((monitor) => {
          const host = Object.entries(monitor.headers).find(([key]) => key.toLowerCase() === 'host')?.[1]
          const reachability = isReachabilityExpected(monitor.expected)
          return <section className="surface monitor-card" key={monitor.id}><div className="monitor-top"><span className="monitor-icon"><Icon name="pulse" width={19} height={19} /></span><div className="monitor-top-status">{monitor.id === REACHABILITY_MONITOR_ID && <span className="soft-chip">默认</span>}<StatusBadge state={monitor.state} /></div></div><h2>{monitor.name}</h2><p>{reachability ? `${monitor.type} · 能访问即正常` : `${monitor.method} · ${monitor.type} · ${monitor.path}${monitor.port ? `:${monitor.port}` : ''}`}</p>{host && <p className="monitor-host">Host · {host}</p>}<div className="mini-kv"><span>间隔<strong>{monitor.interval} 秒</strong></span><span>超时<strong>{monitor.timeout} 秒</strong></span><span>期望<strong>{monitorSuccessLabel(monitor)}</strong></span><span>关联池<strong>{monitor.pools}</strong></span></div><div className="card-actions"><button className={button({ intent: 'secondary', compact: true })} type="button" onClick={() => openEdit(monitor)}>编辑</button><button className={button({ intent: 'secondary', compact: true })} type="button" onClick={() => { toast.promise(testMonitor(monitor.id), { loading: '正在检查源站…', success: (result) => `${monitor.name} 检查成功 · ${result.latencyMs} ms`, error: (error) => errorMessage(error) }) }}>立即测试</button>{monitor.id !== REACHABILITY_MONITOR_ID && <DeleteResourceButton kind="monitors" id={monitor.id} name={monitor.name} compact />}</div></section>
        })}
      </div>
      <Modal open={open} onOpenChange={setOpen} title={editing ? '编辑监视器' : '创建监视器'} description="默认只要源站能返回响应就视为正常，不必准备 /healthz。">
        <form className="form-stack" onSubmit={submit} key={editing?.id ?? 'new-monitor'}>
          <Field label="名称"><input name="name" required placeholder={checkMode === 'reachability' ? '源站可达性' : 'HTTPS · Web 健康检查'} defaultValue={editing?.name} /></Field>
          <div className="field">
            <span>检查方式</span>
            <div className="segmented" role="radiogroup" aria-label="检查方式">
              <button type="button" className={checkMode === 'reachability' ? 'is-active' : ''} aria-pressed={checkMode === 'reachability'} onClick={() => setCheckMode('reachability')}>源站能访问即可</button>
              <button type="button" className={checkMode === 'custom' ? 'is-active' : ''} aria-pressed={checkMode === 'custom'} onClick={() => setCheckMode('custom')}>指定路径和状态码</button>
            </div>
          </div>
          <Field label="协议"><select name="type" defaultValue={editing?.type ?? 'HTTPS'}><option>HTTPS</option><option>HTTP</option><option>TCP</option></select></Field>
          {checkMode === 'custom' && <div className="field-row"><Field label="请求方法"><select name="method" defaultValue={editing?.method ?? 'GET'}><option>GET</option><option>HEAD</option></select></Field><Field label="路径"><input name="path" required defaultValue={editing?.path ?? '/'} /></Field></div>}
          {checkMode === 'custom' && <Field label="端口（可选）"><input name="port" type="number" min="1" max="65535" defaultValue={editing?.port ?? ''} placeholder="HTTPS 默认 443" /></Field>}
          <Field label="Host 请求头（可选）"><input name="host" defaultValue={editingHost} placeholder="站点的源站虚拟主机名" /><small className="field-help">虚拟主机才需要填写；留空则直接访问源站地址。</small></Field>
          {checkMode === 'reachability' && <p className="form-hint">会请求源站根路径。只要能连上并收到任意 HTTP 响应，就视为健康；连接失败或超时才移出。</p>}
          {checkMode === 'custom' && <>
            <Field label="附加请求头（JSON，可选）"><textarea name="headersJson" defaultValue={Object.keys(editingExtraHeaders).length ? JSON.stringify(editingExtraHeaders, null, 2) : ''} placeholder={'{\n  "Authorization": "Bearer …"\n}'} spellCheck={false} /></Field>
            <div className="field-row"><Field label="检查间隔"><select name="interval" defaultValue={String(editing?.interval ?? 60)}><option value="60">60 秒</option><option value="120">120 秒</option><option value="300">300 秒</option></select></Field><Field label="超时"><select name="timeout" defaultValue={String(editing?.timeout ?? 5)}><option value="3">3 秒</option><option value="5">5 秒</option><option value="10">10 秒</option></select></Field></div>
            <Field label="预期状态码"><input name="expected" required defaultValue={isReachabilityExpected(editing?.expected ?? '*') ? '200-299' : editing?.expected} /><small className="field-help">例如 200-299。填写 * 表示任意响应都算成功。</small></Field>
            <div className="field-row"><Field label="连续失败阈值"><input name="consecutiveFails" type="number" min="1" max="10" defaultValue={editing?.consecutiveFails ?? 2} /></Field><Field label="连续成功阈值"><input name="consecutiveSuccesses" type="number" min="1" max="10" defaultValue={editing?.consecutiveSuccesses ?? 1} /></Field></div>
            <label className="switch-row"><span><strong>跟随重定向</strong><small>关闭时，3xx 会直接参与状态码判断。</small></span><input type="checkbox" name="followRedirects" defaultChecked={editing?.followRedirects ?? false} /></label>
          </>}
          <ModalActions onCancel={() => setOpen(false)} submit={editing ? '保存更改' : '创建监视器'} />
        </form>
      </Modal>
    </>
  )
}

function PoolsPage() {
  const [open, setOpen] = useState(false)
  const pools = useControlPlane((state) => state.pools)
  const endpoints = useControlPlane((state) => state.endpoints)
  const monitors = useControlPlane((state) => state.monitors)
  const addPool = useControlPlane((state) => state.addPool)
  const togglePool = useControlPlane((state) => state.togglePool)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name'))
    const origins = form.getAll('origins').map(String)
    if (!origins.length) {
      toast.error('请至少选择一个源站')
      return
    }
    const next: Pool = { id: `pool-${Date.now()}`, name, description: String(form.get('description')), monitor: String(form.get('monitor') || ''), origins, enabled: true }
    try {
      await addPool(next)
      setOpen(false)
      toast.success(`${name} 已创建`)
    } catch (error) { toast.error(errorMessage(error)) }
  }

  return (
    <>
      <PageIntro description="池将多个源站组成一个可复用的路由目标。默认健康检查只需源站能访问，无需专用接口。" action={<button className={button({ intent: 'primary' })} type="button" onClick={() => setOpen(true)}><Icon name="plus" width={17} height={17} />创建池</button>} />
      <div className="pool-grid">
        {pools.map((pool) => {
          const monitor = monitors.find((item) => item.id === pool.monitor)
          return <section className={clsx('surface pool-card', !pool.enabled && 'is-disabled')} key={pool.id}><div className="pool-card-top"><div className="pool-emblem"><Icon name="layers" width={20} height={20} /></div><label className="switch-control"><input type="checkbox" checked={pool.enabled} onChange={() => { void togglePool(pool.id).catch((error) => toast.error(errorMessage(error))) }} /><span /></label></div><h2>{pool.name}</h2><p>{pool.description}</p><div className="pool-health-row"><StatusBadge state={pool.enabled ? 'healthy' : 'unhealthy'} /><span>{pool.origins.length} 个源站</span></div><div className="pool-origin-list">{pool.origins.map((originId) => { const origin = endpoints.find((item) => item.id === originId); return origin ? <div key={origin.id}><span className={clsx('status-dot', `is-${origin.state}`)} /><span><strong>{origin.name}</strong><small>{origin.address}</small></span><b>{origin.state === 'healthy' ? `${origin.latency} ms` : '超时'}</b></div> : null })}</div><div className="pool-footer"><span>健康检查</span><strong>{monitor ? (isReachabilityExpected(monitor.expected) ? '能访问即正常' : monitor.name) : '未设置'}</strong><DeleteResourceButton kind="pools" id={pool.id} name={pool.name} compact /></div></section>
        })}
      </div>
      <Modal open={open} onOpenChange={setOpen} title="创建池" description="选择该池可以使用的 VPS 源站。健康检查默认只要能访问就视为正常。">
        <form className="form-stack" onSubmit={submit}>
          <Field label="池名称"><input name="name" required placeholder="生产主池" /></Field>
          <Field label="说明"><textarea name="description" required placeholder="该池承载哪些站点和流量" rows={3} /></Field>
          {monitors.some((item) => item.id !== REACHABILITY_MONITOR_ID)
            ? <Field label="健康检查"><select name="monitor" defaultValue={monitors.find((item) => item.id === REACHABILITY_MONITOR_ID)?.id ?? monitors[0]?.id}>{monitors.map((monitor) => <option key={monitor.id} value={monitor.id}>{isReachabilityExpected(monitor.expected) ? `${monitor.name} · 能访问即正常` : `${monitor.name} · ${monitor.method} ${monitor.path}`}</option>)}</select><small className="field-help">默认不需要 /healthz；只有要按状态码判断时才换自定义监视器。</small></Field>
            : <p className="form-hint">健康检查使用默认规则：源站能访问即视为正常，无需 /healthz。</p>}
          <fieldset className="origin-picker">
            <legend>源站</legend>
            {endpoints.map((endpoint) => <label className="origin-check" key={endpoint.id}><input type="checkbox" name="origins" value={endpoint.id} defaultChecked /><span className={clsx('status-dot', `is-${endpoint.state}`)} /><span><strong>{endpoint.name}</strong><small>{endpoint.address} · 权重 {endpoint.weight}</small></span></label>)}
          </fieldset>
          <ModalActions onCancel={() => setOpen(false)} submit="创建池" />
        </form>
      </Modal>
    </>
  )
}

function OriginsPage() {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Endpoint | null>(null)
  const [address, setAddress] = useState('')
  const [zoneDraft, setZoneDraft] = useState('')
  const [zones, setZones] = useState<string[]>([])
  const [savingZone, setSavingZone] = useState(false)
  const endpoints = useControlPlane((state) => state.endpoints)
  const originDnsZone = useControlPlane((state) => state.originDnsZone)
  const cloudflare = useControlPlane((state) => state.cloudflare)
  const backend = useControlPlane((state) => state.backend)
  const addEndpoint = useControlPlane((state) => state.addEndpoint)
  const updateEndpoint = useControlPlane((state) => state.updateEndpoint)
  const toggleEndpointHealth = useControlPlane((state) => state.toggleEndpointHealth)
  const listCloudflareZones = useControlPlane((state) => state.listCloudflareZones)
  const saveOriginDnsZone = useControlPlane((state) => state.saveOriginDnsZone)
  const setActiveView = useControlPlane((state) => state.setActiveView)
  const mapOrigins = endpoints.flatMap((endpoint) => {
    const projected = projectOrigin(endpoint)
    return projected ? [projected] : []
  })
  const previewHost = editing?.connectionHost || (addressLooksLikeIp(address) && originDnsZone ? nextOriginHost(originDnsZone, endpoints, editing?.id) : '')
  const needsCloudflareToken = backend === 'connected' && !cloudflare.configured

  function openCreate() {
    if (!originDnsZone) {
      toast.error('请先设置源站接入域名')
      return
    }
    setEditing(null)
    setAddress('')
    setOpen(true)
  }

  function openEdit(endpoint: Endpoint) {
    setEditing(endpoint)
    setAddress(endpoint.address)
    setOpen(true)
  }

  useEffect(() => {
    if (!cloudflare.configured) return
    void listCloudflareZones().then((list) => {
      setZones(list)
      setZoneDraft((current) => originDnsZone || current || list[0] || '')
    }).catch(() => setZones([]))
  }, [cloudflare.configured, listCloudflareZones, originDnsZone])

  async function submitZone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const zone = String(new FormData(event.currentTarget).get('zone') ?? '').trim()
    if (!zone) {
      toast.error('请填写接入域名')
      return
    }
    setSavingZone(true)
    try {
      const result = await saveOriginDnsZone(zone)
      toast.success(`接入域名已设为 ${result.zone}`, { description: result.provisioned.length ? `已为 ${result.provisioned.length} 个源站自动补齐灰云记录。` : '之后添加的源站都会自动分配 origin-1、origin-2…' })
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSavingZone(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const nextName = String(form.get('name')).trim()
    const nextAddress = String(form.get('address')).trim()
    const region = String(form.get('region')).trim()
    const latitude = Number(form.get('latitude'))
    const longitude = Number(form.get('longitude'))
    const weight = Number(form.get('weight'))
    const duplicate = endpoints.some((endpoint) => endpoint.id !== editing?.id && endpoint.address.toLowerCase() === nextAddress.toLowerCase())

    if (duplicate) {
      toast.error('该源站地址已经存在')
      return
    }
    if (addressLooksLikeIp(nextAddress) && !originDnsZone) {
      toast.error('请先设置源站接入域名')
      return
    }

    const next: Endpoint = {
      id: editing?.id ?? `origin-${Date.now()}`,
      name: nextName,
      address: nextAddress,
      connectionHost: editing?.connectionHost ?? null,
      region,
      coordinates: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
      latency: 0,
      weight,
      state: 'healthy',
    }
    try {
      if (editing) await updateEndpoint(next)
      else await addEndpoint(next)
      setOpen(false)
      toast.success(`${nextName} 已${editing ? '更新' : '添加'}`, { description: previewHost && !editing ? `已接入 ${previewHost}，发布配置后在线上生效。` : '重新发布配置后在线上生效。' })
    } catch (error) { toast.error(errorMessage(error)) }
  }

  return (
    <>
      <PageIntro description="接入域名只需设置一次。之后每个源站都会自动分配 origin-1、origin-2… 并创建灰云 A 记录。" action={needsCloudflareToken
        ? <button className={button({ intent: 'primary' })} type="button" onClick={() => setActiveView('settings')}><Icon name="settings" width={17} height={17} />先配置 Cloudflare Token</button>
        : <button className={button({ intent: 'primary' })} type="button" onClick={openCreate}><Icon name="plus" width={17} height={17} />添加源站</button>} />
      {needsCloudflareToken && <section className="connection-notice" role="status">
        <span className="connection-notice-icon"><Icon name="globe" width={18} height={18} /></span>
        <div><strong>先连接 Cloudflare API</strong><p>添加源站时需要自动创建灰云 A 记录。Token 需要 Zone Read 和 DNS Edit。</p></div>
        <button className={button({ intent: 'secondary', compact: true })} type="button" onClick={() => setActiveView('settings')}>前往设置</button>
      </section>}
      {!needsCloudflareToken && <section className="surface origin-zone-card">
        <div className="settings-heading">
          <div>
            <span className="section-kicker">接入域名</span>
            <h2>{originDnsZone || '尚未设置'}</h2>
            <p>{originDnsZone ? '所有源站共用这个域名，前缀按序号自动补齐，无需每个源站再填一次。' : '设置一次后，东京、新加坡等源站都会自动得到各自的灰云记录。'}</p>
          </div>
          {originDnsZone && <span className="soft-chip">origin-1 / origin-2</span>}
        </div>
        <form className="token-form" onSubmit={submitZone}>
          <Field label="域名">
            {zones.length
              ? <select name="zone" value={zoneDraft} onChange={(event) => setZoneDraft(event.target.value)}>{zones.map((item) => <option key={item} value={item}>{item}</option>)}</select>
              : <input name="zone" value={zoneDraft} onChange={(event) => setZoneDraft(event.target.value)} placeholder="pdfsk.com" required />}
          </Field>
          <button className={button({ intent: 'primary' })} type="submit" disabled={savingZone}>{savingZone ? '正在保存…' : originDnsZone ? '更新域名' : '保存并自动接入'}</button>
        </form>
      </section>}
      <div className="origin-page-grid">
        <section className="surface proximity-map-card">
          <div className="surface-heading"><div><span className="section-kicker">邻近感知</span><h2>源站地图</h2></div><span className="soft-chip">按经纬度显示</span></div>
          <div className="proximity-map" role="img" aria-label={`${endpoints.length} 个源站在世界地图上的位置`}>
            <svg viewBox="0 0 360 180" preserveAspectRatio="xMidYMid meet">
              <rect className="world-ocean" width="360" height="180" />
              <path className="world-land" d={worldLandPath} />
              {mapOrigins.map(({ endpoint, x, y }) => {
                const labelLeft = x > 300
                const labelBelow = y < 16
                return <g className={clsx('map-origin', `is-${endpoint.state}`)} transform={`translate(${x} ${y})`} key={endpoint.id}><title>{endpoint.name} · {endpoint.region}</title><circle className="map-origin-halo" r="5.4" /><circle className="map-origin-dot" r="2.15" /><text x={labelLeft ? -7 : 7} y={labelBelow ? 10 : -6.5} textAnchor={labelLeft ? 'end' : 'start'}>{endpoint.name}</text></g>
              })}
              {!mapOrigins.length && <text className="map-empty" x="180" y="96" textAnchor="middle">添加源站后将按地理位置显示</text>}
            </svg>
            <span className="map-legend"><i className="is-healthy" />健康源站 <i className="is-unhealthy" />不健康</span>
          </div>
        </section>
        <div className="origin-detail-stack">
          {endpoints.map((endpoint) => <section className="surface origin-detail-card" key={endpoint.id}><div className="origin-detail-heading"><span className={clsx('origin-orb', `is-${endpoint.state}`)}><span /></span><div><h2>{endpoint.name}</h2><p>{endpoint.address}</p>{endpoint.connectionHost && <p>接入 · {endpoint.connectionHost}</p>}</div><StatusBadge state={endpoint.state} label={endpoint.state === 'degraded' && !endpoint.latency ? '待检查' : undefined} /></div><div className="mini-kv"><span>区域<strong>{endpoint.region}</strong></span><span>坐标<strong>{endpoint.coordinates}</strong></span><span>权重<strong>{endpoint.weight}</strong></span><span>延迟<strong>{endpoint.state === 'healthy' ? `${endpoint.latency} ms` : endpoint.state === 'degraded' ? '待检查' : '超时'}</strong></span></div><div className="card-actions"><button className={button({ intent: 'secondary', compact: true })} type="button" onClick={() => openEdit(endpoint)}>编辑</button><button className={button({ intent: endpoint.state === 'healthy' ? 'danger' : 'secondary' })} type="button" onClick={async () => { try { await toggleEndpointHealth(endpoint.id); endpoint.state === 'healthy' ? toast.warning(`${endpoint.name} 已移出`) : toast.success(`${endpoint.name} 已恢复`) } catch (error) { toast.error(errorMessage(error)) } }}>{endpoint.state === 'healthy' ? '模拟故障' : '恢复节点'}</button><DeleteResourceButton kind="origins" id={endpoint.id} name={endpoint.name} compact /></div></section>)}
        </div>
      </div>
      <Modal open={open} onOpenChange={setOpen} title={editing ? '编辑源站' : '添加源站'} description={originDnsZone ? `将自动接入 ${originDnsZone} 下的下一个 origin 前缀。` : '请先在本页设置接入域名。'}>
        <form className="form-stack" onSubmit={submit} key={editing?.id ?? 'new-origin'}>
          <Field label="源站名称"><input name="name" required autoFocus placeholder="东京节点" defaultValue={editing?.name} /></Field>
          <Field label="IP 地址"><input name="address" required placeholder="203.0.113.10" value={address} onChange={(event) => setAddress(event.target.value)} /></Field>
          {previewHost && <div className="domain-provision-note"><Icon name="globe" width={18} height={18} /><div><strong>{editing?.connectionHost ? `已接入 ${previewHost}` : `将自动接入 ${previewHost}`}</strong><p>灰云 A 记录指向 {address || '该 IP'}。其他源站会继续分配 origin-2、origin-3…</p></div></div>}
          <div className="field-row">
            <Field label="区域"><input name="region" required placeholder="Asia Pacific" defaultValue={editing?.region} /></Field>
            <Field label="权重"><input name="weight" type="number" required min="0" max="100" step="1" defaultValue={editing?.weight ?? 50} /></Field>
          </div>
          <div className="field-row">
            <Field label="纬度"><input name="latitude" type="number" required min="-90" max="90" step="any" placeholder="1.3521" defaultValue={editing?.coordinates.split(',')[0].trim()} /></Field>
            <Field label="经度"><input name="longitude" type="number" required min="-180" max="180" step="any" placeholder="103.8198" defaultValue={editing?.coordinates.split(',')[1].trim()} /></Field>
          </div>
          <ModalActions onCancel={() => setOpen(false)} submit={editing ? '保存更改' : '添加源站'} />
        </form>
      </Modal>
    </>
  )
}

function LogsPage() {
  const [query, setQuery] = useState('')
  const logs = useControlPlane((state) => state.logs)
  const filtered = useMemo(() => logs.filter((item) => `${item.hostname} ${item.origin} ${item.event}`.toLowerCase().includes(query.toLowerCase())), [logs, query])
  return (
    <>
      <PageIntro description="集中查看健康检查、路由选择、故障转移和配置发布事件。" />
      <section className="surface table-surface">
        <DataToolbar count={filtered.length} unit="条事件" query={query} setQuery={setQuery} placeholder="搜索域名、源站或事件" />
        <LogsTable logs={filtered} />
      </section>
    </>
  )
}

function LogsTable({ logs }: { logs: ReturnType<typeof useControlPlane.getState>['logs'] }) {
  return <div className="table-scroll"><table className="data-table"><thead><tr><th>时间</th><th>事件</th><th>站点</th><th>源站 / 池</th><th>结果</th><th>耗时</th></tr></thead><tbody>{logs.map((log) => <tr key={log.id}><td className="numeric muted-cell">{log.time}</td><td><span className={clsx('event-chip', `is-${log.level}`)}>{log.event}</span></td><td>{log.hostname}</td><td>{log.origin}</td><td><span className={clsx('result-text', `is-${log.level}`)}>{log.result}</span></td><td className="numeric">{log.duration}</td></tr>)}</tbody></table></div>
}

function SettingsPage() {
  const theme = useControlPlane((state) => state.theme)
  const toggleTheme = useControlPlane((state) => state.toggleTheme)
  const cloudflare = useControlPlane((state) => state.cloudflare)
  const saveCloudflareToken = useControlPlane((state) => state.saveCloudflareToken)
  const testCloudflareToken = useControlPlane((state) => state.testCloudflareToken)
  const removeCloudflareToken = useControlPlane((state) => state.removeCloudflareToken)
  const loadBalancers = useControlPlane((state) => state.loadBalancers)
  const [savingToken, setSavingToken] = useState(false)
  const attachedDomainCount = loadBalancers.filter((item) => item.domain).length

  async function submitCloudflareToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const token = String(new FormData(form).get('cloudflareToken') ?? '')
    setSavingToken(true)
    try {
      const result = await saveCloudflareToken(token)
      form.reset()
      toast.success('Cloudflare API Token 已加密保存', { description: `已验证 ${result.zoneCount} 个可管理 Zone。` })
    } catch (error) { toast.error(errorMessage(error)) } finally { setSavingToken(false) }
  }

  return (
    <>
      <PageIntro description="控制管理界面、安全访问与配置发布行为。" />
      <div className="settings-layout">
        <section className="surface settings-card cloudflare-token-card">
          <div className="settings-heading">
            <div><h2>Cloudflare API 连接</h2><p>用于在创建负载平衡器时自动配置橙色云 DNS 和 Worker Route。</p></div>
            <span className={clsx('status-badge', cloudflare.configured ? 'is-healthy' : 'is-degraded')}><span className="status-dot" />{cloudflare.configured ? '已连接' : '未配置'}</span>
          </div>
          <div className="token-permissions"><span>所需权限</span><code>Zone Read</code><code>DNS Edit</code><code>Workers Routes Edit</code></div>
          <form className="token-form" onSubmit={submitCloudflareToken}>
            <Field label={cloudflare.configured ? `替换 Token（当前 ${cloudflare.tokenHint ?? ''}）` : 'Cloudflare API Token'}><input name="cloudflareToken" type="password" required minLength={20} maxLength={256} autoComplete="new-password" placeholder="粘贴 API Token，仅通过 HTTPS 提交" /></Field>
            <div className="token-actions">
              <a className={button({ intent: 'secondary', compact: true })} href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">获取 Token</a>
              {cloudflare.configured && <button className={button({ intent: 'secondary', compact: true })} type="button" onClick={() => { toast.promise(testCloudflareToken(), { loading: '正在验证 Cloudflare 权限…', success: (result) => `连接正常 · ${result.zoneCount} 个 Zone`, error: (error) => errorMessage(error) }) }}>测试连接</button>}
              <button className={button({ intent: 'primary', compact: true })} type="submit" disabled={savingToken}>{savingToken ? '正在验证…' : cloudflare.configured ? '替换 Token' : '保存 Token'}</button>
              {cloudflare.configured && <button className={button({ intent: 'danger', compact: true })} type="button" disabled={attachedDomainCount > 0} title={attachedDomainCount ? `请先删除 ${attachedDomainCount} 个已接入域名的负载平衡器` : undefined} onClick={() => { toast.promise(removeCloudflareToken(), { loading: '正在清除 Token…', success: 'Cloudflare API Token 已清除', error: (error) => errorMessage(error) }) }}>清除</button>}
            </div>
          </form>
          <p className="token-security-note">Token 使用安装时生成的 AES-GCM 密钥加密后保存；界面和 API 均不会返回 Token 明文。建议同时使用 Cloudflare Access 保护此管理地址。</p>
          {attachedDomainCount > 0 && <p className="token-route-warning">已有 {attachedDomainCount} 个域名由本系统接入。请先删除对应负载平衡器，让系统清理 Worker Route，再清除 Token。</p>}
        </section>
        <section className="surface settings-card"><div className="settings-heading"><div><h2>外观</h2><p>选择控制台使用的显示主题。</p></div></div><label className="settings-row"><span><strong>深色模式</strong><small>跟随当前控制台设置，不影响站点流量。</small></span><span className="switch-control"><input type="checkbox" checked={theme === 'dark'} onChange={toggleTheme} /><span /></span></label></section>
      </div>
    </>
  )
}

function DataToolbar({ count, unit, query, setQuery, placeholder }: { count: number; unit: string; query: string; setQuery: (query: string) => void; placeholder: string }) {
  return <div className="data-toolbar"><div><span>总计</span><strong>{count}</strong><small>{unit}</small></div><label className="search-field"><Icon name="search" width={17} height={17} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} /></label></div>
}

function DeleteResourceButton({ kind, id, name, compact = false }: { kind: ResourceKind; id: string; name: string; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const deleteResource = useControlPlane((state) => state.deleteResource)
  const labels: Record<ResourceKind, string> = { 'load-balancers': '负载平衡器', monitors: '监视器', pools: '池', origins: '源站' }

  async function confirmDelete() {
    setDeleting(true)
    try {
      await deleteResource(kind, id)
      setOpen(false)
      toast.success(`${name} 已删除`, { description: '重新发布配置后，线上请求路径才会更新。' })
    } catch (error) {
      toast.error(errorMessage(error))
    } finally { setDeleting(false) }
  }

  return (
    <>
      <button className={button({ intent: 'danger', compact })} type="button" onClick={() => setOpen(true)} aria-label={`删除${labels[kind]} ${name}`}><Icon name="trash" width={15} height={15} />删除</button>
      <Modal open={open} onOpenChange={setOpen} title={`删除${labels[kind]}`} description="此操作会删除控制面中的草稿记录。">
        <div className="delete-confirm-copy"><strong>{name}</strong><p>删除后无法在界面中恢复。如果它仍被其他资源引用，系统会阻止本次操作。</p></div>
        <div className="modal-actions"><button className={button({ intent: 'secondary' })} type="button" onClick={() => setOpen(false)}>取消</button><button className={button({ intent: 'danger' })} type="button" disabled={deleting} onClick={() => { void confirmDelete() }}>{deleting ? '正在删除…' : '确认删除'}</button></div>
      </Modal>
    </>
  )
}

function Modal({ open, onOpenChange, title, description, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="dialog-popup">
          <div className="dialog-heading"><div><Dialog.Title className="dialog-title">{title}</Dialog.Title><Dialog.Description className="dialog-description">{description}</Dialog.Description></div><button type="button" className="dialog-close" onClick={() => onOpenChange(false)} aria-label="关闭"><Icon name="x" width={19} height={19} /></button></div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>
}

function ModalActions({ onCancel, submit }: { onCancel: () => void; submit: string }) {
  return <div className="modal-actions"><button className={button({ intent: 'secondary' })} type="button" onClick={onCancel}>取消</button><button className={button({ intent: 'primary' })} type="submit">{submit}</button></div>
}
