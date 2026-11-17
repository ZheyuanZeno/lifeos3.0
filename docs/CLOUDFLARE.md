# Cloudflare Pages 托管

2026-11-17 AutoSync 第一阶段新增独立 `lifeos-sync` Worker，版本 `05d0b897-9e9e-4f73-a758-74f8575ae6a9`，地址 https://lifeos-sync.lifeos-pocket.workers.dev 。Pages 更新为 `760d0565`，缓存 `lifeos-pocket-0e68ebd15ee8c8ba`，同源新增 `/api/sync/*`，原 MCP / 通知保持。未开通 R2 或付费计划；真实私人空间保持 staging，须完成首次迁移校验后切换。完整数据流、配对、归档及真实测试边界见 [AUTOSYNC-ARCHIVE.md](AUTOSYNC-ARCHIVE.md)。升级前发布及数据备份见 [PRE-AUTOSYNC-ROLLBACK.md](PRE-AUTOSYNC-ROLLBACK.md)。

项目：lifeos-pocket
生产分支标识：main
固定入口：https://lifeos-pocket.pages.dev/pocket/
上传目录：release/site

已通过用户在 Cloudflare 官方页面确认的 OAuth 授权。通知部署后范围为 account:read、user:read、pages:write、workers:write、workers_scripts:write 和自动附加的 offline_access。脚本权限必须单独申请，仅 workers:write 实测无法部署脚本或读取 Workers 子域名。没有把 Cloudflare 密钥加入前端或 Git。当前会话使用官方 Wrangler。

## Windows 当前工作环境

Wrangler：E:/Codex/tools/cloudflare/node_modules/.bin/wrangler.cmd
授权配置目录：E:/Codex/cloudflare-config（在仓库之外）
所有工程、浏览器缓存和构建包均在 E 盘。

~~~powershell
Set-Location E:\Codex\lifeos2.0
$env:TEMP='E:\Codex\tmp'
$env:TMP='E:\Codex\tmp'
$env:XDG_CONFIG_HOME='E:\Codex\cloudflare-config'
$env:WRANGLER_SEND_METRICS='false'
npm.cmd run package:pocket
& 'E:\Codex\tools\cloudflare\node_modules\.bin\wrangler.cmd' pages deploy release/site --project-name lifeos-pocket --branch main
~~~

首次创建项目时，Wrangler 4.162 将新纯静态项目自动引导到 Workers；当前仅授权 Pages，因此已明确使用 Pages 创建命令的 --force 选项建立 Pages 项目。该选项在此命令里用于选择 Pages 服务，不是强制覆盖文件。项目已存在，之后正常 pages deploy 即可。

## 发布边界

Pages 托管 Pocket 程序资源与通知同源转发接口，不上传 SQLite、JSON 备份、照片或语音。通知 Worker 只保存计划提醒元数据与设备推送订阅，详见 NOTIFICATIONS.md；业务记录和媒体同步仍使用 Google Drive，手机以 IndexedDB 为资料源。

发布后应验证固定地址与所有资源返回 200、JS 与本地构建哈希相同，并在真实浏览器执行首次缓存、断网关闭页面后重开及文字保存。实际 iPhone 主屏幕验证仍需用户操作。

Cloudflare Pages 将 /pocket/index.html 重定向到 /pocket/；Service Worker 应预缓存规范地址 /pocket/，避免将带重定向标记的响应作为离线导航响应。构建缓存版本同时包含资源和构建脚本指纹，确保 Service Worker 修改也能触发更新。纯静态冒烟测试模拟这个重定向。

## 历史发布记录（AI Docs Bridge）

部署 ID：0dd1f3a1
发布时源码提交：8ea650c（公开 3.0 仓库对应 e858d3c，AI Docs Bridge v1）
固定网址：https://lifeos-pocket.pages.dev/pocket/

