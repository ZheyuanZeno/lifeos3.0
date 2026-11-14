# Pocket 安装与开发（3.0）

当前界面为每日日程、随手记、设置三栏，默认日程。能力与限制见 [发布说明](RELEASE-3.0.md) 和 [架构](ARCHITECTURE.md)。

## 启动

需要 Python 3.10+、Node.js 22+。仓库根目录执行：

~~~sh
npm ci
npm run build
python lifeos/app.py --port 8771 --data-dir ./local-data --no-browser
~~~

已有资料时把 --data-dir 改为原数据目录，避免误用新建空库。电脑白板在根地址 /，手机界面在 /pocket/。

## Windows E 盘开发示例

~~~powershell
Set-Location E:\Codex\lifeos3.0
$env:TEMP='E:\Codex\tmp'
$env:TMP='E:\Codex\tmp'
$env:LIFEOS_TEST_TMP='E:\Codex\tmp'
$env:PLAYWRIGHT_BROWSERS_PATH='E:\Codex\cache\playwright'
npm.cmd ci
npm.cmd run build
python lifeos/app.py --port 8771 --data-dir ./local-data --no-browser
~~~

安装浏览器：npx playwright install chromium webkit。npm 默认缓存位于 .cache/npm；测试与下载目录可以通过上述环境变量调整。

## 同步与通知

Google Drive 仅由“立即同步”触发。连接只是授权；记录设备手动上传后，其他设备手动拉取。计时状态的跨设备控制也遵循这个流程。通知设备关联和计划提醒投影独立更新，不受 Drive 手动模式影响。

手机应使用 HTTPS 站点并添加到主屏幕。纯静态包由 npm run package:pocket 生成；通知还需要 Pages functions 和独立 Worker，不能只上传 ZIP 就得到后台推送。

## 验证

~~~sh
npm run check
npm run typecheck:notify
python -m unittest discover -s tests -p 'test_*.py' -v
npm run test:e2e
npm run test:notify
npm run package:pocket
npm run test:static
~~~

所有测试使用独立临时数据，不读取或清理用户资料。真实部署和服务密钥见 [Cloudflare](CLOUDFLARE.md) 与 [通知](NOTIFICATIONS.md)。
