# 内置 CLI 证据审核合同

2026-09-05。实现与源代码测试已完成，独立 Astra 复验关闭取消竞态；compiled 产物验证见最终交付回执。

启动 `oph serve --cwd <研究工作区> --research-human-auth <公钥配置.json> --research-review-cli` 后，已有研究 `/review/quote` 和 `/review` 接口使用本项目内置 CLI worker。`/review/quote` 返回 `executionBackend: builtin-cli`；报价中的 configHash 绑定后端，因此进程内 Session 的旧批准不能授权新的 CLI 执行。客户端仍须提供受信人类签名的准确证据、模型、次数、输出上限、金额和有效期范围。

父进程先在原 Campaign 账本预留预算，再创建一个新临时目录和 CLI 子进程。stdin 只承载已经核验的 EvidencePack、公共模型规格与随机 loopback 凭证。子进程不继承 provider key、父会话历史、用户配置目录或工作区；仅创建内存 Store 与全新 Session，不接受 resume。Session 的工具只有锁定 `read_skill`；模型请求通过临时 loopback 桥回父进程。父进程的同一个 ResearchRequestGuard 在每次真实 provider 发送前更新原账本，最多两次请求、每次最多 1024 输出 token，不因 CLI 模式产生另一份预算或执行状态账。

CLI 返回的结构化结果重新核验 EvidencePack hash、产物版本及输出合同，之后由已有 ModelReview 保存。没有报告的用量仍为 null，预算预留不凭空释放。CLI 的 runId/conversationId 是子进程执行来源标识，其临时会话不会出现在主会话列表中；实际 backend 在研究页面可见。取消或超时不能产生成功结果，临时目录和进程在收尾时清理。

`scripts/research-review-smoke.ts --cli` 验证真实子进程、HTTP 审批、provider SSE、出站上限、未知用量和重放；加 `--literature` 纳入官方公开元数据收集，加编译后的 CLI 路径验证安装产物。正式测试还观察子进程 cwd/environment，验证并发唯一派发、第三次 provider 请求拒绝及异步临时目录创建期间取消。

这是本项目的内置 CLI 审核后端。外部 Codex、Claude 等 CLI 未因该实现取得研究审批、预算或工具权限；它们不是此入口的可选执行目标。工作目录、最小环境和代码内工具白名单不是操作系统级隔离。当前合同用于获准的合成/公开聚合证据，实际临床身份、机构 ACL 和网络隔离需独立验收。