通知后台：https://lifeos-pocket-notify.lifeos-pocket.workers.dev
后台当前版本：8878139d-5c15-4314-91b7-2162c7597f54（沿用既有 VAPID 和设备签名密钥）。Workers 子域名为 lifeos-pocket.workers.dev；应用通过 Pages 同源 /api/notify/* 调用，用户无需访问该后台域名。后台绑定 SQLite Durable Object REMINDERS / ReminderHub，保留免费计划，未启用付费升级。

Pages 配置 NOTIFY_BACKEND 指向后台；后台三项 VAPID/设备签名密钥从 E:/Codex/notify-config/worker-secrets.json 上传，私钥从未进入仓库、前端或发布包。应用缓存版本 lifeos-pocket-2097220f4aa120a2。桌面 Python 转发显式使用 LifeOSDesktop/1.0 请求标识，修复 Cloudflare 对 Python 默认 UA 返回 1010 的兼容问题。

线上首次安装复核修复了首次 SW 接管时的多余刷新，以及未授权即查询原生推送订阅导致部分 WebKit 运行时卡住的问题。现在仅在 Notification.permission 为 granted 时读取订阅；用户点击开启仍直接调用 subscribe 保留手势。原生 WebKit 最小复现曾在默认权限下等待超过 15 秒，修复后原生首次安装、通知未授权时离线记录和两引擎生产 HTTPS 离线冷启动均通过。

当前部署新增计划时间后台通知、每设备开启/关闭/测试通知、与 Google 短期 token 独立的通知设备凭证、完成/删除/改时后的因果合并调度及通知点击打开计划编辑。保留固定项目统一等高、历史日期栏、可选 DDL 和分钟时间、共享计时、计划多段计时与显式完成、长按排序、备注、自适应弹窗、语音及 Google Drive 媒体传输。公开 Web 客户端 ID 保留，首次关联通知设备仍需先连接 Google，每台接收设备自行授予系统通知权限。

已验证通知同源 /config 返回 ready:true，未授权 /status 返回 401、跨站 /state 返回 403；电脑 8771 的同源转发返回 ready:true 并拒绝跨站写入。真实 iPhone 通知弹窗与 APNs 收件需用户从主屏幕开启并发送测试通知后验收。

本次发布已验证：10 个入口/资源 HTTP 200，app.js 与 sw.js 线上 SHA-256 和本地构建一致，Chromium 与 WebKit HTTPS 离线冷启动、离线新增计划/刷新恢复/勾选完成及文字保存。

本次另已验证：触摸视口和键盘切页后，三栏内容区均无焦点外框；按钮的键盘焦点轮廓保留。

## 3.0 手动同步发布

Google Drive 现在只有点击“立即同步”才执行，连接仅授权；空闲、保存、回前台和恢复网络不再发起 Drive 交换。通知投影独立更新，原站点、通知后台与数据库保持。完整 70 项浏览器回归通过；生产资源与本地 app.js/sw.js 哈希一致，两种引擎的 HTTPS 离线重开、计划和随手记验证通过。新源码仓库为 ZheyuanZeno/lifeos3.0，标签 v3.0.0；初始私有发布后，所有者要求改为公开源码，最新阅读入口见 README 和 docs/CHATGPT-ACCESS.md。

## 后台流程发布（历史，现已取消）

新增当前活动与后台流程并行、阶段配置、真实处理时间线、人工投入与历时分离及独立阶段通知。先部署兼容旧计划的 Worker，再发布 Pages；地址及设备凭证不变。Wrangler 实际 Worker 构建包通过 workerd 定时加密推送测试。发布后 10 个入口资源 HTTP 200，线上 app.js/sw.js SHA-256 与受测包一致；Chromium/WebKit 均通过生产 HTTPS 创建洗衣流程、洗涤等待同时计时学习、离线关闭重开及去处理阶段，也复核普通计划与随手记离线保存。测试使用隔离浏览器上下文，不向个人数据库写测试事项。电脑 8771 更新前保存 SQLite 一致性备份，更新后六张原表逐行摘要相同且 integrity_check=ok；转发 ready:true。新增阶段的手机系统通知实收仍需用户确认。

## 取消后台流程与多项目计时

按用户要求取消后台流程界面和阶段提醒，固定项目与计划现在可同时运行，各自暂停、备注、结束及完成。旧流程显示为普通计划，历史保留。先发布 Worker 取消阶段调度，再发布 Pages；原计划通知及设备凭证保持，旧提醒投影字节保留以兼容操作 ID 重放。线上 10 个资源 200、JS/SW 哈希与受测包一致，Chromium/WebKit 验证三个计时、暂停独立性、320px、离线冷启动及完成单个计划不影响其他任务。电脑版直接读取同一受测静态包，无需重启；SQLite 一致性备份和六张表摘要一致性检查通过。完整规则见 MULTI-TIMER.md。

## AI Docs Bridge 发布

新增设置页私人 Docs Inbox/Context、独立 drive.file 授权、JSON 离线导入与人工审核、版本前置条件及稳定来源 ID 去重，保持手动业务同步、多计时器和通知。Python 与静态包 CSP 仅补充 docs.googleapis.com；通知后台无需变更。生产 10 个资源 200、JS/SW 哈希一致；Chromium/WebKit 线上使用隔离浏览器验证离线 JSON 审核/写入/重复跳过/冷启动和两个计时器保留，未读取真实 Google 或 Canvas 数据。真实账号需启用 Docs API，并完成 AI-BRIDGE.md 中手工验收。电脑更新前备份、更新后六张 SQLite 表摘要完全相同。

## 原生 MCP 独立服务

`workers/mcp/wrangler.jsonc` 部署 lifeos-mcp，地址 https://lifeos-mcp.lifeos-pocket.workers.dev/mcp 。官方 OAuth Provider 使用 OAUTH_KV，HUB 为 SQLite Durable Object；不改通知 Worker，不新增付费计划。Pages `/api/mcp-device/*` 和电脑同源转发仅允许固定设备路由，不开放免认证业务工具。首次绑定证明 Google 账号，之后使用独立可撤销设备凭证。详情见 [REMOTE-MCP.md](REMOTE-MCP.md)。

当前 MCP 发布版本：40a59bb4-5ff7-4a34-9710-2aa4506d3bfc；Pages 原生连接发布：59d24e86；缓存 lifeos-pocket-d30f43f6d8b326d8。真实根入口、OAuth 发现、动态注册与同意页可达，未授权 MCP 401；Pages/电脑设备接口未授权401、跨站403。真实账号授权后的工具调用与 Claude 客户端待用户首次配对验收。

完整业务访问沿用原HUB的SQLite，只增加已授权的分页业务副本与附件分片表，不新增云主库或付费资源；设备同源路由新增business/media，均验证设备令牌，MCP仍验证OAuth完整scope。文件没有公开下载URL，撤销会清除相应云端缓存。见 [FULL-AI-ACCESS.md](FULL-AI-ACCESS.md)。
