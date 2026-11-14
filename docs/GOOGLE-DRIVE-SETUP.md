# Google Drive：连接、同步与真机验收

已实现 Google Identity Services 授权、Drive appDataFolder 传输、不可变操作批次、增量分页和独立云端确认。公开 Web 客户端 ID 已配置在 lifeos/pocket/google-client.json，构建时可用 LIFEOS_GOOGLE_CLIENT_ID 覆盖。真实 Google 账号与 iPhone 主屏幕闭环仍需用户授权后验收；自动化测试使用模拟 Google API。

## 当前使用方法

1. iPhone 从原来的 Pocket 图标打开应用。设置 → 存储与设备 → 检查应用更新；出现更新提示时确认更新，不要删除应用或清理网站数据。
2. 设置 → Google Drive → 连接 Google Drive，选择自己的 Google 账号并授予应用数据权限，授权后点击“立即同步”，等状态显示“已同步”。
3. 电脑启动原 Python 白板，再打开同源 /pocket/#settings，连接同一个 Google 账号。当前恢复资料的入口为 http://127.0.0.1:8771/pocket/#settings。
4. 3.0 为手动同步：连接只授权，新增/编辑、重新联网、返回前台或空闲均不触发 Drive 请求。记录设备点击“立即同步”上传，其他设备点击“立即同步”拉取；失败由用户下次主动重试。电脑 Pocket 手动同步前后还会与 SQLite 白板交换。
5. 页面关闭后 token 不保留；再次打开或授权到期需重新点击连接。本机记录和待上传操作保留。iOS 后台持续同步未实现。

各设备必须复用同一个客户端 ID 和账号，并都更新至共享计时版本。任一设备可控制已同步的同一段计时；Drive 文件交换存在网络延迟，其他设备的控制动作需两端手动同步后可见。不要只在电脑打开 Cloudflare 网站：它保存的是另一个浏览器数据库，无法直接访问原 Python 白板。

## 用户在 Google Cloud 中配置

1. 登录自己的 Google Cloud 项目，启用 Google Drive API。
2. 在 Google Auth Platform 配置应用名称、联系邮箱、授权域名与同意屏幕。个人使用先配置测试用户为自己的 Google 账号；根据控制台实际发布/验证要求操作。
3. Data Access 先只加入 https://www.googleapis.com/auth/drive.appdata；不要申请整个 Drive。
4. 创建 Web application 类型 OAuth client。Authorized JavaScript origins 加入 https://lifeos-pocket.pages.dev、http://127.0.0.1:8771 和 http://localhost:8771，不带 /pocket/。若改变本机端口，登记实际新 origin。当前 popup token flow 不填写重定向 URI。
5. 记录公开的 client ID（*.apps.googleusercontent.com）。浏览器 token model 不使用 client secret；不要将 secret 或 refresh token 粘贴到源码、提交 Git、保存到浏览器持久存储。
6. 桌面 Windows、Ubuntu、手机尽量复用同一 Web client ID 与 Cloud 应用身份；设备归属由本地独立 device ID 表示，不通过创建多个 Cloud 项目来表示。跨客户端可见性需要用真实项目测试。

以上步骤依据 Google 官方 [Setup](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid)。Google Identity Services token model 允许浏览器直接获得短期 access token；[官方 token model 文档](https://developers.google.com/identity/oauth2/web/guides/use-token-model)要求通过用户操作启动授权，过期后再次点击；不要求自建令牌交换服务器，不承诺后台自动续期。

## 当前与候选 scope

|权限|存储与可见性|跨端注意|
|---|---|---|
|drive.appdata（当前使用）|应用专属隐藏 appDataFolder；普通 Drive 界面不展示，不能共享内部文件|同一应用身份的各设备访问；用户删除应用数据后云端记录也会消失，仍需独立备份|
|drive.file|应用创建或用户明确选中授权的普通 Drive 文件，用户可见|不能假定不同应用/客户端会自动获准访问相同文件；必要时通过 Picker 明确选择|

依据：[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) 与 [appDataFolder](https://developers.google.com/workspace/drive/api/guides/appdata)。

## 已实现的同步约束

- 同步引擎接收传输适配器；Drive 只是其中一个实现，不参与本地业务事务。
- 每设备写不可变的 operation 批次，文件名/内容摘要和预留 Drive file ID 持久化，上传超时后检查同 ID 云文件再重试；不能单靠文件名唯一，也不能覆盖总库。
- 下载所有缺失批次并校验协议/摘要，合并成功后再保存游标；重复上传/下载不改变计数。本机 uploaded 确认和 Drive 确认必须分开。
- 新设备同步先拉取历史再上传；初始化默认模块标记为 seed，字段合并优先保留真实模块，避免覆盖旧模块名称。
- 分页全部下载并校验后原子合并；增量游标失效时重新扫描完整历史。未知设备未确认前不回收墓碑/历史，暂不压缩日志。
- 401 清除内存 token 并要求点击重新授权；403 解释 scope/项目配置；429/5xx 有界退避，失败始终保留本地操作。
- Cloud token 只保存在内存；断开授权不删除本地数据。
- 仅 Pocket 路由增加 Google 官方 script-src / frame-src / connect-src，并配置 same-origin-allow-popups，原白板策略保留。静态托管提供等效响应头。GIS 脚本在线从 Google 加载，不打包到离线缓存。

## 故障处理

- origin_mismatch：在上述 Web OAuth 客户端登记当前浏览器地址的 origin，注意端口与 127.0.0.1/localhost 的区别。
- access_denied：检查 Google Auth Platform 的测试用户是否包含当前账号，以及应用数据权限是否授予。
- 403：确认同一 Google Cloud 项目已启用 Drive API，检查账号管理策略。
- 授权过期：再次点击连接，不影响本地数据。
- 云端历史缺失或摘要不一致：停止合并并保留本地数据，先导出备份再排查；不要删除浏览器数据库解决。
- 同步结构化记录、事项、计时及新录制的语音；桌面原图片/PDF 等附件仍需保留原 ZIP。Drive 隐藏应用数据不是独立备份。

## 真实 iPhone 主屏幕验收清单

1. Safari HTTPS 页面首次安装到主屏幕；确认是 standalone 运行，资料和 Safari 页面是否同一存储上下文应实际核验。
2. 从主屏幕打开，在设置中通过用户点击触发 GIS；验证弹窗打开、账号选择、scope 授予和返回 Pocket。
3. 若 popup_failed_to_open / popup_closed，显示明确错误并允许重试；测试 Safari 同源入口时不能假定 token 或 IndexedDB 与主屏幕共享。
4. iPhone 离线新增完整会话，联网授权后上传；关掉 iPhone，再在 Windows 拉取；Windows 离线新增另一会话，上传后在 iPhone 拉取。Ubuntu 再作为独立新设备加入。
5. 重复同步、令牌过期、取消授权、上传成功但客户端未收到响应、下载中断，都必须不丢数据也不重复计数。
6. 两设备并发修改同一笔记，确认冲突原文可查看；旧设备携带删除前版本上线，确认删除不会复活；明确恢复才复原。
7. 主屏幕 PWA 退到后台或关闭后，不依赖其继续同步；前台、网络恢复、手动点击触发即可。

如果主屏幕弹窗与返回不可靠，应先记录 iOS 版本、具体错误、Safari 与 standalone 的差异，再选择同源重试或未来原生壳方案；不能换成前端存 client secret，也不能把手动 JSON 迁移宣称为 Drive 同步通过。
