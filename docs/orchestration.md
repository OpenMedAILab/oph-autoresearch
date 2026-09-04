# 多智能体科研编排方案

本方案面向眼科影像与 AI 模型研究。目标不是让更多 Agent 同时聊天，而是让一次研究从问题、数据、方案、实验、复核到报告形成可恢复、可审计、可由医生裁决的 `Research Campaign`。

参考资料包括 [Google Teamwork](https://antigravity.google/blog/teamwork-when-ai-becomes-a-research-partner) 的候选—反证—综合与运行时自适应模式，以及参考底座截至提交 `a4892602` 的工作流恢复、父子会话、检查点返工和统一记录改进。外部项目的描述是设计输入，不代表本项目已经实现。

## 核心取舍

1. **模式与角色分离。** Pattern 只定义拓扑、进入条件、退出条件和证据契约；角色定义提示词、技能、工具、模型和数据权限。同一个“候选—反证—综合”模式可以用于研究问题、方案和论文主张。
2. **代码调度、模型提案。** 模型可以提出任务图、候选数量和返工建议，但最终并发数、可用工具、SSH 主机、费用和审批要求由确定性策略裁决。
3. **产物传递，不共享思维。** 子 Agent 使用独立上下文，只通过版本化 Artifact 与 Evidence 交换结果。另一个 Agent 的同意不是验证。
4. **失败也是证据。** 被反驳路线、失败实验和审查意见不删除，进入 Pitfall Registry，供下一轮综合和重放使用。
5. **医生控制目标和接受。** 涉及研究问题冻结、患者数据用途、远程写入、结论发布的节点必须停在人工 Gate；自动审批只能处理低风险、可逆、本地操作。
6. **聊天不是状态真源。** 对话用于解释和发起操作，Campaign、Task、Attempt、Artifact、Evidence、Approval 与 Event Ledger 才是可恢复状态。

## 三平面架构

```text
医生 / 研究者
    │ 目标、约束、审批、驳回
    ▼
┌──────────────── 控制平面 ────────────────┐
│ Campaign Manager                         │
│ Pattern Selector → Graph Planner         │
│ Policy / Gate Engine → Model Router      │
│ Scheduler → Recovery / Replay            │
└───────────────┬──────────────────────────┘
                │ 版本化 TaskSpec + Capability Grant
                ▼
┌──────────────── 执行平面 ────────────────┐
│ 内置 Agent Runtime │ 原生 CLI Adapter     │
│ Local Sandbox      │ SSH Read-only Audit  │
│ Approved SSH Job   │ Future Label Adapter │
└───────────────┬──────────────────────────┘
                │ Receipt + ArtifactRef
                ▼
┌──────────────── 证据平面 ────────────────┐
│ Append-only Event Ledger                 │
│ Artifact Store + hash + lineage          │
│ Evidence / Claim Map / Pitfall Registry  │
│ Approval Snapshot + reviewer + decision  │
└──────────────────────────────────────────┘
```

控制平面永远不直接读取原始影像。执行平面只得到本次任务所需的最小能力令牌。证据平面保存脱敏汇总、命令模板、代码与环境哈希、退出码和产物引用，不保存患者级标识。

## 九个执行阶段与六段界面

右侧界面继续保持六个医生可理解的宏观阶段；运行时细分为九段，避免把授权、标注质量和归档复现藏在某个 Agent 的自由文本里。

| 内部阶段 | 界面归属 | 默认模式 | 主要角色 | 必交产物 | Gate |
|---|---|---|---|---|---|
| S0 立项与授权 | 问题建模 | scope-check | 研究协调员 | `campaign.yaml`、数据用途与资源上限 | G0 研究范围确认 |
| S1 问题与证据 | 问题建模 | candidate-challenge-synthesis | 证据检索员、临床反证员、综合员 | `research_question.yaml`、来源清单 | G0 问题冻结 |
| S2 数据与标签审计 | 数据审计 | distributed-readonly-audit | 数据审计员、DICOM 隐私审计员、泄漏/标注质控员 | `dataset_manifest.json`、标签与泄漏报告 | G1 数据、队列与标签确认 |
| S3 方案预注册 | 方案冻结 | protocol-tournament | 统计设计员、方法学批评员 | `study_protocol.md`、`experiment_spec.yaml` | G2 方案冻结 |
| S4 实现与冒烟验证 | 远程实验 | implementation-review | 实验工程师、复现工程师、安全审查员 | 代码版本、环境摘要、Smoke 回执 | 越界或需扩大写入时升级 |
| S5 基线与受限实验 | 远程实验 | experiment-dag | 基线/候选/消融执行员、实验反证员 | 每次 Attempt 的 `run_receipt.json`、实验索引 | 资源超限回到 G2 |
| S6 评价与误差分析 | 独立复核 | metric-challenge | 统计复算员、校准/公平性审查员、临床误差分析员 | 指标包、图表、亚组与失败病例清单 | 不产生最终主张批准 |
| S7 独立复核 | 独立复核 | self-verification | 独立复核员、泄漏审查员、复现审计员 | `claim_evidence_map.yaml`、复现差异 | G3 结论接受/返工 |
| S8 写作、归档与复现 | 研究输出 | document-review | 证据写作者、统计/引用审查员、研究协调员 | 报告、模型卡、`artifact_ledger.yaml`、复现清单 | 发布确认与 Campaign 关闭 |

标注网站未接入时，S2 的标注分支可以明确标记为 `not_applicable`，不能伪装成已完成。接入后它只作为 Task/Artifact/Event 适配器，不另起一条绕过审批的 Agent 链。

## Pattern 运行方式

### 候选—反证—综合

并行产生 2–4 个候选，每个候选配独立反证者；综合 Agent 只能读取候选产物与反证报告，不能读取其隐藏推理。综合结果必须经过工具核验或医生 Gate。被反驳候选保留其可用片段和失败原因。

### 分布式只读审计

按目录、模态或时间分片执行聚合统计，所有节点共享同一只读策略；泄漏挑战员检查患者级拆分、重复样本、时间穿越和标签污染。最终只把脱敏聚合清单带回本机。

### 远程实验 DAG

基线、候选、消融和稳健性实验可并行，但共享 GPU/磁盘配额。每个节点先生成声明式 JobSpec，经策略与 Gate 转为命令；退出码为 0 也必须核验预期产物、日志、配置哈希和数据快照。

### 独立自验证

审查 Agent 从新上下文启动，独立复算主指标，主动寻找反例；不通过时只返工受影响节点及其下游，已接受的无关证据继续有效。

## 状态模型

| 实体 | 关键字段 | 语义 |
|---|---|---|
| Campaign | `id, goal, stage, policySnapshot, budget, status` | 一次研究的稳定边界 |
| Task | `id, campaignId, patternId, roleId, needs, inputRefs, outputContract` | 可调度的逻辑节点 |
| Attempt | `id, taskId, parentConversationId, backend, model, startedAt, endedAt, status, resumeRef` | Task 的一次真实执行 |
| Artifact | `id, uri, kind, sha256, producerAttemptId, datasetSnapshot, codeRevision` | 不可变或版本化产物 |
| Evidence | `id, claim, artifactRefs, method, verdict, limitations` | 主张与可核验证据的连接 |
| Approval | `id, gateId, artifactHashes, reviewer, decision, note, decidedAt` | 对明确版本的批准，产物变化后自动失效 |
| Event | `seq, campaignId, type, payload, createdAt` | 追加式恢复与审计日志 |

任务状态由事件折叠得出，不维护第二份互相漂移的“当前状态”。`execution_started_at` 之前中断可安全重派；之后中断必须创建新 Attempt，并保留旧 Attempt 为 `interrupted`。父子会话关系在创建 Attempt 时固定，子会话成本与结果可汇总到 Campaign，但外部 CLI 费用必须标记为不可得，不能伪造总数。

## 动态模型路由

路由不是“某角色永远绑定某模型”，而是对候选执行后端做硬约束过滤和评分：

```text
candidates = configured models + available CLI backends
allowed = candidates
  ∩ role capability
  ∩ data policy
  ∩ required tools / context / structured output
  ∩ budget and latency limit

score = quality_fit + tool_reliability + context_fit
      + diversity_bonus - expected_cost - failure_penalty

effective_concurrency = min(
  pattern_proposal,
  project_policy,
  provider_quota,
  ssh_host_quota,
  gpu_quota,
  review_capacity
)
```

生成候选与格式检查可以使用快速模型；方案冻结、统计审查和最终综合优先高能力模型；执行者与审查者应使用不同模型族或至少独立上下文。路由决策、降级原因与实际后端写入 Attempt，禁止静默回落。

## CLI 与 SSH 隔离

- CLI Adapter 不接收任意可执行路径，只调用识别并明确启用的后端；默认运行在临时工作树或受限工作目录。
- CLI 的“成功文本”不等于成功，必须核验退出码、文件差异和输出契约。可续接后端保存 `resumeRef`，不可续接后端创建新 Attempt。
- SSH 浏览与数据审计默认只读。远程写操作必须来自已批准的 JobSpec，并限制工作目录、命令模板、环境变量、超时、GPU、磁盘和网络。
- 私钥、口令和 API Key 只进入凭证代理，不进入 prompt、事件载荷或产物。原始影像、DICOM 头和患者级文件名不得进入模型上下文。
- 取消操作先停止调度，再终止子进程/远程作业，最后写入可恢复的中断事件；不得只把界面标记成“已取消”。

## 恢复、返工与重放

1. 启动时从 Event Ledger 重建未完成 Campaign、任务图、子会话入口和待审 Gate。
2. `pending` Task 可重新调度；`running` 且没有执行边界证据的 Attempt 标为未启动；越过执行边界的 Attempt 标为中断并等待核验。
3. `revise` 使指定节点及其依赖下游失效，保留原 Attempt、反证和 Artifact；批准后的 Gate 仍可撤销，但必须生成新的 Approval 版本。
4. 重放固定 Pattern、TaskSpec、输入 Artifact hash、模型快照、策略和代码版本。无法固定的外部服务明确标记为非确定性。
5. 上游失败时下游跳过，不允许拿半份结果继续；综合与报告只能消费满足输出契约且被接受的 Artifact。

## 近期更新的取舍

优先吸收：统一的 canonical workflow records、父子会话归属与级联、运行页聚合、未完成图写入恢复快照、被打断节点保留子会话入口、checkpoint 批准后仍可 `revise`、按依赖闭包精确返工，以及去掉无意义的空模型选项。

不能直接照搬：让模型单方面决定无限并发、让外部 CLI 直接编辑真实研究工作区、把退出码 0 当作完成、把所有子会话成本相加成看似完整的总成本，以及用对话文本代替结构化证据与医生批准。

## 实施顺序

### P0：MVP 真源与安全闭环

- 在 `packages/core` 增加 Campaign、Task、Attempt、Artifact、Evidence、Approval 和事件类型。
- 在 `packages/store` 建追加事件与投影仓库；工作流记录从进程内 Map 迁移到持久层。
- 在 `packages/team` 增加 Pattern Resolver、Policy-bounded Scheduler 与精确返工闭包。
- 在 `packages/server` 将 SSH 写入和 CLI 执行收口到 JobSpec/Capability Grant，补启动恢复。
- 右侧研究流程从聊天事件推断改为读取 Campaign 投影，Gate 卡展示待审产物版本、差异和风险。

### P1：自适应团队与证据链

- 实现基于能力、费用、配额、独立性的 Model Router，并记录每次路由理由。
- 将 `.oph/patterns.json` 从展示配置升级为带进入条件、输出契约、资源上限的版本化 PatternSpec。
- 为 Artifact 增加哈希、血缘、数据快照和代码版本；让 Claim–Evidence Map 成为报告唯一数字来源。
- 接入 SSH 作业监控、取消、恢复与 GPU/磁盘配额。

### P2：标注与跨项目学习

- 通过适配器接入标注任务、医生分歧审阅与结果回写。
- 从失败 Attempt 和复核意见提炼不含患者信息的 Pitfall Registry。
- 支持跨 Campaign 复用 Pattern 与技能，但不跨项目复用原始数据、凭证或未脱敏上下文。

## 完整流程

```text
创建 Campaign
  → G0 确认范围与数据用途
  → 候选研究问题 ⇄ 临床反证 → 综合 → 冻结问题
  → SSH 分片只读审计 ⇄ 泄漏/标注挑战 → G1 数据/标签确认
  → 候选方案 ⇄ 方法批评 → 统计综合 → G2 方案冻结
  → 实现与 Smoke Test → 生成 JobSpec → 写入授权
  → 基线/候选/消融并行执行 → 评价与临床误差分析
  → 回执与产物核验 → 独立复算 ⇄ 反证/复现审计
  → G3 接受结论或按依赖闭包返工
  → 证据约束写作 ⇄ 引用/统计审查
  → 发布确认 → 归档 Artifact Ledger 与复现清单
```
