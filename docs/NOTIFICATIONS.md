# 计划系统通知

这是 Web Push 后台推送，计划到时由 Cloudflare Worker / SQLite Durable Object alarm 发起，页面关闭时仍可送达。iPhone 需要 iOS 16.4 或以上、从 Safari 添加到主屏幕，并在主屏幕应用的设置中点击“开启通知”、允许系统通知。每台接收通知的设备分别开启；“发送测试通知”用来确认这台设备的系统权限和投递。

## 触发规则

- 仅使用计划项目的“日期 + 详细时间”，精确到分钟。没有详细时间或仅 DDL 日期的计划不发送通知。
- 完成、删除、移除详细时间、归档所属模块后取消待发提醒。修改详细时间会重新安排。暂停或结束计时不会视作任务完成。
- 设备联网后提交变更，后台确认后才显示“提醒安排已更新”。离线修改不可能立即撤回后台已有提醒；界面显示“离线，提醒变更待上传”。
- 后台根据同一 Google 账号归组设备，用现有因果操作合并更新，旧设备重复上传不会把已观察的完成/删除撤回。不依赖某个手机一直运行。
- 每台设备对同一计划 ID + 提醒时刻只记录一次成功投递，Web Push Topic 和系统 notification tag 相同以抑制重试重复。推送过期时间 15 分钟；刚加入的设备不补发很久以前的计划。
- 点击通知打开相应计划编辑，不开始计时或勾选完成。其他设备尚未同步到该计划时显示等待同步状态。
- 后台流程使用当前阶段预计结束时刻，通知文本包含阶段名称；实际处理后撤销该阶段安排，开始下一阶段单独计时和去重。通知点击打开流程时间线，不自动推进。详见 [BACKGROUND-FLOWS.md](BACKGROUND-FLOWS.md)。

## 账号与数据

初次关联通知设备时，后台通过 Google Drive `about.user.permissionId` 确认账号。Google access token 只用于此次验证，不保存在通知后台。随后使用独立、可撤销的一年期通知设备凭证，不赋予任何 Drive 文件读取权限。Google 浏览器短期 token 过期不影响后台已保存的提醒或使用该通知凭证提交变更。此功能没有改变 Drive 本身的登录有效期。

设备凭证保存在 IndexedDB 的 local 表中，不进入 Google Drive 操作日志或导出备份。每个账号独立 Durable Object，账号 ID 经 SHA-256 派生。切换 Google 账号后，客户端先撤销旧设备及旧订阅，再关联新账号。

通知后台只存计划标题、类型、状态、删除标记、所属模块 ID、计划时间/时区/DDL、后台阶段名称及预期/处理时间、模块归档状态，以及合并它们所需的操作元数据。计划正文、流程备注、随手记、语音、附件和人工计时记录不上传。推送端点及订阅密钥只用于发送系统通知。仅允许 Apple、Google、Mozilla 的 HTTPS 推送地址，不跟随重定向。

所有关联的在线设备都提交计划变更，即使该设备未开启接收通知。关闭通知仅关闭本设备订阅，仍可修改和取消其他设备的计划提醒。原电脑白板的修改需要运行 Pocket 并与白板交换后提交给通知服务。

## 服务部署

Worker 配置：`workers/notify/wrangler.jsonc`，名称 `lifeos-pocket-notify`，SQLite Durable Object 类 `ReminderHub`、绑定 `REMINDERS`。首次部署需要增加 Cloudflare `workers:write` 和 `workers_scripts:write`；仅申请前者时脚本部署及 subdomain 接口实际返回 403。原来的 Pages 授权无法创建定时后台；不需要 Google 客户端密钥。

Worker secrets：`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`DEVICE_AUTH_SECRET`。VAPID 公私钥只生成一次，长期保存在仓库外；不要每次发布都重新生成，否则已有浏览器订阅失效。Pages runtime 配置 `NOTIFY_BACKEND` 为 Worker 的 HTTPS 根网址。`functions/api/notify/[[path]].ts` 提供同源 API，避免前端接触后台签名密钥；Python 本地服务使用受限代理转发到 Pages 的同一路由。

先部署 Worker，设置 secrets，确认 `/config` 返回 ready/publicKey，再发布 Pages functions 与静态资源。没有配置时 UI 显示未启用，原本的本地记录及 Drive 同步仍可用。Cloudflare CLI 凭证及 VAPID 私钥都放在 E 盘仓库外。

## 验证

`npm run typecheck:notify` 检查后台与 Pages function；`npm run test:notify` 在真实 workerd / SQLite Durable Object 中触发 alarm，并在模拟推送端使用浏览器私钥解密收到的 Web Push，覆盖幂等、修改时间、跨设备完成取消、账号隔离、设备撤销、推送地址限制、测试频率限制。设置 `LIFEOS_NOTIFY_BUNDLE` 可使用 Wrangler dry-run 的实际部署 bundle 再执行同一验证。

`tests/notifications.test.ts` 验证脱敏投影、因果合并、凭证签名和推送加密请求；`tests/notifications-sw.test.ts` 验证 SW 可见通知与点击行为；浏览器测试覆盖开启/关闭/拒绝权限、点击手势、重载后不依赖 Google token、离线失败状态和通知跳转。

浏览器模拟不能代替真实 iPhone 的通知授权和 APNs 投递验收。iOS 专注模式、网络和系统电量策略可能延迟通知；已发送的系统通知无法通过后续离线修改撤回。后台最多保存每账号 20 台设备和 20000 条提醒相关操作，每次提交最多 2MB，超过上限会明确报错。首次部署保持免费计划，不自动升级付费计划。
