# LifeOS 3.0

离线优先的个人生活管理系统：电脑保留原有 Python + SQLite 白板，手机使用可安装的 LifeOS Pocket。Google Drive 提供手动跨设备同步，Cloudflare 提供计划系统通知。

## 3.0 的主要变化

**Google Drive 现在只在点击“立即同步”时执行同步。** 连接账号只授权；新增、编辑、切回页面、重新联网及空闲等待均不自动拉取或上传，不再每隔几秒切换按钮状态。通知后台的提醒安排独立更新，已保存的提醒仍可在网页关闭后发送。

- 三个入口：每日日程、随手记、设置，默认打开日程。
- 七个可编辑固定项目，整卡开始计时、长按拖动排序、统一自适应高度。
- 单次计划，支持可选 DDL、分钟级详细时间、备注和显式勾选完成。
- 计时支持暂停、继续、结束；每段独立备注。有效时长不超过 30 秒的记录不计入历史。
- 一个计划可以多次计时；结束计时不等于完成计划。
- 文字与前台录音随手记，历史可编辑、删除；录音可经 Drive 同步到其他设备及电脑附件。
- JSON 备份导出、校验与幂等合并恢复，保留旧数据格式。
- iPhone 主屏幕应用及兼容 Android 浏览器可开启 Web Push 通知，按计划详细时间提醒。

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
- [架构与边界](docs/ARCHITECTURE.md)
- [Google Drive 配置](docs/GOOGLE-DRIVE-SETUP.md)
- [手机安装](docs/PHONE-INSTALL.md)
- [通知服务](docs/NOTIFICATIONS.md)
- [Cloudflare 部署](docs/CLOUDFLARE.md)
- [数据格式](lifeos/FORMAT.md)
- [电脑白板使用说明](lifeos/README.md)

源码不包含个人数据库、备份、录音、账号令牌或 VAPID 私钥。公开 Google client ID 用于当前站点，部署自己的站点时应配置自己的 Web OAuth 客户端及允许的 origins。3.0 保留 lifeos-pocket-v1 本地数据库名称、现有表结构与备份格式，版本升级不会重置记录。
