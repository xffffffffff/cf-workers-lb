# Worker LB

Worker LB 是部署在 Cloudflare Workers 上的自托管 HTTP/HTTPS 负载平衡器。提供 WebUI、管理 API、主动健康检查和边缘流量转发，使用 D1 保存配置与历史、KV 保存已发布的热配置快照。

> 这不是 Cloudflare 官方 Load Balancing 产品，也不使用其付费模板源码。它适合希望自行承担运维与免费额度约束的站点。

## 一行安装

从 GitHub 拉取并安装，同时自动绑定 WebUI 管理域名：

```bash
git clone https://github.com/xffffffffff/cf-workers-lb.git && cd cf-workers-lb && ./install.sh --admin-host lb.example.com
```

将 `lb.example.com` 替换为你自己的管理子域名。脚本会通过 Worker Custom Domain 自动创建 DNS、签发证书并绑定 WebUI/API，同时检查 Node.js/npm/Wrangler 登录、构建项目、创建 D1 和 KV、执行 migrations、部署单 Worker、配置每分钟 Cron，并生成管理令牌、会话保持密钥和 Token 加密密钥。安装时不需要填写业务域名。

管理域名必须属于当前 Cloudflare 账号下的活动 Zone，且不应复用已有站点记录。如果不需要自定义管理域名，可省略 `--admin-host` 并使用 Wrangler 输出的 `workers.dev` 地址。管理域名不能再添加为负载平衡业务域名。

也可使用 Cloudflare API Token 非交互安装：

```bash
git clone https://github.com/xffffffffff/cf-workers-lb.git && cd cf-workers-lb && CLOUDFLARE_API_TOKEN=部署令牌 ./install.sh --admin-host lb.example.com
```

若已配置 Cloudflare Access：

```bash
git clone https://github.com/xffffffffff/cf-workers-lb.git && cd cf-workers-lb && ./install.sh --admin-host lb.example.com --access-team-domain team.cloudflareaccess.com --access-aud YOUR_ACCESS_AUD
```

安装结束会显示 WebUI 管理地址和一次性的管理令牌。未使用 Access 时，在 WebUI 首次打开的连接窗口输入管理令牌；它只保存在当前标签的 `sessionStorage`。本地生成的资源 ID、令牌和密钥文件均已加入 `.gitignore`；请像密码一样保护 `.wrangler.generated.secrets`。

首次进入 WebUI 后，在“设置 → Cloudflare API 连接”中获取并填写一个受限 API Token。它需要 `Zone Read`、`DNS Edit`、`Workers Routes Edit` 权限。Token 通过 HTTPS 提交，由安装时生成的 AES-GCM 密钥加密后存入 D1；WebUI 和 API 不会返回明文。

如果已有域名通过 WebUI 接入，系统会阻止清除 Token。请先删除对应负载平衡器，让系统用当前 Token 清理 Worker Route，再清除 Token。

重复运行安装命令会复用已经创建的 D1/KV 和密钥，并自动沿用上次的管理域名。如需更换，再次传入 `--admin-host new.example.com`；如需解除管理 Custom Domain，使用 `--no-admin-host`。

如果资源已在 Cloudflare 创建，但安装在写入本地资源 ID 前中断，重新运行脚本会按精确名称找回并复用这些资源。也可通过 `WORKER_LB_DB_ID` 和 `WORKER_LB_KV_ID` 显式指定已创建的资源。同一克隆目录重新运行时必须使用相同的 `--name`；如需另一套资源，请使用新的克隆目录。

更新已经克隆的项目：

```bash
cd cf-workers-lb && git pull --ff-only && ./install.sh --admin-host lb.example.com
```

## 首次配置顺序

1. 在“设置”添加 Cloudflare API Token。
2. 在“源站”添加 VPS，优先使用专用源站主机名。
3. 创建 HTTPS/HTTP/TCP 监视器；需要虚拟主机时，在该监视器中填写对应站点的 `Host`，也可配置端口、请求方法、附加请求头和跳转策略。
4. 创建池并选择源站、监视器。
5. 等待 Cron 至少完成两次健康检查。
6. 创建负载平衡器。系统会自动创建或检查橙色云 DNS，并把精确主机名 Route 绑定到当前 Worker。
7. 点击“发布配置”。健康源站数不足时，系统会阻止发布。

源站主机名不能与负载平衡器主机名相同，否则会产生回环。WebUI 只为创建的负载平衡器生成精确主机名 Route。监视器的 `Host` 和负载平衡器的“源站 Host”都是逐项配置，不存在内置站点域名。未配置自定义 Host 的 HTTPS 源站必须具有与连接地址匹配的有效证书；实际部署更推荐 `origin.example.com` 形式的专用 DNS 名称。

