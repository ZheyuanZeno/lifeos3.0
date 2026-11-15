# LifeOS 3.0

离线优先的个人生活管理系统：电脑保留原有 Python + SQLite 白板，手机使用可安装的 LifeOS Pocket。Google Drive 提供手动跨设备同步，Cloudflare 提供计划系统通知和独立 OAuth MCP 连接。

## 3.0 的主要变化

**Google Drive 现在只在点击“立即同步”时执行同步。** 连接账号只授权；新增、编辑、切回页面、重新联网及空闲等待均不自动拉取或上传，不再每隔几秒切换按钮状态。通知后台的提醒安排独立更新，已保存的提醒仍可在网页关闭后发送。

- 三个入口：每日日程、随手记、设置，默认打开日程。
- 七个可编辑固定项目，整卡开始计时、长按拖动排序、统一自适应高度。
- 单次计划，支持可选 DDL、分钟级详细时间、备注和显式勾选完成。
- 计时支持暂停、继续、结束；每段独立备注。有效时长不超过 30 秒的记录不计入历史。
- 一个计划可以多次计时；结束计时不等于完成计划。
- 固定项目与计划可以同时计时，每个项目独立暂停、备注和结束；后台流程已取消，旧流程显示为普通计划。见 [多项目计时](docs/MULTI-TIMER.md)。
- 文字与前台录音随手记，历史可编辑、删除；录音可经 Drive 同步到其他设备及电脑附件。
- JSON 备份导出、校验与幂等合并恢复，保留旧数据格式。
- iPhone 主屏幕应用及兼容 Android 浏览器可开启 Web Push 通知，按计划详细时间提醒。
- 原生 AI 连接：Claude 等兼容客户端可通过 OAuth Remote MCP 查询、创建计划/笔记，按独立授权读取当日计时记录，前台自动领取，修改需审核；[首次连接与验收](docs/REMOTE-MCP.md)。
- 高级备用 AI 集成：Google Docs 双文档收件箱/上下文、JSON 离线导入、变更审核、版本冲突检查和跨设备稳定 ID 去重。默认人工确认；[配置与 ChatGPT 提示词](docs/AI-BRIDGE.md)。

## 整体架构

LifeOS 3.0 使用“本地先保存、按需交换数据、后台独立提醒”的结构。手机、电脑白板和通知服务职责分开，实际生活记录没有保存在 GitHub 仓库里。

~~~mermaid
flowchart LR
    Chat[AI 聊天文字/图片] --> MCP[OAuth Remote MCP / 有限投影与命令]
    MCP <-->|仅前台自动领取和回执| Pocket
    User[用户操作] --> Pocket[Pocket PWA / TypeScript]
    Pocket --> Local[(IndexedDB / Dexie)]
    Local -->|用户点击立即同步| Drive[(Google Drive 应用数据区)]
    Drive -->|用户点击立即同步| Other[另一设备的 Pocket]
    Pocket <-->|仅电脑同源本机交换| Python[Python HTTP 服务]
    Python <--> SQLite[(SQLite 与附件目录)]
    Pocket -->|独立提交计划提醒投影| Pages[Pages 同源通知接口]
    Pages --> Hub[Worker / Durable Object]
    Hub -->|alarm 到时触发| Push[浏览器推送服务]
    Push --> SW[Service Worker 系统通知]
~~~

GitHub 只托管源码。Cloudflare Pages 托管 Pocket 静态资源及通知转发；通知 Worker 保存提醒元数据，独立 MCP Worker 保存明确授权的有限投影与命令，均不取代本地数据库。Google Cloud 控制台里的 Drive API/OAuth 配置不等于建立了 Firestore 业务数据库。

|层|实现|主要职责|
|---|---|---|
|手机界面|Vanilla TypeScript、CSS、esbuild|日程、随手记、设置及响应式编辑弹窗|
|手机本地数据|Dexie / IndexedDB|离线记录、操作日志、录音及本机设置|
|离线启动|Manifest、Service Worker、Cache API|安装、预缓存、版本更新和断网重开|
|电脑原版|Python 标准库、SQLite|原有白板、导入导出、附件及本机接口|
|跨设备交换|Google GIS、Drive API|账号授权、不可变操作批次、手动增量同步|
|计划提醒|Cloudflare Worker、SQLite Durable Object、Web Push|设备订阅、后台定时、加密推送|

### 核心实现方法

