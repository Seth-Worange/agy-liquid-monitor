# AGY Liquid Monitor

面向 **Windows 10/11 上的 Antigravity Desktop 2.0** 的只读用量监控插件。通过 Antigravity 的 MCP App 接入 **Plugins → Liquid Monitor** 全页看板，也可从会话侧边栏的插件菜单打开。界面使用半透明玻璃、柔和高光与内容可适配的仪表组件，默认跟随宿主主题。

## 安装

要求 Antigravity App **2.34.0 或更新版本**，Windows 数据适配在 **2.35.1** 上验证。需要支持 `node:sqlite` 的 Node.js **22.13+**。支持该模块的 Antigravity 内置 Node.js 也可运行插件。

```powershell
npm test
npm run build
agy plugin install .\dist\agy-liquid-monitor
```

如未安装 Antigravity CLI，把 `dist\agy-liquid-monitor` 文件夹复制到 `%USERPROFILE%\.gemini\config\plugins\`，或复制到目标工作区的 `.agents\plugins\` 中。重新打开 Antigravity，在 **Customizations → Installed** 确认启用，然后打开左栏 **Plugins → Liquid Monitor**。

更新时重新构建并通过相同入口安装。卸载可从 **Customizations → Installed** 移除插件，或执行 `agy plugin uninstall agy-liquid-monitor`。用 `npm run preview` 打开带演示数据的浏览器版。

## 能看到什么

| 面板 | 指标与交互 |
| --- | --- |
| 概览 | 今日 Token、输入与输出、预估 API 费用、近 14 天趋势、当前会话和额度摘要 |
| 会话 | 累计 Token、对话轮数、模型调用次数、模型与推理档位、缓存命中率、首字延迟、输出速度和模型耗时。可选择最多四个会话并排查看 |
| 上下文 | 窗口使用率与压缩次数、最近一次压缩前后占用、系统提示词、技能与规则、MCP 工具、内置工具和消息与输出五类占用估算 |
| 子代理 | 运行数与总数、各子代理的运行状态、模型和上下文占用 |
| 额度 | 5 小时与 7 天额度环、账户套餐、各共享池余量、重置倒计时和周消耗速度 |
| 历史用量 | 7 天、30 天与全部周期，总量、预估费用、活跃日均 Token、会话均值、日均模型时长。可点选 30 天热力图中的日期，筛选模型用量与会话 Top 3 |

原项目在标题栏与每个聊天输入栏中显示悬浮指标。此版本通过官方 MCP App 在侧边栏与全页展示相同类别的指标，会话由看板内选择。

## 数据与估算

- Windows 历史记录来自 `%USERPROFILE%\.gemini\antigravity\conversation_summaries.db` 和 `conversations\*.db`。SQLite 以只读方式打开，增量索引仅保存在内存。
- 实时会话、套餐和额度通过已启动的本地 Antigravity 服务读取，插件只连接 `127.0.0.1`。服务离线时仍可查看可用的历史记录。会话数据可能因客户端版本、登录状态和本地记录保留情况而异。
- 费用按内置 API 单价估算。缺少单价时显示未定价，估算金额与订阅账单无关。上下文细分按可读取的内容计算，只有模型公开窗口上限时才显示使用百分比。

## 开发

`src/core` 包含模型、Token、上下文和额度计算，`src/main` 提供 Windows 数据读取、MCP 与页面资源，`src/ui` 是看板。运行 `npm test` 验证数据和协议，运行 `npm run build` 输出可安装目录与可离线打开的 `dist/preview.html`。项目没有 npm 运行依赖。

部分数据解析和统计逻辑来自 [ag-vario](https://github.com/Staaaying/ag-vario)。相关版权及许可见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。[Antigravity MCP App 文档](https://antigravity.google/docs/mcp-apps/)
