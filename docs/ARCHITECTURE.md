# LifeOS 3.0 架构

本文描述当前 main 分支的实际实现。3.0 是产品版本；Pocket 继续使用既有 IndexedDB 名称 lifeos-pocket-v1 和原备份协议，并不因版本号变化重建用户资料。

## 程序边界

- `lifeos/app.py`：标准库 HTTP 服务、SQLite 原电脑白板、Pocket 静态入口与本机交换。
- `lifeos/pocket_sync.py`：SQLite 操作日志及兼容的因果合并。
- `lifeos/pocket/src/`：Vanilla TypeScript + Dexie 的离线 PWA，沿用原项目，不引入 React 或第二套业务数据模型。
- `lifeos/pocket/src/sync/`：Google GIS 浏览器授权、Drive 不可变日志批次、SHA-256 回读确认、增量游标及独立云端确认。
- `workers/notify/`：Cloudflare Worker + SQLite Durable Object alarm，保存提醒投影并发送加密 Web Push。
- `functions/api/notify/`：Pages 同源转发接口；桌面 Python 提供同一路由的受限代理。

## 写入与同步

手机业务数据与待交换操作在同一 IndexedDB 事务提交，断网仍可记录。点击“立即同步”后先拉取云端操作，执行因果合并，再同步录音并上传待确认日志。云端确认与本机交换标记分别保存，重复传输不重复创建记录。

3.0 移除了 Drive 定时轮询、保存后上传、返回前台拉取、恢复网络重试及连接后首次自动同步。状态事件只更新界面，连接只授权。重复点击复用同一个正在进行的请求，不排队生成额外同步。同步中仍可保存本地记录。

本机白板与 Pocket 的交换继续运行在本机，不是 Drive 云同步；电脑手动点击 Drive 同步时前后也交换 SQLite。计时进度根据开始时间与暂停区间计算，不需要每秒写数据库。

### 业务模型

|实体|作用|关系与约定|
|---|---|---|
|modules|电脑白板模块及记录分类|记录通过 module_id 归属模块；归档不直接删除内容|
|records|原版日记、事项、支出、计划和随手记|计划沿用 type=task、status=todo/done，不新增第二套任务表|
|routines|每日固定项目|保存标题、排序和归档状态；长按排序修改 order|
|sessions|一次实际计时|subjectKind/subjectId 指向固定项目或计划；保存 UTC 起止、时区、暂停区间及独立备注|
|completions|兼容的例行完成标记|保留既有日期和事项关系；计划完成以 records.status 为准|
|operations|跨端合并操作日志|稳定操作 ID、deviceId、sequence、clock、context、entity、recordId 和 patch|
|media / remoteMedia|录音字节与云端传输索引|文件稳定 ID、MIME、大小、SHA-256、远端确认状态|
|local / cloudState 等|设备配置、同步游标和确认信息|设备身份与业务记录分离，云端确认按账号区分|

类型与校验位于 [model.ts](../lifeos/pocket/src/model.ts)，Dexie 表定义位于 [database.ts](../lifeos/pocket/src/database.ts)。SQLite 原记录格式见 [FORMAT.md](../lifeos/FORMAT.md)。

### 事务写入与因果合并

repository.ts 的 putRow 会校验实体，将相对旧记录改变的字段形成 patch，并在同一事务中写入业务行、操作日志和本机设备序号。写入失败会一起回滚，不留下“界面已修改但没有待同步操作”的半条记录。

sequence 表示同一设备的操作顺序；clock 是逻辑时钟；context 记录本次操作已观察到的各设备序号。merge.ts 按字段去除已被后续操作因果覆盖的版本，对剩余并发版本按逻辑时钟、设备 ID、操作 ID 确定一致结果。它不是单纯比较设备墙上时钟，初始化 seed 也不会覆盖已存在的真实修改。

并发的 deleted/archived=true 优先于旧编辑；后续明确观察过删除的恢复操作可以正常合并。标题/正文的并发版本保留，供用户查看。计时控制由 shared-timer.ts 独立合并：startedAt、endedAt、pauses 作为相互一致的控制快照，已结束会话不会被并发的旧暂停或继续复活。deviceId 表示发起来源，不限制其他已同步设备控制会话。

### 一次手动同步的流程

