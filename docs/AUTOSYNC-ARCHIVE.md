# AutoSync & Desktop Archive：第一阶段

真实个人空间仍不得在迁移门槛通过前切换；代码部署与个人数据迁移是两件事。升级前回退点见 [PRE-AUTOSYNC-ROLLBACK.md](PRE-AUTOSYNC-ROLLBACK.md)。最终部署与验收结果见文末交付记录。

历史录音迁移卡住的问题已修复，最新流程与用户重试步骤见 [MEDIA-MIGRATION-FIX.md](MEDIA-MIGRATION-FIX.md)。迁移准备授权只允许开始补传，不等于完整校验通过。

## 架构与数据职责

PWA 继续使用 Vanilla TypeScript、Dexie 和原 `lifeos-pocket-v1` IndexedDB，数据库版本仍为 5。`repository.ts` 继续事务保存业务记录与因果操作，`merge.ts`、多计时器、MCP 收件与通知投影不更换。新传输实现 `SyncTransport`，操作批次沿用 protocol 1；`cf-sync-v1:<space-id>` 的确认、文件、待上传批次及游标与 Drive 的 OAuth 应用/账号命名空间完全分开。

独立 `lifeos-sync` Worker 只处理签名设备请求、不可变操作批次、媒体分片、游标及归档收据。它使用独立 SQLite Durable Object，既不是 MCP 的业务查询投影，也不替代本地业务数据库。原 MCP 和通知 Worker 不需要迁移。站点和本机 Python 各有固定目的地的同源转发，不开放任意 URL 代理。

新传输先读取并校验操作历史，再同步所有历史媒体，最后上传本机操作。媒体范围包括已删除记录的旧附件、操作历史引用及独立存储的媒体，不只扫描可见随手记。已确认的远程媒体用独立游标增量下载。32 MiB 是单个历史媒体传输上限；前台录音仍维持原 4 MiB 限制。超限会停止并提示，不会丢弃原文件。

## 设备与身份

PWA 生成不可导出的 P-256 WebCrypto 私钥，保存在原数据库的本地状态中，不进入 JSON 备份。每个请求签署空间、设备、动作、时间、随机数和原始请求体 SHA-256。服务器验证五分钟时间窗口并拒绝重放。设备身份不依赖 Google access token，也不隐式继承 Google 账号或 AI 的访问权限。

创建空间需要仅保存在部署机外部配置目录的初始化凭证。配对使用 256 位请求编号、256 位一次性秘密、设备公钥指纹以及已授权管理设备批准，十分钟过期；普通设备不能自行批准新设备。已撤销设备不能继续请求。恢复凭证为独立 256 位随机值，导出时使用 PBKDF2-SHA256（600000 次）和 AES-GCM 加密；密码和明文恢复凭证不上传服务器。浏览器站点数据被系统清除后，需要重新配对或使用恢复文件，而不能假定 WebCrypto 私钥仍在。

Windows 归档私钥和恢复凭证由当前 Windows 用户的 DPAPI 加密保存在仓库外的 vault。Ubuntu 采用权限为 0600 的私人文件；不要把凭证放进公开仓库、普通媒体或共享备份。

设备可以撤销自己，管理设备也可以撤销其他设备；服务器防止直接撤销最后一个管理身份。PWA 的“解除本设备绑定”只撤销同步凭证并删除对应本地密钥，不删除任何业务记录、媒体、操作日志或旧 Drive 配置。恢复文件可从 Windows 执行 `--export-recovery <新文件> --password-file <私人密码文件>` 导出；新 PWA 在“使用恢复文件”中自行解密。恢复后应撤销丢失设备；恢复凭证轮换接口为 `recovery/rotate`，须同步更新并妥善保存新的加密恢复文件。

## 自动同步行为