Cloudflare Workers 不会可靠地转发手动改写的 `Host`。因此使用自定义 Host/SNI 时，还要在对应源站填写“连接主机名”：它应是同一 Cloudflare Zone 下、开启代理且指向该 VPS 的专用 DNS 名称，例如 `origin-1.example.com`。Worker 会保留监视器或业务站点的 Host/SNI，并通过 `resolveOverride` 定向连接该源站。该字段也不包含任何预设域名。

## 架构

- `workers/unified`：唯一部署入口。`workers.dev` 和指定管理域名只进入 WebUI/API，业务域名只进入转发路径；Cron 事件进入健康检查模块。
- `workers/traffic`：内部流量模块，只读取 KV 活动快照；按健康状态、池优先级、权重、延迟或距离选择源站。支持签名 Cookie 会话保持。GET/HEAD 遇到连接错误或 500/502/503/504 时最多重试另一个源站一次；POST 等非幂等请求不重试。
- `workers/control`：内部管理模块，负责资源 CRUD、Token 加密、Cloudflare DNS/Route、依赖保护、发布、配置历史和回滚。支持 Cloudflare Access JWT 或管理 Bearer token。
- `workers/health`：内部健康模块，每分钟由同一个 Worker 的 Cron 唤醒。默认连续失败 2 次 Down、连续成功 2 次恢复。
- D1：草稿配置、关系、健康状态/历史、事件日志和配置版本。
- KV：唯一的活动配置快照。流量模块使用最多 5 秒 isolate 内存缓存；KV 的全球最终一致性仍可能带来额外传播延迟。

流量路径启用 `passThroughOnException()`：读取活动配置发生未处理异常时，Worker Route 会回退到该 DNS 记录原本指向的源站。WebUI 新建 DNS 时使用所选池的第一台启用源站作为保底地址。

正常请求默认只向 D1 采样 1%，故仪表台请求数是采样估算值；故障转移和 5xx 会强制记录。可在生成的统一 Wrangler 配置中调整 `REQUEST_LOG_SAMPLE_RATE`。

## 删除安全

负载平衡器、监视器、池和源站均可在 WebUI 删除，删除前会二次确认。依赖关系采用外键及 API 双重保护：

- 源站仍属于某个池时不可删除。
- 监视器仍被池使用时不可删除。
- 池仍被负载平衡器使用时不可删除。

应按“负载平衡器 → 池 → 监视器/源站”的顺序删除。删除只改变 D1 草稿；重新发布前，KV 中的线上活动配置保持不变。

## 本地开发

```bash
npm install
npm run build
npm run db:local:migrate
npm run dev:cloudflare
```

Wrangler 默认打开 `http://localhost:8787`。本地配置将 `ENVIRONMENT` 设置为 `development`，仅本地模式跳过管理鉴权。`npm run dev` 仅启动 Vite 前端服务，因无 Worker API 而会显示控制面未连接，不会注入假数据。

## 验证

在本地 Worker 运行时启动后执行：

```bash
npm run test:api
```

测试覆盖资源创建、状态读取、依赖删除拦截、发布健康校验以及按正确顺序删除。完整静态验证：

```bash
npm run check
npm run build
bash -n install.sh scripts/install.sh
```

## 免费额度注意事项

- Workers 免费请求额度由账号下所有 Worker 合计使用，并非每个域名单独计算。安装前请以 Cloudflare 当前套餐页面显示的额度为准。
- D1、KV、Cron、子请求和 CPU 也分别受当前套餐限制；高流量、严格 SLA 或多地域独立探针不适合只依赖免费计划。
- Cron 在 Cloudflare 单一调度环境发起检查，不能完全复现官方 Load Balancer 的多地域健康探针。
- KV 是最终一致的。请求时被动重试用于覆盖健康状态传播窗口，但不会重试非幂等请求。

## 开源许可

本项目基于 [MIT License](./LICENSE) 开源。

## 目录

```text
migrations/             D1 schema
scripts/install.sh      Cloudflare 自动安装器
src/                    React WebUI
tests/api-e2e.mjs       管理 API 集成测试
workers/control/        管理 API + 静态 UI
workers/health/         Cron 主动健康检查
workers/shared/         共享模型、探测器、快照构建
workers/traffic/        请求路径负载平衡
workers/unified/        唯一 Worker 部署入口
wrangler.local.toml     本地开发配置
```
