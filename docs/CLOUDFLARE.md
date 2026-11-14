# Cloudflare Pages 托管

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

## 当前发布记录

部署 ID：fbd10c59
发布时源码版本：v3.0.0
固定网址：https://lifeos-pocket.pages.dev/pocket/

通知后台：https://lifeos-pocket-notify.lifeos-pocket.workers.dev
后台当前版本：2bd09ae3-3eca-47c8-9648-79cbc1366e75（上传代码后配置服务密钥）。Workers 子域名为 lifeos-pocket.workers.dev；应用通过 Pages 同源 /api/notify/* 调用，用户无需访问该后台域名。后台绑定 SQLite Durable Object REMINDERS / ReminderHub，保留免费计划，未启用付费升级。

Pages 配置 NOTIFY_BACKEND 指向后台；后台三项 VAPID/设备签名密钥从 E:/Codex/notify-config/worker-secrets.json 上传，私钥从未进入仓库、前端或发布包。应用缓存版本 lifeos-pocket-984844ed877a1a2d。桌面 Python 转发显式使用 LifeOSDesktop/1.0 请求标识，修复 Cloudflare 对 Python 默认 UA 返回 1010 的兼容问题。

线上首次安装复核修复了首次 SW 接管时的多余刷新，以及未授权即查询原生推送订阅导致部分 WebKit 运行时卡住的问题。现在仅在 Notification.permission 为 granted 时读取订阅；用户点击开启仍直接调用 subscribe 保留手势。原生 WebKit 最小复现曾在默认权限下等待超过 15 秒，修复后原生首次安装、通知未授权时离线记录和两引擎生产 HTTPS 离线冷启动均通过。

当前部署新增计划时间后台通知、每设备开启/关闭/测试通知、与 Google 短期 token 独立的通知设备凭证、完成/删除/改时后的因果合并调度及通知点击打开计划编辑。保留固定项目统一等高、历史日期栏、可选 DDL 和分钟时间、共享计时、计划多段计时与显式完成、长按排序、备注、自适应弹窗、语音及 Google Drive 媒体传输。公开 Web 客户端 ID 保留，首次关联通知设备仍需先连接 Google，每台接收设备自行授予系统通知权限。

已验证通知同源 /config 返回 ready:true，未授权 /status 返回 401、跨站 /state 返回 403；电脑 8771 的同源转发返回 ready:true 并拒绝跨站写入。真实 iPhone 通知弹窗与 APNs 收件需用户从主屏幕开启并发送测试通知后验收。

本次发布已验证：10 个入口/资源 HTTP 200，app.js 与 sw.js 线上 SHA-256 和本地构建一致，Chromium 与 WebKit HTTPS 离线冷启动、离线新增计划/刷新恢复/勾选完成及文字保存。

本次另已验证：触摸视口和键盘切页后，三栏内容区均无焦点外框；按钮的键盘焦点轮廓保留。

## 3.0 手动同步发布

Google Drive 现在只有点击“立即同步”才执行，连接仅授权；空闲、保存、回前台和恢复网络不再发起 Drive 交换。通知投影独立更新，原站点、通知后台与数据库保持。完整 70 项浏览器回归通过；生产资源与本地 app.js/sw.js 哈希一致，两种引擎的 HTTPS 离线重开、计划和随手记验证通过。新源码仓库为 ZheyuanZeno/lifeos3.0，私有发布，标签 v3.0.0。