**事务与操作日志。** Pocket 的业务写入和对应操作日志在同一 Dexie 事务中提交。每条操作包含稳定 ID、设备序号、逻辑时钟、因果上下文和字段补丁，断网时仍能保存。后续同步使用这些操作合并，而不是把整份手机数据库覆盖到另一台设备。

**冲突合并。** 合并按字段识别因果关系，对并发修改使用确定顺序。并发删除/归档优先，明确观察过删除后的恢复仍可生效；标题和正文的并发版本会保留。计时的开始、结束及暂停区间作为一致快照处理，结束优先于并发的旧暂停/继续操作，避免同步后复活已结束计时。

**手动 Drive 同步。** 连接 Google 只授权。点击“立即同步”后，先拉取增量日志并合并，再同步录音、上传待确认批次；批次用 SHA-256 回读校验。云端确认与电脑本机交换的确认分别保存，重复传输不重复新增记录。空闲、保存、返回前台或联网不会启动新一轮 Drive 同步。

**计时与计划。** 时长由 UTC 开始/结束时间计算，并扣除暂停区间，不靠每秒写数据库累计。结束时有效时长不超过 30 秒的段写入删除标记，不纳入历史和统计。计划是原有 task 记录，可以反复计时，只有打勾才算完成。分钟级计划时间同时保存 IANA 时区，处理跨午夜与夏令时边界。

**通知独立运行。** 设备首次通过 Google 确认账号后，获取仅用于通知的一年期设备凭证。前端独立提交计划标题、时间和状态等必要投影；后台按账号隔离，用 Durable Object alarm 定时，经 Web Push 加密发送。系统通知不要求网页一直打开，修改提醒也不依赖点击 Drive 同步；离线修改要联网后才能更新后台。

**录音与恢复。** 前台录音使用 MediaRecorder，文件和索引保存在本地，随后可手动同步至 Drive。Pocket JSON 备份包含业务数据和录音字节，导入按稳定 ID 合并；原电脑端另有完整 ZIP。备份导出不包含 Google token 或通知设备凭证。

完整模型、请求流程和源码定位见 [架构与实现详解](docs/ARCHITECTURE.md)。

### 源码导航

~~~text
lifeos/
  app.py                  电脑 HTTP 服务、白板及 Pocket 本机接口
  pocket_sync.py          SQLite 日志与因果合并适配
  static/                 原电脑版界面；构建后还包含 Pocket 静态资源
  pocket/src/
    main.ts               Pocket 页面、交互与控制器接线
    database.ts/model.ts  IndexedDB 定义和业务类型
    repository.ts         事务写入、业务操作和备份恢复
    merge.ts              普通字段的因果合并
    shared-timer.ts       共享计时控制快照合并
    background-flow.ts    旧流程属性的备份与合并兼容
    time.ts/plans.ts      有效时长、自然日、时区和计划时间
    sync/                 手动 Drive 同步与录音传输
    notifications/        通知设备控制与提醒字段投影
functions/api/notify/      Pages 同源通知转发
workers/notify/           Worker、Durable Object alarm 和 Web Push
scripts/                  构建、静态打包、通知集成验证
tests/                   数据、Python、浏览器和通知回归
~~~

## 本机启动

要求 Python 3.10+、Node.js 22+。Python 服务仅使用标准库；Node 用于构建和测试。

~~~sh
git clone https://github.com/ZheyuanZeno/lifeos3.0.git
cd lifeos3.0
npm ci
npm run build
python lifeos/app.py --port 8771 --data-dir ./local-data --no-browser
~~~

- 原电脑白板：http://127.0.0.1:8771/
- Pocket：http://127.0.0.1:8771/pocket/

./local-data 适用于首次空安装。**已有记录时，启动参数必须指向原数据目录**，不要用新建的空目录代替原资料。修改端口后需在自己的 Google OAuth 配置中登记相应 origin。