只有空间变为 active 后才启用日常自动同步：冷启动、本地业务变化后 1.2 秒防抖、联网恢复、回到前台，以及前台 45 秒补偿轮询。后台故障按指数退避和随机抖动重试，最长五分钟。保存和计时始终先落本机，不等云端。同步时用 Web Locks；不支持时用 IndexedDB 事务租约协调同源标签页。不可变上传预先持久化文件 ID、批次正文和 SHA，丢失成功响应后重用同一批次。

iOS 完全关闭 PWA 时不能执行同步或归档。重新打开并联网后补领全部未读历史。没有“只保留七天”的限制。原 Google Drive 仍是手动备用渠道；新增控制器不自动调用其 `syncNow()`，Drive 的确认也不计作 Cloudflare 确认。

## Windows 永久归档

用户已选择 Windows 为主归档，现有资料目录保留为 `E:/Codex/data/lifeos-recovered-20261114`。`archive_agent.py` 使用独立 Python 环境及 `requirements-archive.txt`；不要求浏览器保持开启。

Agent 双向同步电脑本地操作及所有合规附件；收到批次后验证原始 SHA、保存原始批次文件、校验媒体、通过 `pocket_sync.preview` 和原 `app.save(remote=...)` 合并。HTTP 白板与 Agent 使用同一跨进程目录写入锁。SQLite 使用 FULL synchronous，业务提交后才保存持久收据，再检查 SQLite 和执行 fsync，最后发送包含全部已归档事件摘要的 archive ACK。业务提交后进程崩溃但尚未确认游标时，同一操作可安全重放。

备份使用 SQLite backup API，并复制所有媒体及 SHA 清单。旧备份保留；第一阶段不自动裁剪历史、操作、媒体或备份。磁盘满、云端满或媒体校验失败时停止确认，原本地资料仍在。

逻辑归档编号、存储编号、操作系统、主机及绝对资料路径一起约束唯一归档。复制整个目录到另一系统不会自动获得第二个“权威归档”身份；更换主归档需要明确恢复与服务器 rebind。Ubuntu 默认使用独立本地资料目录并设置 `primary:false`，作为普通客户端；不在两边自动打开同一份 NTFS SQLite，也不替 Windows 发送 archive ACK。

## 首次迁移操作

1. 保留升级前标签、源码包、发布包、SQLite 和媒体备份；先前已完成，见回退文档。
2. 在所有现有设备最后手动执行一次 Google Drive 同步，确认计划、笔记、完整历史和录音均收敛。不得仅凭电脑已有部分数据宣称收集完整。
3. 在 Windows 创建 staging 空间，参数中的配置、vault 和初始化凭证均留在仓库外：

~~~powershell
E:/Codex/venvs/lifeos-archive/Scripts/python.exe lifeos/archive_agent.py --config E:/Codex/archive-config/lifeos.json --init --data-dir E:/Codex/data/lifeos-recovered-20261114 --bootstrap-file E:/Codex/sync-config/bootstrap.txt
E:/Codex/venvs/lifeos-archive/Scripts/python.exe lifeos/archive_agent.py --config E:/Codex/archive-config/lifeos.json --status
~~~

4. 将 status 返回的非秘密 `space_id` 填入两台 PWA“设置 → 自动同步”，各自申请配对，将完整配对 JSON 保存在 E 盘临时文件。核对指纹后用 `--approve-pair <文件>` 批准；只为明确指定的管理设备额外加 `--owner`。各设备再点“完成绑定”。不要将配对 JSON 发到公开 issue。
5. 运行 Agent 一次并备份，确认无错误；再启动长期归档。首次运行会上传本机全部操作与媒体，必须先完成第 2 步。

~~~powershell
E:/Codex/venvs/lifeos-archive/Scripts/python.exe lifeos/archive_agent.py --config E:/Codex/archive-config/lifeos.json --backup
E:/Codex/venvs/lifeos-archive/Scripts/python.exe lifeos/archive_agent.py --config E:/Codex/archive-config/lifeos.json --once
~~~

