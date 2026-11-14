# 用聊天版 ChatGPT 阅读 LifeOS 3.0

## 阅读入口

仓库按所有者要求公开，当前文档以 **main 分支**为准：

- 仓库：https://github.com/ZheyuanZeno/lifeos3.0
- 项目说明：https://github.com/ZheyuanZeno/lifeos3.0/blob/main/README.md
- 纯文本 README：https://raw.githubusercontent.com/ZheyuanZeno/lifeos3.0/main/README.md
- 完整架构：https://raw.githubusercontent.com/ZheyuanZeno/lifeos3.0/main/docs/ARCHITECTURE.md
- 文档索引：https://raw.githubusercontent.com/ZheyuanZeno/lifeos3.0/main/llms.txt

v3.0.0 标签保留发布时的源码快照；后续补充的文档请读取 main。

## 方法一：让支持网页访问的聊天读取公开链接

可以把下面这段话发给 ChatGPT：

```text
请访问我的 LifeOS 3.0 源码仓库：
https://github.com/ZheyuanZeno/lifeos3.0

先阅读 main 分支的 README.md 和 docs/ARCHITECTURE.md，再按问题查看相关源码。
如普通 GitHub 页面无法打开，请读取：
https://raw.githubusercontent.com/ZheyuanZeno/lifeos3.0/main/README.md
https://raw.githubusercontent.com/ZheyuanZeno/lifeos3.0/main/docs/ARCHITECTURE.md

请基于实际读到的文件解释整体架构、数据保存位置、手动同步和通知实现，
并附相关文件路径。区分已实现功能和设计建议。
如果当前聊天不能访问这些链接，请明确说明，不要假装读过仓库。
```

公开链接允许匿名访问，但不会赋予所有聊天网页浏览能力，也不保证刚发布的仓库立即进入搜索结果。直接提供完整文件链接有助于定位，不应把“已公开”理解为“已自动加载进每一场聊天”。

## 方法二：在 ChatGPT 中连接 GitHub

按 [OpenAI 的 GitHub 连接说明](https://help.openai.com/en/articles/11145903-connecting-github-to-chatgpt)，在 ChatGPT 设置的插件/应用入口连接 GitHub，并在 GitHub 授权页选择允许访问的仓库。新仓库若未出现，检查连接所用账号和仓库授权；功能入口及普通聊天中的可用性取决于套餐、工作区和产品界面。

在支持 GitHub 的聊天中，可以这样问：

```text
请读取 GitHub 仓库 ZheyuanZeno/lifeos3.0 的 main 分支，
先看 README.md、docs/ARCHITECTURE.md、docs/RELEASE-3.0.md。
解释 Google Drive 为什么只手动同步，以及通知为什么还能独立更新。
请引用对应源码文件。
```

连接后按需读取已授权内容；不需要为了读取而等待某个由本项目管理的 ChatGPT 索引任务。若当前产品的普通聊天不提供 GitHub，可按该产品实际支持的研究/代理入口使用，或上传 README/架构文档。

## 阅读顺序与源码定位

|问题|优先阅读|
|---|---|
|项目用途和运行方法|README.md|
|系统边界、完整数据流和实现原理|docs/ARCHITECTURE.md|
|3.0 的行为变化与限制|docs/RELEASE-3.0.md|
|记录的事务写入与合并|lifeos/pocket/src/repository.ts、merge.ts|
|计时、暂停、跨午夜和时区|time.ts、shared-timer.ts、plans.ts|
|Google Drive 手动同步|sync/controller.ts、sync/engine.ts、sync/google-drive.ts|
|系统通知|notifications/projection.ts、workers/notify/src/index.ts|
|原版电脑端及本机交换|lifeos/app.py、lifeos/pocket_sync.py|

表中未写全的 TypeScript 路径均相对 lifeos/pocket/src/。llms.txt 只是本仓库维护的纯文本文档索引，不是 ChatGPT 自动读取或获得权限的开关。

## 能读取什么

公开的是程序代码、配置模板和说明，仓库不保存实际个人计划、日记、录音、数据库、登录令牌或服务私钥。ChatGPT 读到源码，不代表读到了手机或 Google Drive 中的生活记录，也不会因此获得添加计划或控制通知的能力。当前可由用户启用 [AI Docs Bridge](AI-BRIDGE.md)：主动导出选定 Context，AI 向私人 Inbox 提交结构化命令，LifeOS 审核后经业务层执行。没有 Docs 编辑能力时使用同协议 JSON 文件；不直接连接或修改私人数据库，真实 Plus 写入需按指南验收。