~~~mermaid
sequenceDiagram
    actor User as 用户
    participant UI as DriveController
    participant Local as IndexedDB
    participant Drive as Google Drive
    User->>UI: 点击立即同步
    UI->>Drive: 使用增量游标查询日志变化
    Drive-->>UI: 新批次索引及日志字节
    UI->>UI: 校验格式与 SHA-256
    UI->>Local: 事务合并操作并保存游标
    UI->>Drive: 同步引用的录音文件
    UI->>Local: 读取本账号尚未确认的操作
    UI->>Drive: 上传不可变 JSON 批次
    UI->>Drive: 回读确认文件内容
    UI->>Local: 保存云端确认和成功时间
    UI-->>User: 已同步或明确错误
~~~

Drive 保存同步文件于应用专属 appDataFolder。引擎为上传预分配稳定 file ID，并保存待传批次；请求成功后响应丢失，重试仍使用相同编号并校验已有文件，不重复新建内容。游标失效可以重新扫描；已确认日志被修改或消失会停止合并并报错，保留本地资料。

操作中的 uploaded 仅用于本机 SQLite 桥确认；cloudAcks/cloudBatches 等保存每个 Google 账号的云端确认，两者不能互相替代。短暂网络错误可在用户发起的当前请求内部重试，但同步结束或失败后不会自动启动下一轮。

在电脑 localhost/127.0.0.1 的 Pocket 中，同步前后调用 POST /api/pocket/exchange，交换 SQLite 日志和附件。云端 Pages Pocket 没有本机桥。Python 服务仅监听本机地址，写入接口校验 Host、Origin 和 X-LifeOS-Token。关键实现：[bridge.ts](../lifeos/pocket/src/bridge.ts)、[app.py](../lifeos/app.py)、[pocket_sync.py](../lifeos/pocket_sync.py)。

### 计时与计划时间

time.ts 根据起止时间求实际时长并扣除暂停，按会话保存的时区拆分自然日，处理跨午夜与夏令时。界面每秒只更新显示，刷新后仍可由已保存时间恢复。有效时长不超过 30000ms 的已结束计时写入删除标记，历史和统计忽略它。

运行或暂停时需要显式结束当前任务才能切换；共享同步冲突导致多个未结束会话时保留其内容，供用户分别处理。计划可以多次开始独立会话，累计有效时长；勾选完成会在同一事务中结束该计划当前会话并改变状态，停止计时本身不完成计划。

plans.ts 将可选 DDL 存为 plan_deadline 日期，将分钟级详细时间存为 planned_start 的 UTC 瞬间及 time_zone 的 IANA 时区。修改其他字段时保留原时间，夏令时不存在的分钟拒绝保存；已有重复分钟的瞬间不会被无关编辑悄悄改掉。

### 当前活动与后台流程

后台流程复用原 task 及 `properties.background_flow` JSON 属性；人工处理继续使用 sessions。`handleFlow` 记录回去处理的实际时刻并开始人工段；`advanceFlow` 在同一 Dexie 事务中结束人工段、保存阶段起止预期及操作日志。后台等待期间可以计时其他活动，最后需明确完成流程。预计结束仅用于显示和通知，不代表机器实际停机。

流程总历时与人工投入分开派生，不重复增加当日人工时间。并发流程属性快照优先保留进度更多的阶段；已完成优先，明确因果重开仍有效。TS 与 Python 均校验并使用此规则，既有 properties、Dexie 和备份协议保持兼容。通知投影增加必要阶段元数据，每阶段单独去重；正文、备注、人工会话不进入通知后台。完整说明见 [BACKGROUND-FLOWS.md](BACKGROUND-FLOWS.md)。

### 离线资源与录音

构建脚本用 esbuild 打包 TypeScript/CSS，复制 manifest 和图标，并生成带内容指纹的 Service Worker。首次联网预缓存启动资源；后续离线导航读取缓存的规范 /pocket/ 页面。新版本等待用户确认后激活，业务数据保留在 IndexedDB。

录音通过前台 MediaRecorder 获取，优先选择浏览器支持的音频格式；单段限制 5 分钟或 4MB。进入后台会尝试停止并保存，不保证后台持续录音。云端媒体交换校验 MIME、大小和 SHA-256；Pocket JSON 备份携带录音字节，导入按稳定 ID 合并，导出体积上限 128MB。备份不包含 Google token 或通知设备凭证。

## 通知