6. 两台 PWA 各自确认迁移来源完整，下载备份并校验当前清单。每次备份包含全部操作和媒体，不包含私钥。
7. 等 Agent 对当前云端 head 完成归档，再由管理设备点击“正式切换”，或在 Windows 执行 `--activate`。服务器强制要求当前 archive ACK 与至少两台 PWA 当前 head/清单一致；新增数据使旧核验失效时重新核验。
8. 通过 `scripts/install-archive-windows.ps1 -ConfigPath ...` 注册当前用户登录后隐藏自启；`-Remove` 可撤销。Ubuntu 的 systemd --user 示例见 `scripts/lifeos-archive.service.example`，普通客户端配置必须为 `primary:false`，先通过管理设备批准自己的独立身份。

Windows 的 staging 配置、私人 DPAPI vault 和登录自启项已创建，不应重复执行 `--init`。电脑 Pocket 的“Windows 归档管理”显示本机空间编号，并可粘贴手机的配对 JSON、核对指纹、通过本机凭证批准。请只为自己选定的管理设备勾选管理权限。PWA 先保存迁移前备份、提供明确的旧渠道收敛与补传授权，再发送 migration/prepare；Agent 先生成电脑备份后开始贡献原件，不再等待 PWA 完整核验才上传。完整切换条件保持不变。

Ubuntu 独立客户端可用 `--pair-space <空间编号> --ordinary --data-dir <Ubuntu自己的目录> --pair-output <私人临时JSON> --config <新配置>` 申请配对，通过管理设备批准后用 `--claim` 领取身份，再安装 systemd --user 示例。不把 Windows 数据库的路径直接填进 Ubuntu 普通客户端配置。

## 七天以上断网验收

在设备 A 离线新增不同日期计划、随手记、录音并运行两个计时器；设备 B 同期编辑其他字段并完成部分计时。A 关机超过七天的等效测试使用历史时间戳与保持不变的游标，不删除云端事件。恢复联网后前台补领，核对稳定 ID、因果冲突保留、并行计时及全部媒体 SHA。关闭浏览器后由 Agent 独立归档；检查 `sync-archive/status.json`、SQLite 收据、原始批次和备份。不能把模拟历史时间戳说成真的连续关机七天。

## 免费额度及容量边界

