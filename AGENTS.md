# LifeOS 3.0 开发约定

先阅读 README.md、docs/ARCHITECTURE.md 和 docs/RELEASE-3.0.md。保留原 Python + SQLite 电脑白板与 Vanilla TypeScript + Dexie Pocket，不另建替代业务数据库。

- Google Drive 为手动同步：连接只授权，只有用户点击“立即同步”才执行云端交换。不要重新引入保存后上传、空闲轮询、焦点触发或恢复网络重试。
- 系统通知的提醒投影独立联网更新，不能因 Drive 手动模式而停用。通知服务不存随手记、计划正文或录音。
- 保留 IndexedDB 名称、稳定 ID、因果日志、JSON 备份兼容及原 SQLite 数据；不能清空数据来通过检查。
- 所有测试使用独立临时目录和数据库。修改后运行 npm run check、npm run typecheck:notify；涉及同步或通知时运行相应浏览器和通知集成测试。
- 不提交个人 data/local-data、备份、附件、录音、令牌、私钥、node_modules、缓存、构建包或旧压缩包。发布前检查 git status 和暂存文件列表。
- 文档区分已实现能力和已知限制；变更同步行为时同步更新使用说明。
