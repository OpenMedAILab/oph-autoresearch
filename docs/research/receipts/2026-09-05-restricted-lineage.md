# 受限实例、任务证据和摘要记账增量回执

## 进度看板

- ✅ 本轮实现、独立 Astra 复核和最终自测通过；尚未用户亲测。
- 当前状态：本地纵切片可运行，整体 Pro 方案未全部完成。
- 下一批：T10 固定合成评估模板及其真实 Runner 消费；不以 SSH 或人工身份缺失阻止本地开发。

基线：`feat/mvp-research-workbench`，HEAD `e4d3322f19b33c545819b4b5e15a50eaee4c5d33`。本轮在已有 dirty 工作区整合；未提交、推送、安装第三方代码、连接真实 SSH 或运行患者数据。

权威与范围见 [基线](../implementation-baseline.md)、[所有权](../ownership-map.md)、[受限实例 ADR](../adr/0003-immutable-restricted-instance.md) 和 [任务证据 ADR](../adr/0004-task-evidence-and-local-protocol.md)。本回执记录本地完成范围，不代表 Pro 全部 P0 完成。

## 已落地

- immutable launch boundary 拦截实际 API/WS/静态文件出口，跳过扩展、调度、探测及命令子进程启动。普通 standard 实例行为保留；restricted-clinical 没有可信后端，仅固定状态可读。
- 父会话删除同步检查整棵后代执行树；持久取消时间在重新挂载 UI 后仍显示请求中。
- TaskRevision 声明精确证据版本、前序修订、上下文与技能/模板绑定；明确生产者边传播失效，保留历史执行、失败与产物。相同任务重跑产物版本递增。
- 独立机器模块从真实字节和固定 fixture 重算统计；本地 submit/status/cancel/receipt 协议共用原 ResearchEvent 账本。回执读取完毕后重验最新依赖，拒绝读取期间已失效的证据。
- Skill 来源区分 local-bundle/git-pinned，严格固定版本与内容、Git blob 身份；可复用锁读取端口连接 read_skill 边界和实际合成 Runner。外部候选不安装、不准入、不执行。Session 具备注入端口，但本轮没有新增研究 LLM Session 生产调用者。
- 固定模板描述符真实驱动解释器，其 hash 随 TaskRevision 进入 bundle；不声称已绑定整个解释器源码或二进制。评估合同 hash 在运行时核验。
- 上游超时修复：SDK 600 秒兜底、retry=0，主 watchdog 超时及 SDK timeout 不自动重发，保留实际静默读数。
- 摘要请求同账本：迁移 37 仅新增 purpose，运行内 summary 独立请求编号且用量并入 run 一次；手动 summary 仍单独 usage_ledger。摘要不作为主上下文锚点。未知用量留 null，真实 provider 零值仍保留。取消已发送请求以 uncertain 结算。

## T01–T12 当前矩阵

| 项目 | 当前实际结果 | 未实现或下一批边界 |
|---|---|---|
| T01/T02 | Campaign/Event、原子投影/outbox/CAS/幂等、不可变产物、固定 TaskRevision/Attempt、修订与精确依赖失效 | 通用任务种类、完整资源/租约/fencing 合同未实现 |
| T03 | 当前 serve 实例受限边界与真实 canary 全拒绝验证 | 通用逐出口脱敏、机构执行代理、OS 级/跨进程 egress 治理未实现 |
| T04 | 内部 bundle 绑定/撤销/失效；审批 API 对不可证明身份一律 403 | 可信人类身份集成与人工审批界面需真实信任通道；通用返工编排仍可本地开发 |
| T05 | 本地固定 submit/status/cancel/receipt 实际可用 | SSH daemon、远端 JobSpec、失联 unknown/租约/fencing 未实现；并非全部受外部条件阻塞 |
| T06 | 真实科研 REST/事件、声明任务/运行/取消/回执、鉴权和 workspace 归属 | 通用工作流 API 尚未实现 |
| T07 | 固定 Runner 的唯一 claim/恢复/幂等/取消确认；独立机器 byte review | 多资源调度、跨任务 CLI 会话隔离、独立研究模型审核上下文未实现 |
| T08 | 固定 first-party 来源/权限/合同/模板锁实际消费；通用 SourceSnapshot/内容读取端口；三份真实 K-Dense 只读候选核验 | 通用第三方准入/依赖与脚本审核、生产研究 Session 装配、文献证据语义核验未实现 |
| T09 | 真实 ledger 状态、取消持久化、任务失效显示、旧聊天未核验区分 | 完整六阶段任务/审批/证据交互与 provider purpose 细节视图未移植 |
| T10 | 固定合成统计的有限数值、输入 hash、精确输出、独立重算 | 患者/双眼/访次/近重复分组泄漏、单类指标、置信区间单位、训练 fit/验证阈值/冻结测试集合同尚未实现；下一批应新增固定合成评估模板与真实 Runner 消费，不改原 v1 合同冒充临床评估 |
| T11 | 固定 27 上游提交审计；取消、父归属、超时与 summary 同账增量移植 | 审计其余条目按文件逐项处置；未批量搬迁移或 UI |
| T12 | 本地故障注入、真实 HTTP、编译 exe 无源码目录执行与回执核验 | 多进程/远端故障协议、完整评估纵切片与真实 SSH 验收尚未执行 |