手机当前入口：[LifeOS Pocket](https://lifeos-pocket.pages.dev/pocket/)。用 Safari 或兼容浏览器打开，等待离线资源就绪，再添加到主屏幕。手机不能使用电脑的 127.0.0.1 地址。

## 手动同步

1. 各设备更新 Pocket，使用同一 Google Web 客户端 ID 和 Google 账号。
2. 设置 → Google Drive → 连接 Google Drive。
3. 在有新增或修改的设备点击“立即同步”，等待“已同步”。
4. 在其他设备点击“立即同步”取得更新。

电脑使用本机 Python 服务的 Pocket 入口同步，可同时把内容交换到原 SQLite 白板。电脑浏览器打开云端 Pages 网站会使用另一份本地浏览器数据库，不能直接写入电脑白板。

跨设备仍控制同一段已同步计时，但 3.0 不再自动双控：另一台设备的暂停、备注、结束或完成状态要手动同步后才能看到。授权到期需重新连接；待上传记录保留在本机，同步结束或失败后，不会自行开启下一轮。

## 通知

更新后先连接一次原 Google 账号以关联通知设备，再在设置中“开启通知”、允许系统权限并“发送测试通知”。每台接收设备分别开启。用户已确认 iPhone 和 Android 测试通知可收到。

只有填写“日期 + 详细时间”的计划才安排提醒，仅 DDL 不提醒。完成、删除、改时后，在线设备独立更新通知后台；无需等待 Drive 手动同步。离线修改无法立即撤回后台已有提醒。通知设备凭证与 Google Drive 短期 token 分开，不改变 Drive 本身的登录有效期。

## 数据位置

|位置|保存的内容|
|---|---|
|手机浏览器 IndexedDB|离线记录、操作日志、录音、本机配置|
|电脑 SQLite 与附件目录|原电脑白板及从 Pocket 交换的资料|
|Google Drive appDataFolder|确认上传的同步日志批次和录音文件|
|Cloudflare 通知后台|计划提醒所需元数据和设备推送订阅|

同步不等于腾空手机。当前没有自动归档、录音按需下载或缓存清理；设置中的“存储与设备”显示占用。重要资料仍应保留独立备份。

## 开发与验证

~~~sh
npm run check
npm run typecheck:notify
python -m unittest discover -s tests -p 'test_*.py' -v
npm run test:e2e
npm run test:notify
npm run package:pocket
npm run test:static
~~~

浏览器测试需先安装 Playwright 的 Chromium 和 WebKit：npx playwright install chromium webkit。测试使用独立临时资料库。可用 TEMP、TMP、LIFEOS_TEST_TMP、PLAYWRIGHT_BROWSERS_PATH 指定缓存和临时目录；npm 缓存配置为仓库内 .cache/npm。

package:pocket 生成 release/lifeos-pocket-web.zip 和 release/site，只包含静态 Pocket；通知另需部署 functions/ 与 workers/notify/ 并配置服务密钥。

## 文档

- [3.0 发布说明](docs/RELEASE-3.0.md)
- [架构与实现详解](docs/ARCHITECTURE.md)
- [让聊天版 ChatGPT 阅读仓库](docs/CHATGPT-ACCESS.md)
- [纯文本文档索引](llms.txt)
- [Google Drive 配置](docs/GOOGLE-DRIVE-SETUP.md)
- [手机安装](docs/PHONE-INSTALL.md)
- [通知服务](docs/NOTIFICATIONS.md)
- [Cloudflare 部署](docs/CLOUDFLARE.md)
- [数据格式](lifeos/FORMAT.md)
- [电脑白板使用说明](lifeos/README.md)

源码不包含个人数据库、备份、录音、账号令牌或 VAPID 私钥。公开 Google client ID 用于当前站点，部署自己的站点时应配置自己的 Web OAuth 客户端及允许的 origins。3.0 保留 lifeos-pocket-v1 本地数据库名称、现有表结构与备份格式，版本升级不会重置记录。

## 在聊天版 ChatGPT 中阅读

仓库按所有者要求公开。可以向支持网页访问的聊天发送这个链接：
https://github.com/ZheyuanZeno/lifeos3.0

也可以直接提供纯文本入口：
https://raw.githubusercontent.com/ZheyuanZeno/lifeos3.0/main/README.md

~~~text
请阅读 ZheyuanZeno/lifeos3.0 的 main 分支 README.md 和 docs/ARCHITECTURE.md，
基于实际源码解释整体架构、手动同步与通知流程，并附相关文件路径。
如果当前聊天没有网页/GitHub 访问能力，请明确说明。
~~~

若使用 ChatGPT 的 GitHub 连接，可授权该仓库后按文件读取。普通聊天是否支持该连接取决于当前套餐和产品入口；公开链接也不保证每个聊天都能浏览或立即被搜索收录。具体入口与备用方法见 [ChatGPT 阅读指南](docs/CHATGPT-ACCESS.md)。

读取公开源码不会读取你手机里的生活记录，也不会自动接通“聊天创建计划”；业务写入仍需要另行实现经过身份验证的接口。
