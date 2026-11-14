# LifeOS 3.0 架构

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

## 通知

通知设备首次用 Google 确认账号后获得独立、可撤销的设备凭证。计划提醒投影独立上传，不因 Drive 改为手动而停用。后台不接收计划正文、随手记、录音和附件，只使用提醒字段及因果合并元数据。通知设备凭证不进入 Drive 日志或 JSON 备份。

计划结束计时与完成是独立状态；只有完成、删除、清空时间或归档模块才取消提醒。相同计划和时刻按设备去重，重试使用相同 topic/tag。各设备尚未手动同步到计划时，通知点击会提示计划尚未同步。

## 保留的边界

- Drive 登录仍是浏览器短期 token，只在内存中保存，过期后用户重新连接。
- 手动同步不是实时推送；另一台设备需要手动拉取。
- 原电脑白板仍需要本机 Python；Pages 仅托管 Pocket 和通知转发。
- 录音只保证前台录制；大量历史和录音目前仍在本地保留，尚无自动缓存淘汰。
- 同步日志未进行大规模压缩；当前版本不承诺无限记录量或无限空间。
- Cloudflare 通知不是完整业务云数据库；Google Drive 存同步文件，不是 Firestore。
