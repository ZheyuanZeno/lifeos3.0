# 把当前 LifeOS Pocket 安装到 iPhone

当前版本为 LifeOS 3.0 离线 Pocket，包含文字/录音、计划和系统通知。原电脑白板依赖本机 Python。Google Drive 为手动同步：每台设备分别连接账号后，点击“立即同步”交换记录；保存、回到前台和重新联网不会自动同步。用户已确认 iPhone 与 Android 测试通知正常。

## 当前已发布版本

手机 Safari 直接打开 https://lifeos-pocket.pages.dev/pocket/，等待“离线资源已就绪”，再分享 → 添加到主屏幕。

## 1. 手动上传安装文件（可选）

已准备：E:/Codex/lifeos2.0/release/lifeos-pocket-web.zip。ZIP 只有静态应用资源，不含记录、SQLite、备份、Python、凭证或附件。不要上传仓库根目录的旧 lifeos2.0.zip，也不要上传整个源代码目录。

可用 Cloudflare Pages Direct Upload。登录自己的 Cloudflare 账户，在 Workers & Pages 中创建 Pages 静态项目，选择 Direct Upload / 拖放静态资源，上传 lifeos-pocket-web.zip，然后部署。不同控制台版本的按钮名称可能变化，按官方文档中的 Direct Upload 入口操作。上传后获得固定 HTTPS 网址，打开该网址的 /pocket/。此包的根网址也会跳转到 /pocket/。

官方文档：https://developers.cloudflare.com/pages/get-started/direct-upload/

已通过用户授权的 Cloudflare Pages 发布，直接访问 https://lifeos-pocket.pages.dev/pocket/ 即可；手动上传步骤可留作以后更换托管方式时使用。建议使用固定站点地址，后续在同一地址更新；换域名相当于换了浏览器存储空间。

## 2. 安装到 iPhone

1. iPhone Safari 打开部署后的 HTTPS 地址。
2. 等待页脚显示“离线资源已就绪”。
3. 分享 → 添加到主屏幕；若出现“作为 Web App 打开”，保持开启。
4. 从新图标启动，在这个主屏幕应用里新建事项和测试记录。
5. 开飞行模式，关闭并重新打开这个主屏幕应用，核对能继续记录。

Apple 官方说明：https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/ios

电脑的 127.0.0.1:8770 不是手机地址；手机访问自己的 127.0.0.1 无法连接电脑。无需把 SQLite 文件放进手机，也无需安装 Python。

## 3. 带入记录

应用安装本身不携带私人数据。当前 iPhone JSON 已另行恢复到 E 盘独立资料目录，电脑入口 http://127.0.0.1:8771/。旧 8770 空预览与此不同。

后续日常同步：手机更新 Pocket 后，设置 → Google Drive → 连接 Google Drive，再点击“立即同步”。电脑打开 http://127.0.0.1:8771/pocket/#settings 并连接相同 Google 账号，也点击“立即同步”；分别等待“已同步”。电脑 Pocket 会同时交换到原 SQLite 白板。详细配置与错误排查见 [Google Drive 指南](GOOGLE-DRIVE-SETUP.md)。主屏幕应用关闭后和授权过期后需要重新连接，不承诺后台持续同步。

如果数据已在这个版本的电脑 LifeOS 白板中：先打开电脑 Pocket，设置 → 与本机白板交换；成功后设置 → 导出备份，取得 lifeos-pocket-日期.json。把 JSON 经 iCloud Drive、其他个人文件传输或电脑到 iPhone 文件传输保存到 iPhone“文件”。从主屏幕启动手机 Pocket，设置 → 导入备份，选择这个 JSON。请在最终要使用的主屏幕应用内导入，不假定 Safari 页面和主屏幕应用一定共享同一存储上下文。

如果数据还在旧版 LifeOS：先保留原“完整 ZIP”备份，原桌面 ZIP 不能直接导入 Pocket；需要将实际资料安全接入新版桌面副本，确认后再通过本机交换生成 Pocket JSON。当前还没有执行这一迁移。Pocket 录音已支持同步与备份；旧桌面 ZIP 的其他附件仍需保留原备份。

手机新增记录后也可导出 Pocket JSON，在电脑 Pocket 导入，再与本机白板交换；这是手动迁移，不是 Google Drive 自动同步。

## 4. 后续更新

重新运行 npm run package:pocket，上传新 ZIP 到同一个 Pages 项目。手机打开后按更新提示更新。数据留在各自设备，本地清理和系统存储回收仍可能丢失未备份记录。

## 本地包验证

npm run test:static 在纯静态 HTTP 服务器上校验根页面跳转、资源缓存、断网关闭页面后重开、文字保存与刷新保留，不运行 Python 业务 API。浏览器引擎覆盖 Chromium / WebKit；仍需在真实 iPhone 上进行主屏幕验收。

## 当前三栏版本

计划通知已上线。先从 iPhone 主屏幕打开 Pocket，设置 → 检查应用更新，有新版本时点击“更新应用”。设置中先连接一次原来的 Google 账号，等通知设备关联完成，再点击“开启通知”、允许系统通知，最后点击“发送测试通知”确认。每台接收设备分别开启。计划需要填写“日期 + 详细时间”才安排提醒；仅 DDL 日期不自动提醒。后台保存后的提醒不依赖网页一直打开或 Google 短期登录继续有效，但 Drive 数据同步仍沿用原授权规则。更改计划时保持联网并等“提醒安排已更新”；离线无法立即撤销后台已有提醒。

打开后默认每日日程，底部为每日日程、随手记、设置。日程预置七个可编辑项目；随手记含录音及可编辑历史。旧 #today / #timeline 回到日程。更新后先在电脑 Pocket 同步，再在手机同步，以传递本次测试数据清理状态。