使用 SQLite DO 免费计划，不启用 R2 订阅或 Workers 付费升级。[官方价格](https://developers.cloudflare.com/durable-objects/platform/pricing/)列出每日 100000 次请求、5000000 行读取、100000 行写入及合计 5 GB 免费存储；[官方限制](https://developers.cloudflare.com/durable-objects/platform/limits/)规定免费单个 SQLite DO 上限 1 GB。此服务按 SQLite 实际数据库大小在 768 MiB 处保护停止新增大内容，为索引等保留余量。每日限额或单空间上限不是无限云盘承诺；达到限制时保留本地数据，不裁剪历史，也不自动开通收费。

R2 的[开通流程](https://developers.cloudflare.com/r2/get-started/)需要订阅/结算配置，其免费量并非保证永不收费的硬上限。因此本阶段使用 DO 分片，不启用 R2；未来超出保护容量时需另行决定存储方案。

免费用量与原 MCP、通知等服务按账号共享，不能为每个 Worker 各算一整份账户额度。清单摘要按云端 head 缓存；已确认媒体不每轮重复上传/回读，空闲轮次不重复写归档回执。超过免费请求或行操作额度时，服务仍可能暂时不可用；客户端保留待上传数据并退避，不自动开通付费。

## 同步接口和主要修改文件

所有接口为固定源 `/v1/<action>` POST，PWA 通过同源 `/api/sync/<action>` 调用。业务写入仍经过原 repository 或 Python 合并入口；这些接口不提供 SQL 或任意脚本执行。

|接口|用途|
|---|---|
|create、status、manifest|受初始化凭证保护的空间创建、状态与完整清单|
|pair/request、pair/approve、pair/claim|公钥配对、管理设备批准、一次性领取|
|recover、recovery/rotate、device/revoke|强恢复凭证、凭证轮换、设备撤销|
|batch/put、batch/get、changes|不可变批次、回读 SHA、固定 head 的增量分页|
|media/status、media/begin、media/put、media/commit、media/get|稳定文件 ID、可续传分片、完整 SHA 校验|
|cursor/ack|设备的单调确认游标|
|archive/register、archive/rebind、archive/ack|唯一主归档身份、显式恢复换绑、持久清单回执|
|migration/prepare、migration/verify、activate|备份后允许补传、本机完整清单校验、双 PWA 与归档切换门槛|

主要文件：`workers/sync/src/index.ts` 与配置；`sync/{protocol,identity,cloudflare,auto-controller,auto-ui}.ts`；原 `sync/{engine,types}.ts`、`main.ts` 和 `media.ts`；`functions/api/sync/[[path]].ts`；`lifeos/{archive_agent,data_lock,sync_proxy}.py` 和原 `app.py`；`requirements-archive.txt`；Windows 自启脚本与 Ubuntu 服务示例；`scripts/test-sync-worker.mjs`、同步客户端/身份/归档与浏览器测试；本说明、架构、README、交付和回退文档。数据库名称、所有用户业务 ID、旧备份协议及原合并规则保持。

## 数据恢复

恢复前停止白板和 Archive Agent，并先另存当前数据库、全部媒体与 `sync-archive` 元数据。备份目录包含 SQLite、一份附件目录和 SHA 清单，先验证 `PRAGMA integrity_check`、数据库 SHA 和每个媒体 SHA，再恢复到新的私人目录做检查。不能在有更新记录的正式目录上直接覆盖旧库；优先通过操作合并补回历史。

同机同路径恢复且旧身份/vault 完整时可沿用原逻辑归档；更换路径、主机或操作系统时，Agent 会拒绝自动沿用旧存储身份。必须先将新归档设备作为 owner 批准，再由管理设备调用 `archive/rebind`，提供原 archive_id、新 storage_id、操作系统、目标设备与 `confirm_restore:true`；归档游标归零后重新读取验证全部历史。它不会删除服务器历史。PWA 恢复身份并不自动把它变成主归档服务器。

CLI 提供 `--rebind-archive --confirm-restore`：在已经批准的 archive owner 配置上执行，先检查恢复目录的 SQLite 和备份 SHA 清单，保留旧身份元数据，再显式换绑并标记下一轮从零复核全部原始批次和媒体。原 SQLite 收据不会被当作原始文件已经恢复的证明；只有重新持久化验证后才再次 ACK。备份清单保存非秘密的 space_id / archive_id，帮助避免把另一个空间的备份误作当前归档。

## 验证记录与待验收

已通过 144 项 TS 单元测试、22 项 Python 测试、类型检查，以及真实本地 workerd 的签名/重放/隔离/配对/撤销/恢复、不可变批次、分页、媒体断点与 SHA、唯一归档及双设备迁移门槛测试。另通过两份真实 Dexie 客户端与 workerd 的并行计时、历史媒体、命名空间及旧备份往返；Python 与 workerd 的签名互通、原始批次持久化、归档 ACK、完整备份和显式换绑恢复后强制重放测试。数据均为临时夹具。

Chromium / WebKit 完整回归 88 项通过；最终同步渠道隔离与新绑定/离线补传专项 8 项通过。线上 10 个入口和资源 HTTP 200，app.js 与 sw.js SHA 和本地发布包一致；两引擎真实 HTTPS 离线重开、计划新增/完成及随手记保存通过。

真实 iPhone 站点保留、Android 后台限制、Windows 重启后的自启、Ubuntu 实机、真实私人媒体完整性以及实际七天停机仍不能用 Mock 或桌面 WebKit 测试代替。当前 Windows 的登录自启项已安装、隐藏进程已运行并显示 migration_waiting，尚未重启操作系统验收。未通过迁移条件前，不宣称已完成个人空间的无感同步。

## 本次实际交付与线上验收

- Sync Hub：https://lifeos-sync.lifeos-pocket.workers.dev ，签名接口前缀 `/v1/`；Worker 版本 `05d0b897-9e9e-4f73-a758-74f8575ae6a9`。
- 正式 Pocket：https://lifeos-pocket.pages.dev/pocket/ ，Pages 部署 `760d0565`，缓存 `lifeos-pocket-0e68ebd15ee8c8ba`。
- 源码实现提交：原工作仓库 `ac3ee99`；发布包仅 11 项静态文件，不包含 SQLite、备份、后台凭证或私人媒体。原 MCP 和通知 Worker 未变更。
- Windows 归档：`E:/Codex/data/lifeos-recovered-20261114`，独立环境 `E:/Codex/venvs/lifeos-archive`，私人配置 `E:/Codex/archive-config/lifeos.json`。配置与 vault 不在仓库。升级初始化与电脑服务重启前后，原六张 SQLite 表指纹相同且 integrity_check=ok。
- 升级前代码、发布包、SQLite、媒体和两个 Git bundle 的 SHA 已再次核验；旧标签不移动、不覆盖。

真实自动同步验收使用正式 HTTPS 站点和真实 Sync Worker，但创建独立的合成测试空间、两个全新浏览器 IndexedDB 以及 E 盘临时归档数据库，不读取私人历史：

1. 配对两台合成客户端，下载完整备份并核对清单；实际运行 Python Agent 生成持久归档，满足双 PWA 与归档门槛后才 activate。
2. 客户端 A 只按普通随手记流程保存一条唯一测试文字，未点击业务同步按钮，也未连接 Google。短暂防抖后 Worker head 增长。
3. 客户端 B 在联网唤醒后自动读取同一条记录。
4. 关闭两台浏览器，再独立运行 Python Agent；SQLite 中该记录恰好一条、正文 SHA 相同、完整性检查通过。
5. 测试本地临时目录清理不涉及用户数据库；云端合成空间只包含测试数据，遵循第一阶段保留历史策略。

复验命令为 `node scripts/verify-live-autosync.mjs`，需要部署机自己的私有初始化凭证和归档环境；它不是用户日常运行依赖。Node/浏览器不获取或输出 Archive 私钥。真实私人空间的迁移与两台实际手机配对，仍需用户按上述首次迁移流程操作；没有以合成空间的激活代替用户空间的激活。

录音与媒体校验包含多分片、断点重试、相同 ID 冲突拒绝、原始字节 SHA 回读、已删除记录与孤立媒体保留、备份复制及恢复后全量重放；真实 Cloudflare 隔离空间也完成 Python 上传/下载/SQLite 归档。真实 iPhone 录音原件与长期保管完整性仍需首次迁移时在各设备核对。

### 交付索引 A–M

|项目|对应内容|
|---|---|
|A 新架构 / B 修改文件|本文架构职责、接口和主要修改文件|
|C 部署地址|本次实际交付与线上验收|
|D 设备绑定 / E 三平台使用|首次迁移、Windows 配对批准、Ubuntu 独立客户端；iPhone 从主屏幕打开后前台自动同步|
|F Agent 自启 / G 旧 Drive 迁移|首次迁移第 1–8 步；已有 Windows 配置无需重复初始化|
|H 真实自动同步|上述正式 HTTPS → Sync Worker → 另一 PWA → 独立 SQLite 归档验收|
|I 七天离线 / J 媒体|七天以上断网验收步骤与媒体 SHA 记录，区分时间戳模拟和实机长期关机|
|K 测试 / L 未验证事项|验证记录与待验收|
|M 免费额度与增长风险|免费额度及容量边界；全历史不裁剪，达到保护上限停止上传并保留本机数据|
