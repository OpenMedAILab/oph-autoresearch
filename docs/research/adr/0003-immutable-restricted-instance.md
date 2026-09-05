# 启动时冻结受限实例边界

2026-09-05，当前增量实现，最终 gate/build/编译后验收尚待本批整合。

`serve({ researchBoundary: 'restricted-clinical' })` 与 CLI `--restricted-clinical` 是可信启动选择。闭包在启动时复制该值；请求体、工作区 `.oph/policy.json`、普通权限配置 `full` 和调用者随后修改 options 都不能改变它。普通实例继续现有行为。此边界仅覆盖当前实例，不构成操作系统或其他进程的网络隔离。

当前没有可信临床后端，因此受限实例仅提供固定健康状态和鉴权后的 `/api/research/security`。其余 HTTP（包括静态文件）、WebSocket 升级及消息固定拒绝，错误不回显用户参数。禁止扩展预热、MCP/插件启动、调度执行、Git 探测、研究模板生成和研究事件回放；CLI 不启动命令运行子进程。Session 构造与 ToolRegistry 另设前置拒绝，后者在工具查找、权限描述、目标生成和函数执行前拒绝。

不将 bearer token 认作人工审查身份，不启用临床处理，不把模型提示词或可修改配置当作安全边界。数据库初始化仍可登记工作区并进行普通孤儿执行恢复；固定状态不返回临床数据。

真实 HTTP 集成测试使用隔离 SQLite、包含 PNG/DICOM/OCR/CSV canary 的临时工作区、扩展启动标记和本机假 provider。验证 full 配置、恶意策略文件、API 写入与读取、未知入口、WebSocket upgrade、未鉴权静态 CSV、Session 均不能到达数据出口；provider 调用数为 0，扩展标记不存在，messages/research_events/provider_requests 均无记录。静态出口曾在独立审查中漏掉，现纳入同一前置拒绝和回归测试。

后续可信后端应按最小 capability 显式打开入口并重新审查全部数据流。当前全拒绝不能被描述成通用脱敏、临床评估或完整 Skills 沙箱。
