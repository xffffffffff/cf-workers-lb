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
import { requestSplit, trafficData } from './data'
import { Icon, type IconName } from './icons'
import { useControlPlane, type ResourceKind } from './store'
import type { Endpoint, HealthState, LoadBalancer, Monitor, Pool, ViewId } from './types'

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

export function App() {
  const activeView = useControlPlane((state) => state.activeView)
  const theme = useControlPlane((state) => state.theme)
  const sidebarOpen = useControlPlane((state) => state.sidebarOpen)
  const setSidebarOpen = useControlPlane((state) => state.setSidebarOpen)
  const hydrate = useControlPlane((state) => state.hydrate)

  useEffect(() => { void hydrate() }, [hydrate])

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
          <span className="workspace-copy"><strong>Worker LB</strong><small>{backend === 'connected' ? 'Cloudflare 已连接' : backend === 'loading' ? '正在连接…' : '本地演示模式'}</small></span>
          <Icon name="chevron-down" width={16} height={16} />
        </div>

        <button className="quick-search" type="button" onClick={() => toast('可在各资源页面使用搜索与筛选')}>
          <Icon name="search" width={18} height={18} />
          <span>快速搜索</span>
          <kbd>⌘K</kbd>
        </button>

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
          <Icon name="chevron-down" width={16} height={16} />
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
  const backend = useControlPlane((state) => state.backend)
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
        <button className="icon-action notification-button" type="button" aria-label="通知" onClick={() => toast.info('目前没有需要处理的新告警')}>
          <Icon name="bell" width={19} height={19} />
          <span>1</span>
        </button>
        <button className={button({ intent: 'secondary' })} type="button" onClick={() => toast('筛选已重置')}>
          <Icon name="filter" width={17} height={17} />筛选
        </button>
        <button
          className={button({ intent: 'primary' })}
          type="button"
          onClick={() => {
            toast.promise(publish(), {
              loading: '正在验证并发布配置…',
              success: (version) => version ? `配置 v${version} 已发布到边缘` : '演示配置已发布',
              error: (error) => errorMessage(error),
            })
          }}
        >
          <Icon name="shield" width={17} height={17} /><span>{backend === 'loading' ? '连接中' : '发布配置'}</span>
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

function Segmented({ values, active, onChange, label }: { values: string[]; active: string; onChange: (value: string) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {values.map((value) => <button type="button" key={value} className={active === value ? 'is-active' : ''} onClick={() => onChange(value)}>{value}</button>)}
    </div>
  )
}

function StatCard({ label, value, detail, trend, tone = 'blue' }: { label: string; value: string; detail: string; trend?: string; tone?: 'blue' | 'green' | 'violet' | 'orange' }) {
  return (
    <section className="stat-card">
      <div className={clsx('stat-icon', `tone-${tone}`)}><Icon name={label.includes('TTFB') ? 'activity' : label.includes('端点') ? 'server' : label.includes('转移') ? 'shield' : 'globe'} width={18} height={18} /></div>
      <div className="stat-copy"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
      {trend && <span className="trend-chip">{trend}</span>}
    </section>
  )
}

function DashboardPage() {
  const [range, setRange] = useState('24 小时')
  const backend = useControlPlane((state) => state.backend)
  const endpoints = useControlPlane((state) => state.endpoints)
  const loadBalancers = useControlPlane((state) => state.loadBalancers)
  const logs = useControlPlane((state) => state.logs)
  const liveTraffic = useControlPlane((state) => state.traffic)
  const failovers = useControlPlane((state) => state.failovers)
  const toggleEndpointHealth = useControlPlane((state) => state.toggleEndpointHealth)
  const healthyCount = endpoints.filter((endpoint) => endpoint.state === 'healthy').length
  const ashburn = endpoints.find((endpoint) => endpoint.id === 'origin-iad') ?? endpoints[0]
  const chartData = backend === 'connected' ? liveTraffic : trafficData
  const requestTotal = backend === 'connected' ? loadBalancers.reduce((sum, item) => sum + item.requests, 0) : 32481
  const measuredTtfb = loadBalancers.map((item) => item.ttfb).filter((value) => value > 0)
  const averageTtfb = backend === 'connected' ? Math.round(measuredTtfb.reduce((sum, value) => sum + value, 0) / (measuredTtfb.length || 1)) : 182
  const siteRequestTotal = loadBalancers.reduce((sum, item) => sum + item.requests, 0)
  const siteSplit = backend === 'connected'
    ? (siteRequestTotal ? loadBalancers.map((item) => ({ name: item.site, value: Math.round(item.requests / siteRequestTotal * 100) })) : [{ name: '暂无请求', value: 100 }])
    : requestSplit
  const availability = endpoints.length ? healthyCount / endpoints.length * 100 : 0

  return (
    <>
      <PageIntro
        description={backend === 'connected' ? `${loadBalancers.length} 个域名 · ${endpoints.length} 台 VPS。数据来自 Cloudflare 控制面。` : `4 个域名 · 5 个站点 · ${endpoints.length} 台 VPS。当前为本地演示数据。`}
        action={<Segmented values={['1 小时', '24 小时', '7 天']} active={range} onChange={setRange} label="分析时间范围" />}
      />

      <div className="stat-grid">
        <StatCard label="负载平衡请求" value={formatNumber(requestTotal)} detail="过去 24 小时" trend={backend === 'connected' ? undefined : '+8.4%'} tone="blue" />
        <StatCard label="边缘 TTFB 平均值" value={averageTtfb ? `${averageTtfb} ms` : '—'} detail="过去 24 小时采样" trend={backend === 'connected' ? undefined : '-14 ms'} tone="violet" />
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
          <button
            className={button({ intent: 'secondary' })}
            type="button"
            disabled={!ashburn}
            onClick={async () => {
              if (!ashburn) return
              try {
                await toggleEndpointHealth(ashburn.id)
                const recovering = ashburn.state === 'unhealthy'
                recovering ? toast.success(`${ashburn.name} 已恢复`) : toast.warning(`${ashburn.name} 已移出路由`)
              } catch (error) { toast.error(errorMessage(error)) }
            }}
          >
            {ashburn?.state === 'unhealthy' ? `恢复 ${ashburn.name}` : `模拟 ${ashburn?.name ?? '源站'}故障`}
          </button>
        </section>

        <section className="surface request-chart-card">
          <div className="surface-heading chart-title-row">
            <div><span className="section-kicker">{range}</span><h2>负载平衡请求</h2><strong className="hero-metric">{formatNumber(requestTotal)} {backend !== 'connected' && <span>+8.4%</span>}</strong></div>
            <Segmented values={['请求', '错误']} active="请求" onChange={() => undefined} label="请求图表指标" />
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
            <div><span className="section-kicker">性能监控</span><h2>边缘 TTFB</h2><strong className="hero-metric">{averageTtfb ? `${averageTtfb} ms` : '—'} {backend !== 'connected' && <span>-7.1%</span>}</strong></div>
            <button type="button" className="more-button" aria-label="更多 TTFB 选项"><Icon name="more" width={18} height={18} /></button>
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
              <span><strong>{backend === 'connected' ? `${availability.toFixed(1)}%` : '99.98%'}</strong><small>可用性</small></span>
            </div>
            <div className="split-list">
              {siteSplit.map((item, index) => <div key={item.name}><span><i style={{ background: ['#7c3aed', '#2878ff', '#98e900', '#ff9f2e', '#c8cad0'][index % 5] }} />{item.name}</span><strong>{siteRequestTotal || backend !== 'connected' ? item.value : 0}%</strong></div>)}
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
  const monitors = useControlPlane((state) => state.monitors)
  const addMonitor = useControlPlane((state) => state.addMonitor)
  const testMonitor = useControlPlane((state) => state.testMonitor)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name'))
    const next: Monitor = { id: `mon-${Date.now()}`, name, type: String(form.get('type')) as Monitor['type'], path: String(form.get('path')), interval: Number(form.get('interval')), timeout: Number(form.get('timeout')), expected: String(form.get('expected')), pools: 0, state: 'healthy' }
    try {
      await addMonitor(next)
      setOpen(false)
      toast.success(`${name} 已创建`)
    } catch (error) { toast.error(errorMessage(error)) }
  }

  return (
    <>
      <PageIntro description="主动检查源站是否可用；连续 2 次失败标记为不健康，连续 2 次成功后恢复。" action={<button className={button({ intent: 'primary' })} type="button" onClick={() => setOpen(true)}><Icon name="plus" width={17} height={17} />创建监视器</button>} />
      <div className="monitor-grid">
        {monitors.map((monitor) => <section className="surface monitor-card" key={monitor.id}><div className="monitor-top"><span className="monitor-icon"><Icon name="pulse" width={19} height={19} /></span><StatusBadge state={monitor.state} /></div><h2>{monitor.name}</h2><p>{monitor.type} · {monitor.path}</p><div className="mini-kv"><span>间隔<strong>{monitor.interval} 秒</strong></span><span>超时<strong>{monitor.timeout} 秒</strong></span><span>期望<strong>{monitor.expected}</strong></span><span>关联池<strong>{monitor.pools}</strong></span></div><div className="card-actions"><button className={button({ intent: 'secondary', compact: true })} type="button" onClick={() => { toast.promise(testMonitor(monitor.id), { loading: '正在检查源站…', success: (result) => `${monitor.name} 检查成功 · ${result.latencyMs} ms`, error: (error) => errorMessage(error) }) }}>立即测试</button><DeleteResourceButton kind="monitors" id={monitor.id} name={monitor.name} compact /></div></section>)}
      </div>
      <Modal open={open} onOpenChange={setOpen} title="创建监视器" description="定义主动健康检查请求和成功条件。">
        <form className="form-stack" onSubmit={submit}>
          <Field label="名称"><input name="name" required placeholder="HTTPS · Web 健康检查" /></Field>
          <div className="field-row"><Field label="协议"><select name="type" defaultValue="HTTPS"><option>HTTPS</option><option>HTTP</option><option>TCP</option></select></Field><Field label="路径或端口"><input name="path" required defaultValue="/healthz" /></Field></div>
          <div className="field-row"><Field label="检查间隔"><select name="interval" defaultValue="60"><option value="60">60 秒</option><option value="120">120 秒</option><option value="300">300 秒</option></select></Field><Field label="超时"><select name="timeout" defaultValue="5"><option value="3">3 秒</option><option value="5">5 秒</option><option value="10">10 秒</option></select></Field></div>
          <Field label="预期状态码"><input name="expected" required defaultValue="200–299" /></Field>
          <ModalActions onCancel={() => setOpen(false)} submit="创建监视器" />
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
    const next: Pool = { id: `pool-${Date.now()}`, name, description: String(form.get('description')), monitor: String(form.get('monitor')), origins, enabled: true }
    try {
      await addPool(next)
      setOpen(false)
      toast.success(`${name} 已创建`)
    } catch (error) { toast.error(errorMessage(error)) }
  }

  return (
    <>
      <PageIntro description="池将多个源站组成一个可复用的路由目标，并绑定统一的健康监视器。" action={<button className={button({ intent: 'primary' })} type="button" onClick={() => setOpen(true)}><Icon name="plus" width={17} height={17} />创建池</button>} />
      <div className="pool-grid">
        {pools.map((pool) => {
          const monitor = monitors.find((item) => item.id === pool.monitor)
          return <section className={clsx('surface pool-card', !pool.enabled && 'is-disabled')} key={pool.id}><div className="pool-card-top"><div className="pool-emblem"><Icon name="layers" width={20} height={20} /></div><label className="switch-control"><input type="checkbox" checked={pool.enabled} onChange={() => { void togglePool(pool.id).catch((error) => toast.error(errorMessage(error))) }} /><span /></label></div><h2>{pool.name}</h2><p>{pool.description}</p><div className="pool-health-row"><StatusBadge state={pool.enabled ? 'healthy' : 'unhealthy'} /><span>{pool.origins.length} 个源站</span></div><div className="pool-origin-list">{pool.origins.map((originId) => { const origin = endpoints.find((item) => item.id === originId); return origin ? <div key={origin.id}><span className={clsx('status-dot', `is-${origin.state}`)} /><span><strong>{origin.name}</strong><small>{origin.address}</small></span><b>{origin.state === 'healthy' ? `${origin.latency} ms` : '超时'}</b></div> : null })}</div><div className="pool-footer"><span>监视器</span><strong>{monitor?.name ?? '未设置'}</strong><DeleteResourceButton kind="pools" id={pool.id} name={pool.name} compact /></div></section>
        })}
      </div>
      <Modal open={open} onOpenChange={setOpen} title="创建池" description="选择监视器和该池可以使用的 VPS 源站。">
        <form className="form-stack" onSubmit={submit}>
          <Field label="池名称"><input name="name" required placeholder="生产主池" /></Field>
          <Field label="说明"><textarea name="description" required placeholder="该池承载哪些站点和流量" rows={3} /></Field>
          <Field label="监视器"><select name="monitor" defaultValue={monitors[0]?.id}>{monitors.map((monitor) => <option key={monitor.id} value={monitor.id}>{monitor.name}</option>)}</select></Field>
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
  const endpoints = useControlPlane((state) => state.endpoints)
  const addEndpoint = useControlPlane((state) => state.addEndpoint)
  const toggleEndpointHealth = useControlPlane((state) => state.toggleEndpointHealth)
  const mapOrigins = endpoints.map((endpoint) => {
    const [latitude, longitude] = endpoint.coordinates.split(',').map(Number)
    return { endpoint, x: 50 + (longitude + 180) / 360 * 700, y: 30 + (90 - latitude) / 180 * 300 }
  }).filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y))
  const route = mapOrigins.length > 1 ? `M${mapOrigins[0].x} ${mapOrigins[0].y} Q400 105 ${mapOrigins[1].x} ${mapOrigins[1].y}` : undefined

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name')).trim()
    const address = String(form.get('address')).trim()
    const region = String(form.get('region')).trim()
    const latitude = Number(form.get('latitude'))
    const longitude = Number(form.get('longitude'))
    const weight = Number(form.get('weight'))
    const duplicate = endpoints.some((endpoint) => endpoint.address.toLowerCase() === address.toLowerCase())

    if (duplicate) {
      toast.error('该源站地址已经存在')
      return
    }

    const next: Endpoint = {
      id: `origin-${Date.now()}`,
      name,
      address,
      region,
      coordinates: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
      latency: 0,
      weight,
      state: 'healthy',
    }
    try {
      await addEndpoint(next)
      setOpen(false)
      toast.success(`${name} 已添加`, { description: '现在可以在创建池时选择这个源站。' })
    } catch (error) { toast.error(errorMessage(error)) }
  }

  return (
    <>
      <PageIntro description="源站坐标用于邻近感知；访客优先路由到最近的健康端点，并使用 15% 缓冲抑制抖动。" action={<button className={button({ intent: 'primary' })} type="button" onClick={() => setOpen(true)}><Icon name="plus" width={17} height={17} />添加源站</button>} />
      <div className="origin-page-grid">
        <section className="surface proximity-map-card">
          <div className="surface-heading"><div><span className="section-kicker">邻近感知</span><h2>源站地图</h2></div><span className="soft-chip">15% 距离缓冲</span></div>
          <div className="proximity-map" role="img" aria-label={`${endpoints.length} 个源站的邻近路由坐标图`}>
            <svg viewBox="0 0 800 360" preserveAspectRatio="xMidYMid meet">
              <defs><pattern id="coordinate-grid" width="87.5" height="75" patternUnits="userSpaceOnUse"><path className="map-grid-line" d="M87.5 0H0V75" /></pattern></defs>
              <rect className="map-frame" x="50" y="30" width="700" height="300" rx="24" />
              <rect className="map-grid" x="50" y="30" width="700" height="300" rx="24" fill="url(#coordinate-grid)" />
              {route && <path className="route-line" d={route} />}
              {mapOrigins.map(({ endpoint, x, y }) => <g className={clsx('map-origin', `is-${endpoint.state}`)} transform={`translate(${x} ${y})`} key={endpoint.id}><circle r="17" /><circle r="5" /><text x={x > 620 ? -25 : 25} y="5" textAnchor={x > 620 ? 'end' : 'start'}>{endpoint.name}</text></g>)}
              {!mapOrigins.length && <text className="map-empty" x="400" y="180" textAnchor="middle">添加源站后将在这里显示坐标</text>}
            </svg>
            <span className="map-legend"><i />活动路由 <i />健康源站</span>
          </div>
        </section>
        <div className="origin-detail-stack">
          {endpoints.map((endpoint) => <section className="surface origin-detail-card" key={endpoint.id}><div className="origin-detail-heading"><span className={clsx('origin-orb', `is-${endpoint.state}`)}><span /></span><div><h2>{endpoint.name}</h2><p>{endpoint.address}</p></div><StatusBadge state={endpoint.state} label={endpoint.state === 'degraded' && !endpoint.latency ? '待检查' : undefined} /></div><div className="mini-kv"><span>区域<strong>{endpoint.region}</strong></span><span>坐标<strong>{endpoint.coordinates}</strong></span><span>权重<strong>{endpoint.weight}</strong></span><span>延迟<strong>{endpoint.state === 'healthy' ? `${endpoint.latency} ms` : endpoint.state === 'degraded' ? '待检查' : '超时'}</strong></span></div><div className="card-actions"><button className={button({ intent: endpoint.state === 'healthy' ? 'danger' : 'secondary' })} type="button" onClick={async () => { try { await toggleEndpointHealth(endpoint.id); endpoint.state === 'healthy' ? toast.warning(`${endpoint.name} 已移出`) : toast.success(`${endpoint.name} 已恢复`) } catch (error) { toast.error(errorMessage(error)) } }}>{endpoint.state === 'healthy' ? '模拟故障' : '恢复节点'}</button><DeleteResourceButton kind="origins" id={endpoint.id} name={endpoint.name} compact /></div></section>)}
        </div>
      </div>
      <Modal open={open} onOpenChange={setOpen} title="添加源站" description="添加 VPS 的连接地址、地理位置和初始流量权重。">
        <form className="form-stack" onSubmit={submit}>
          <Field label="源站名称"><input name="name" required autoFocus placeholder="Singapore · VPS 3" /></Field>
          <Field label="IP 地址或主机名"><input name="address" required placeholder="203.0.113.10 或 origin.example.com" /></Field>
          <div className="field-row">
            <Field label="区域"><input name="region" required placeholder="Asia Pacific" /></Field>
            <Field label="权重"><input name="weight" type="number" required min="0" max="100" step="1" defaultValue="50" /></Field>
          </div>
          <div className="field-row">
            <Field label="纬度"><input name="latitude" type="number" required min="-90" max="90" step="any" placeholder="1.3521" /></Field>
            <Field label="经度"><input name="longitude" type="number" required min="-180" max="180" step="any" placeholder="103.8198" /></Field>
          </div>
          <p className="form-hint">坐标用于计算访客与 VPS 的距离；正式接入后，保存时会先执行一次健康检查。</p>
          <ModalActions onCancel={() => setOpen(false)} submit="添加源站" />
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
        <section className="surface settings-card"><div className="settings-heading"><div><h2>配置发布</h2><p>先验证，再把版本化快照发布到 KV。</p></div></div><label className="settings-row"><span><strong>发布前健康验证</strong><small>任一池没有健康源站时阻止发布。</small></span><span className="switch-control"><input type="checkbox" defaultChecked /><span /></span></label><label className="settings-row"><span><strong>保留历史版本</strong><small>在 D1 中保存最近 20 个可回滚版本。</small></span><span className="switch-control"><input type="checkbox" defaultChecked /><span /></span></label></section>
        <section className="surface settings-card"><div className="settings-heading"><div><h2>访问控制</h2><p>建议由 Cloudflare Access 保护管理 Worker。</p></div><span className="soft-chip">推荐</span></div><div className="settings-row"><span><strong>Cloudflare Access</strong><small>仅允许指定身份提供商和电子邮件域登录。</small></span><button className={button({ intent: 'secondary', compact: true })} type="button" onClick={() => toast.info('部署阶段将引导配置 Access 策略')}>配置</button></div></section>
      </div>
    </>
  )
}

function DataToolbar({ count, unit, query, setQuery, placeholder }: { count: number; unit: string; query: string; setQuery: (query: string) => void; placeholder: string }) {
  return <div className="data-toolbar"><div><span>总计</span><strong>{count}</strong><small>{unit}</small></div><div className="data-toolbar-controls"><button className={button({ intent: 'secondary', compact: true })} type="button"><Icon name="filter" width={16} height={16} />全部状态</button><label className="search-field"><Icon name="search" width={17} height={17} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} /></label></div></div>
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