通知设备首次用 Google 确认账号后获得独立、可撤销的设备凭证。计划提醒投影独立上传，不因 Drive 改为手动而停用。后台不接收计划正文、随手记、录音和附件，只使用提醒字段及因果合并元数据。通知设备凭证不进入 Drive 日志或 JSON 备份。

计划结束计时与完成是独立状态；只有完成、删除、清空时间或归档模块才取消提醒。相同计划和时刻按设备去重，重试使用相同 topic/tag。各设备尚未手动同步到计划时，通知点击会提示计划尚未同步。

### 设备认证与后台调度

通知端初次关联时用 Google access token 查询账号 permissionId，服务端按其摘要划分 Durable Object。随后签发带设备、随机 nonce 和到期时间的 HMAC 设备凭证，默认一年；它只能调用通知接口，不能读取 Google Drive。Google token 不保存在通知后台。

客户端从业务操作中提取计划类型、标题、状态、删除标记、所属模块、提醒时间及模块归档状态；保持合并所需的因果元数据。云端仍使用同一合并规则，重复上传和旧快照不会简单覆盖已有的新状态。计划正文、随手记、录音和计时历史不进入通知投影。

Durable Object 的 SQLite 表保存投影操作、设备订阅和投递状态。alarm 根据待发时间重排，完成、删除或改时后重新计算；发送采用 Web Push AES-128-GCM 内容加密及 VAPID 身份签名，过期订阅移除，短暂失败有限重试。Topic、系统通知 tag 和服务端确认共同减少重复投递；不承诺网络异常下严格恰好一次或精确到秒到达。

|同源接口|职责|
|---|---|
|GET /api/notify/config|检查就绪状态与取得 VAPID 公钥|
|POST /api/notify/enroll|用 Google 确认账号并关联通知设备|
|PUT /api/notify/state|提交提醒操作投影|
|PUT/DELETE /api/notify/subscription|开启/关闭本设备推送订阅|
|POST /api/notify/test|请求本设备测试通知|
|GET /api/notify/status|读取本设备订阅与调度状态|
|DELETE /api/notify/device|撤销旧通知设备|

Pages function 将这些请求转发给 Worker；本机 Python 使用受限同源代理。客户端只有公开 VAPID key，签名私钥与设备凭证签名密钥放在服务端。推送只接受受支持的浏览器厂商 HTTPS 端点，拒绝任意 URL 和重定向。点击系统通知只打开对应计划编辑，不开始计时或勾选完成。

## 构建、部署与验证

原电脑端直接运行 Python；Pocket 经 npm run build 输出到 lifeos/static/pocket，npm run package:pocket 生成仅含静态资源的部署目录和 ZIP。Pages 同源 functions 与通知 Worker 单独部署，因此仅上传静态 ZIP 不包含后台定时能力。具体配置见 [Cloudflare](CLOUDFLARE.md) 和 [通知服务](NOTIFICATIONS.md)。

测试采用 Vitest/fake-indexeddb、Python unittest、Playwright Chromium/WebKit 及 Miniflare/workerd。覆盖事务、备份、时间边界、同步、跨设备控制、原生通知未授权时的离线启动和真实 SQLite alarm/加密推送解密。3.0 发布验收为 102 项 TypeScript、14 项 Python、70 项浏览器测试，另有静态离线和生产资源哈希验证。测试使用独立临时资料，不读取或清理用户生活数据库。

## 与 ChatGPT 的边界

公开 GitHub 仓库提供程序和文档读取。实际记录仍在设备与用户授权的云端位置；GitHub 中没有个人 LifeOS 业务数据。聊天版 ChatGPT 能否读取链接取决于当次产品提供的网页或 GitHub 访问能力；读取源码不会自动连接实际数据库，也不等于已经具备聊天新增计划的业务接口。阅读入口和可复制问题见 [ChatGPT 阅读指南](CHATGPT-ACCESS.md)。

## 保留的边界

- Drive 登录仍是浏览器短期 token，只在内存中保存，过期后用户重新连接。
- 手动同步不是实时推送；另一台设备需要手动拉取。
- 原电脑白板仍需要本机 Python；Pages 仅托管 Pocket 和通知转发。
- 录音只保证前台录制；大量历史和录音目前仍在本地保留，尚无自动缓存淘汰。
- 同步日志未进行大规模压缩；当前版本不承诺无限记录量或无限空间。
- Cloudflare 通知不是完整业务云数据库；Google Drive 存同步文件，不是 Firestore。
