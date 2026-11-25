# AGY Liquid Monitor

面向 **Windows 10/11 上的 Antigravity Desktop 2.0** 的只读用量监控插件。聊天框下方显示会话、上下文和子代理。窗口顶部显示 5 小时与 7 天额度和今日 Token。点击数字展开明细。状态栏继承宿主界面字体，并随 Antigravity 日夜主题切换。

## 安装

支持经过兼容检查的 Antigravity Desktop **2.x Windows** 版本，目标版本为 **2.35.1**。安装需要 Node.js **22.13+**。在仓库或解压后的安装包目录运行以下命令。

```powershell
npm run hud:check
npm run hud:install
```

安装前从菜单或托盘完全退出 Antigravity。装完重新打开客户端。自定义安装目录可加参数 `-- --target "D:\Apps\Antigravity\resources\app.asar"`。

安装会校验并备份原始 `app.asar`，然后更换归档。客户端更新后可重新运行兼容检查与安装。完全退出客户端后，执行 `npm run hud:restore` 可按 SHA-256 校验还原原版归档。

可另用 `agy plugin install .` 注册 MCP 看板。打开任一会话，在右上角打开侧栏，再从右侧栏的 **+ → Plugins → Liquid Monitor** 打开主页面。左栏 **Plugins → Liquid Monitor** 也可打开全页。MCP 看板需要 Antigravity App 2.34.0+。用 `npm run preview` 可以在浏览器里试用带演示数据的状态栏。

## 能看到什么

| 面板 | 指标与交互 |
| --- | --- |
| 顶部状态栏 | 5 小时和 7 天额度、今日 Token。点击展开额度与历史用量 |
| 会话 | 累计 Token、对话轮数、模型调用次数、模型与推理档位、缓存命中率、首字延迟、输出速度和模型耗时。聊天分屏分别读取对应会话 |
| 上下文 | 窗口使用率与压缩次数、最近一次压缩前后占用、系统提示词、技能与规则、MCP 工具、内置工具和消息与输出五类占用估算 |
| 子代理 | 运行数与总数、各子代理的运行状态、模型和上下文占用 |
| 额度 | 5 小时与 7 天额度环、账户套餐、各共享池余量、重置倒计时和周消耗速度 |
| 历史用量 | 7 天、30 天与全部周期，总量、预估费用、活跃日均 Token、会话均值、日均模型时长。可点选 30 天热力图中的日期，筛选模型用量与会话 Top 3 |

## 数据与估算

- Windows 历史记录来自 `%USERPROFILE%\.gemini\antigravity\conversation_summaries.db` 和 `conversations\*.db`。SQLite 以只读方式打开，增量索引仅保存在内存。
- 实时会话、套餐和额度通过已启动的本地 Antigravity 服务读取，插件只连接 `127.0.0.1`。服务离线时仍可查看可用的历史记录。会话数据可能因客户端版本、登录状态和本地记录保留情况而异。
- 费用按内置 API 单价估算。缺少单价时显示未定价，估算金额与订阅账单无关。上下文细分按可读取的内容计算，只有模型公开窗口上限时才显示使用百分比。
- 模型品牌名称保留文字。Gemini 使用随包附带的 Google Sans Flex。Claude 和 GPT 分别优先使用本机的 Anthropic Serif 和 OpenAI Sans，无对应字库时使用 Georgia 和 Segoe UI。

## 开发

`src/core` 包含模型、Token、上下文和额度计算，`src/main` 提供 Windows 数据读取和宿主桥接，`src/ui` 提供状态栏和全页看板。运行 `npm test` 验证数据、协议和归档挂载，运行 `npm run build` 输出安装目录与可离线打开的 `dist/preview.html`。项目没有 npm 运行依赖。

部分数据解析和统计逻辑来自 [ag-vario](https://github.com/Staaaying/ag-vario)。相关版权及许可见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。[Antigravity MCP App 文档](https://antigravity.google/docs/mcp-apps/)
