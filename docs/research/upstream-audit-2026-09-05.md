# 上游固定提交逐项审计

## 执行进度看板

- 日期：2026-09-05；状态：27 项固定提交取证完成；超时与摘要记账已实现并通过 Astra 独立复审。完整门禁结果见 [本轮回执](receipts/2026-09-05-restricted-lineage.md)。
- 本地：`feat/mvp-research-workbench`，`e4d3322f19b33c545819b4b5e15a50eaee4c5d33` 加已保全的用户/两批本地修改。
- 上游：[a4892602…ce7f53b4](https://github.com/qingxueyanshang/qywork-qingyan-harness/compare/a4892602...ce7f53b4afeb22b48650ab2e13395c671cc0b5a5)，GitHub 比较结果 ahead=27、behind=0；这是固定快照，不是持续跟踪声明。
- 下一步：按本轮回执核对最终整合门禁；实体/节点/提前返回仍需成组方案，未移植条目不算已完成。

## 27 个提交的处置

此表是阅读固定上游 patch 并对照本地实际文件后的审计，不表示这些提交已合入。UI和迁移不批量复制，外部源码采用时保留 Apache-2.0/NOTICE。

| 提交 | 上游意图 | 本地处置 | 依据/依赖 |
|---|---|---|---|
| [261c22f](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/261c22ffb0d976c4842b0bab5d487ff8d97b66b5) | refactor(role): name the role command and tool for what they create | 保留当前命名 | 本地 tools/src/subagent-define.ts:27 已对外提供 define_subagent；不为上游命名批量迁移调用方。 |
| [36f78c0](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/36f78c0df01f1dcf4c9c071bdf3fe5641a263cc9) | refactor(subagent): make sub-agents conversation-scoped entities with explicit kinds | 部分采用 | 父会话归属已落库；独立 kind/完整临时子代理生命周期未移植。 |
| [f932298](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/f9322988c82a4e63b39817a3b09ddf8c6aa72019) | feat(runtime): put roles, CLIs and this conversation's sub-agents in the run snapshot | 待成组评估 | 完整子代理快照依赖上项实体合同，不能只复制提示词。 |
| [9ff671c](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/9ff671c8541aff2f9abbb884182cbaea8d32e6d9) | feat(core,store,team,server,web): single source of node state on delegation cards | 待成组评估 | 本地 core workflow 与科研 Attempt 分工明确；统一委派卡节点需同时修改投影/事件/界面。 |
| [c6764a9](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/c6764a9e1039326434fb1bb8cbd6647c5393f2bc) | feat(server,web): list a conversation's sub-agents and workflows | 不直接移植 | 已有用户工作台布局改动；会话子代理列表应按产品需求接现有页面。 |
| [fad1f71](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/fad1f71fd3ec82c92a0f3576ee3c18aff9d75137) | feat(scripts): real-model replay of the delegation scenario | 参考验收方式 | 真实模型回放脚本需要独立测试环境；本地科研已有隔离 HTTP smoke。 |
| [d6cb729](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/d6cb72920cb80621fa9f55e43cbc889e943d4c8b) | fix(scripts): a replay round with failed receipts still counts as delivered | 随脚本评估 | 修改上游专属回放脚本的完成判据，不是当前产品运行代码。 |
| [b367e42](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/b367e425ef451a06efe13e2af64bbff66518d7d5) | fix(scripts): keep every replay ledger in a timestamped directory | 已借鉴方式 | 本地 smoke 已写随机隔离目录并保留回执，不复制整套脚本。 |
| [b591420](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/b591420a52a4ce760cdfbced0c4c6d48e553926d) | fix(web,store,team): restore the delegation card, migrate old delegation rows, stop re-sending the task on revise | 待成组评估 | 卡片、旧委派记录迁移和 revise 输入语义捆绑；须与 NodeState 成组评估。 |
| [39b205d](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/39b205d61932c13aa256e3a9b49e580dd088d395) | fix(web,store): drop the card header label and time; name sub-agent cells by their name | 不直接移植 | 视觉布局/命名，不覆盖用户现有 Transcript 修改。 |
| [d61c0dd](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/d61c0dd8c0c4d339a9034ac34ad9eb72370acc8d) | feat(web,server,team,store): one rule for delegation cells | 待成组评估 | 委派单元格规范需完整节点合同配套。 |
| [923ef17](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/923ef17036d2ed99d25ffd2896b5ff7229074542) | fix(web,store): drop the card header; widen the single cell; copy old single-dispatch durations | 不直接移植 | 旧单派发耗时回填涉及上游历史迁移；不可复用迁移编号。 |
| [b1f1079](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/b1f1079899bc7b97020c16883d836887fdc9289a) | fix(web): fixed 160px single cell, same as workflow cells | 不直接移植 | 160px 单元格是上游视觉选择。 |
| [3b31cae](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/3b31caea9acb053f44227a2107e4036e89430d1c) | fix(web,server,team,store): every sub-agent cell prints its name | 待成组评估 | 子代理显示名必须来自实体而非UI猜测，依赖实体合同。 |
| [4cd0605](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/4cd06055766b5964af5364a50e6d8702c177c127) | fix(web): single cell 220px wide | 不直接移植 | 220px 单元格取代前一视觉选择，不是科研功能依赖。 |
| [e0ee1e2](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/e0ee1e241c0ffc90b77d1cabf0b6d4111ac9db0f) | feat(agent,server,tools,web): tell the model the facts before stopping it; drop the sub-agent panel | 待局部评估 | 停止前事实提示有价值；本地已存在 unfinished-todo 监督，不能复制形成两套规则。 |
| [b33b85a](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/b33b85a77a57d55111a92148a016b314042d5d62) | refactor(runtime,tools): one set of facts for delegation, each rule written once | 待成组评估 | 委派事实装配需要前述实体/节点合同，避免新增平行权威。 |
| [7dd92ab](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/7dd92ab1d78ec053079523fff67b39f7e319e128) | fix(server,web): unresolved target settles the cell; interrupted child stays interrupted; run page prints names | 待成组评估 | 目标解析与中断终态须对照本地 memberOutcome/工作流回执进行专项回归。 |
| [e5b2db6](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/e5b2db65cb4c63876a636290994c04483075936a) | chore(store,team,core,web): finalize migration statements; drop dead field and stale comments | 禁止复制迁移 | 上游历史迁移与本地36不同；仅参考最终数据约束。 |
| [1baba77](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/1baba7787ba117590ad82251a83a8f9081afd949) | fix(scripts): key the replay on the dispatch that started the cells and on the revise call | 随脚本评估 | 上游回放脚本派发键定位，本地无同一脚本入口。 |
| [58a7a41](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/58a7a41bcb65f651b8add943ea56ffd9bc64b886) | feat(team): hand back failed receipts before the batch settles | 待成组评估 | 本地 orchestrator.ts:220-236 等待在跑节点收尾；提前返回必须与句柄存活共同实现。 |
| [3dfb2c0](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/3dfb2c091fcb00096db3fe4ac865b9c4f658aa3b) | fix(server): keep in-flight handles across early returns | 与提前返回成组 | 本地 delegate.ts:330 runGraph 从持久工具步骤恢复；不能只增加早返回而丢掉 in-flight 句柄。 |
| [0bcdb4d](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/0bcdb4dc5f978c595d2229d6e1dc42b3a5e8984f) | fix(agent): judge silence by one clock and stop resending timed-out requests | 建议实施 | 本地 loop.ts:460-471 仍可重发 stream_idle_timeout，未先排除 timedOut。 |
| [129f8fd](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/129f8fd8a156be9df38016a7366958ad02d3e0ed) | chore(scripts): let the replay pick the parent model | 随脚本评估 | 上游测试脚本选父模型，本地不需要复制整套回放。 |
| [a2e4abd](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/a2e4abdedc6339825e17047c7ea2cdd0ff32f25e) | chore(server): log slow workflow start-up | 按诊断需要评估 | 启动耗时日志不会补齐科研合同，不作为主功能依赖。 |
| [044e45b](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/044e45b43933e100f9b57f8ecaee121b240e78bf) | feat(agent,store,web): record in-run summary requests as ordinary requests; keep transcript rows and fold state by id | 建议实施 | 本地无 SummaryTrace/purpose；运行中摘要仍未作为普通 provider request 进入同一请求账。 |
| [ce7f53b](https://github.com/qingxueyanshang/qywork-qingyan-harness/commit/ce7f53b4afeb22b48650ab2e13395c671cc0b5a5) | feat(web): label summary requests as context compaction in the result column | 依赖摘要记账 | UI摘要标签只能跟随真实 purpose 数据，不能先猜标签。 |

## 两项可独立推进的取证

以下两项描述本轮修改前的取证基线，行号也对应修改前。当前超时实现已补齐 `ProviderError.timedOut`、传输层超时分类、重发前拒绝和 600000ms SDK 兜底；保留 loop silence 诊断且 SDK `maxRetries` 仍为 0。摘要已接入 `SummaryTrace` 与本地新迁移 37 的 `purpose`，按实际摘要模型定价、运行内合并一次、手动摘要独立结账、未知用量保留 null；预取消不发送，已发送后取消等待实际结算并保留已接收用量。Astra 独立复审与真实本地 SSE 取消链验证未留下具体缺陷。原项目没有上游逐请求详情表，本轮没有声称移植摘要 UI 标签。

1. **超时重复请求**：`packages/agent/src/loop.ts:460` 的 RESENDABLE 仍含 `stream_idle_timeout`，`resendBackoffMs` 对 `timedOut` 不提前拒绝。上游 0bcdb4d 在最早重试裁决处去掉这一行为，避免将尚在推理的长请求再次发送。依赖：补齐本地尚无的 ProviderError.timedOut 事实标记及传输层 timeout 分类，并接现有 stream silence 诊断；成本：小型 loop 修复及超时/普通网络错误差异回归，不需 schema/UI 迁移。本地 `packages/ai/src/types.ts:28` 还将 SDK 响应头兜底设为 60000ms，而 loop 思考看门狗最高 540000ms；同提交将 SDK 兜底调为 600000ms，maxRetries 仍为 0，避免两个计时器竞争。此项需与超时不重发成对验证。本文没有声称已向真实模型复现收费。

2. **运行内摘要请求记账**：本地 `packages/agent/src/compaction.ts` 的 Summarizer 没有 SummaryTrace；`packages/store/src/usage.ts:406` 的摘要样本查询只读 usage_ledger。上游 044e45b 增加运行内摘要的 request purpose、请求状态及 usage 合并，手动摘要仍无 run。依赖：agent/runtime/store/core/API/UI 的同一请求合同和新迁移编号；成本：多包成组变更，必须覆盖摘要成功、失败、中断、容量恢复及不重复计费，不能只复制 UI 标签。

## 不应单独移植的执行改动

上游 58a7a41 的失败提前返回与 3dfb2c0 的活动句柄保留互相依赖。本地 `packages/team/src/orchestrator.ts:140-236` 当前在单次调用中持有运行 Promise，等待收尾；`packages/server/src/delegate.ts:101` 从 SQLite 工具步骤 fold 恢复 workflow。只复制提前返回会留下仍执行却没有可靠持有者的节点。需结合实际节点持久化、取消、续问和父会话生命周期再决定，不应以 UI 刷新补救。