## 审查与验证

独立 Astra 提出的父子删除、持久取消、静态出口、回执读取竞态、重跑产物版本、模板绑定、来源枚举、摘要预取消与未知零用量问题均已修复并纳入回归。独立最终定向 124 pass、314 断言，无剩余具体发现。

独立真实 SSE 取消探针：`.tmp/pro-review-2026-09-05/astra-summary-cancel.ts` 与 `astra-summary-cancel-receipt.json`。真实 HTTP/SSE → adapter → summarizer → AgentLoop summaryTrace → Session 生产 makePersistence → Store，provider calls=1，run.finished/runs/provider_requests/最终 run ledger 均保留 7/3 token，请求状态 uncertain。compaction 是受控探针，结账采用 Session 相同 recordUsage 映射；不称完整 Session.ask/UI 端到端。runtime 摘要测试另连续运行 10 次无失败；其中取消等待仍是时间型夹具，不称确定消费屏障。

最终 `.tmp/bun-shim/bun.exe run gate` 进程 exit 0：2271 pass、1 平台 skip、0 fail，11366 断言、156 文件。TypeScript、全仓 Biome 和 Rust cargo check 均通过。日志 `.tmp/pro-review-2026-09-05/continuation/gate.log`。

最终 `.tmp/bun-shim/bun.exe run build` 进程 exit 0：web、496 模块 / 99.4 MB Windows GNU sidecar、`oph 0.1.8` 自检通过。日志 `continuation/build.log`。

最终编译后实际 smoke：`.tmp/bun-shim/bun.exe run scripts/research-compiled-smoke.ts apps/desktop/src-tauri/bin/oph-x86_64-pc-windows-gnu.exe`，exit 0。回执 `.tmp/research-compiled-smoke/run-uoHjuT/receipt.json`；Campaign `rc_b12d8e5a-f6a4-43f8-a332-9ed1336560ca`，Attempt `rat_3578f310-f6e7-46df-a8f9-d3e24fab6fc3`。独立目录仅复制 executable，独立 home/workspace，真实 HTTP create/execute/replay/receipt；217 bytes，SHA256 `1d6e92562b56cc52ffd94449a76197f2738a20d0210938a7b870ef1bb9c3cd9b`，重复请求仅一个 Attempt，humanApproval=false。日志 `continuation/compiled-smoke.log`。

源码模式真实 HTTP smoke 同样 exit 0：`.tmp/research-smoke/run-L5AX1V/receipt.json`，campaignSeq=3，217 bytes，相同 hash；包含 outbox 及 SQLite 物理重开验证。日志 `continuation/local-smoke.log`。本节缩写日志路径均在 `.tmp/pro-review-2026-09-05/` 下。

最终保全：81 项本轮基线文件，62 项 SHA256 完全不变、19 项必要增量、0 缺失；对照 `.tmp/pro-review-2026-09-05/continuation/preservation.json`。HEAD 未变，index 无暂存修改；未 reset/clean/stash，未迁移用户真实数据库、未重启用户应用。