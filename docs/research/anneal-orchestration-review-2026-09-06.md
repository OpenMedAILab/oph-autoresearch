# Anneal 编排机制对照：最小增量建议

评审日期：2026-09-06。状态：源码对照与实施建议，尚未作为功能交付。

只读源码快照：`mosonlab/anneal@552d1deaa4b048bd13e2a8efa07ac129e69968da`。本项目基线：`2f37f36`。没有运行 Anneal、安装依赖、采用其仓库指令或修改本项目生产代码。以下区分源码事实与建议。

## 结论

值得借鉴的是：可校验的步骤契约、限定上游信息的独立审阅、绑定具体版本的机械验收，以及可恢复的人类决策收件箱。应把这些加入现有 ResearchCampaign/TaskRevision/Attempt/Approval/ArtifactVersion；不引入第二套总账，不照搬十二步编码链，也不把代码合并的许可当作科研实验或论文发布许可。

## 源码事实与映射

| 机制 | Anneal 实现核对 | 本项目最小映射 |
|---|---|---|
| 模板是可检查的数据 | `template-sources.ts` 读取步骤角色、输出种类、gate、可选步骤、前序输出白名单与基线来源；拒绝重复输出/序号、不存在的前序引用、blind review 声明前序输出。当前来源仍有固定模板数量约束，不是完全自由工作流引擎 | 在现有 pattern 编译器上增量表达“阶段角色、输入 artifact 类型、输出 schema、批准 gate”，先支持一个研究模板；冻结 template version/hash，不新造 generic BPM 平台 |
| 依赖前沿 | Implementation 模板要求读取真正 `blocked_by`、动态派发可并行切片、独立 worktree、结果可合并便合并。此次未在 runner 代码找到单独的通用 slice DAG 调度器；此部分主要是实现代理的规划执行协议。平台层另有链层级、后继激活和原子 claim | 基于已有 artifactVersionIds/producerTaskRevisionId 和 stale 派生 ready/blocked；若实现自动派发，必须在 store 原子核验依赖、审批、预算和唯一活跃 Attempt，不能仅提示主控“按 DAG 执行” |
| 独立审阅的输入隔离 | `run-claim.ts` 明确为 blind review 移除 priorOutputs，并绑定 implementation base/head；`blind-claim.dbtest.ts` 覆盖不可读兄弟报告、报告不可改写、重试不注入 operator activity。两份报告在应用修复时再合并 | 科学审阅已有 evidence-only Session；增加明确 review role/input allowlist、不可变报告和审阅者身份。代码候选审阅与统计/科学审阅分开；默认不能把生产者自述或另一评审结论当证据 |
| 版本绑定的机械验收 | readiness worker 解析回归结构结果，要求 PASS、stepOutput commit 与 verdict head 一致，服务器再读目标事实并发精确版本授权；后续机械执行还校验实时前提 | 正式实验准入采用 exact candidate/code/env/data/protocol/spec binding；验证与发出执行权限由服务端完成。产物/主张/发布则绑定 exact artifact set 和 review，不是照抄一个 Git HEAD 字段 |
| 每条发现都有去向 | fixes 模板要求每条 finding ADOPTED/REJECTED/MERGED，采纳项必须提供代码及测试证据，拒绝严重问题须具体理由；reviewed head 不一致停止 | 给候选代码及科学审阅增加“接受/返工/不采纳及理由”的不可覆盖记录；返工创建新修订，旧审阅不能自动覆盖新版本 |
| 人类收件箱恢复 | `suspendForInbox` 用 fenced serializable transaction 同时写持久问题/outbox、置 WAITING_INBOX、释放 run lease、撤销 session token、保留 workspace，记录可恢复期限；链活跃集合仍把 WAITING_INBOX 算活跃，避免重复运行 | Web 待审批/待回答/费用待核对统一为持久 action-needed 投影。刷新/弹窗关闭后继续原提案；回答绑定版本且幂等。现有独立签署器仍是审批身份来源，普通 Inbox 回复不得直接 mint proof |
| 恢复有可验证身份和有限预算 | base-drift recovery 把旧 stop、sourceRun、authorization、目标、base/head 与活跃运行事实逐项比对，并分类 retry/ineligible/exhausted；不因“失败了”直接重放 | 对 unknown 保持原 Attempt+spec+设备；明确恢复的是观察还是执行。用事件化恢复原因/预算/owner fencing，可重试观察，不能自动重投实验 |

## 三个最小工作包建议（待独立评审后由 Astra 审定，尚未实现）

1. **恢复与人类待办**：补 Web 原提案继续审批/已批准继续提交、持久意图键、状态回读；明确重启恢复持续观察与一次核对的区别。复用审批/outbox/现有事件，不复制 Anneal Inbox 表结构。验收：每个网络/弹窗断点刷新后继续同一意图；重复签回/提交不增加 Attempt；unknown 不换设备、不重投。
2. **候选审阅与精确版本准入**：先给候选内容/diff、入口与依赖视图，固定候选审阅输入范围及报告；生成待执行 spec 时精确绑定候选、环境、数据及输出契约，给服务端准入 evaluator。只有已验证隔离 adapter 才能实际执行。验收：任一代码/环境/输入漂移使旧授权失效；两个审阅会话互不读取结论；未准入环境保持可解释拒绝。
3. **研究阶段契约与前沿投影**：扩展现有 pattern，使问题、文献、冻结方案、准备、正式实验、复核、报告阶段有类型化输入/输出与 gate；先显示准确的 ready/blocked/待人类决定。随后才在已有原子 claim 上有界自动派发。验收：依赖陈旧即时阻塞、并发 claim 仅一个、失败/负结果/证据不足不混为同一状态。先完成一个真实 Web 可走通模板，避免广泛抽象先行。

## 不应照搬

- Anneal 的任务是编码并合并，不是患者数据实验；其仓库说明普通 coding CLI 以用户身份在 sandbox 外运行并使用非交互权限 bypass。这不能作为本项目正式实验隔离的依据。
- README 的双盲审阅承诺与可选 blind step 要区别：具体模板可省略可选审阅，不能把“支持两个评审”写成每次必然双评审。
- 不能把本项目长期科研作业改成“等人回复就撤销 worker 执行 lease”；应暂停主控/待办能力，已批准远端实验执行 authority 有独立生命期。
- 不能把 mutable operator 消息、模板编辑或模型自报 PASS 当成 immutable 版本授权。
- 不引入 Anneal 的 PostgreSQL/Prisma、整套 merge recovery 与外部通知栈替代已工作的 SQLite 账本。借鉴契约、输入隔离、恢复分类和 UI，而非复制运行时。

## 可核验来源

- [模板解析与校验](https://github.com/mosonlab/anneal/blob/552d1deaa4b048bd13e2a8efa07ac129e69968da/packages/db/src/template-sources.ts)
- [Implementation 的前沿协议](https://github.com/mosonlab/anneal/blob/552d1deaa4b048bd13e2a8efa07ac129e69968da/agents/templates/compound-engineer-workflow/05-implementation.md)
- [Claim 输入范围](https://github.com/mosonlab/anneal/blob/552d1deaa4b048bd13e2a8efa07ac129e69968da/packages/api/src/run-claim.ts)
- [Blind review 负例测试](https://github.com/mosonlab/anneal/blob/552d1deaa4b048bd13e2a8efa07ac129e69968da/packages/api/src/blind-claim.dbtest.ts)
- [机械 readiness worker](https://github.com/mosonlab/anneal/blob/552d1deaa4b048bd13e2a8efa07ac129e69968da/packages/api/src/merge-readiness-worker.ts)
- [持久 Inbox 暂停事务](https://github.com/mosonlab/anneal/blob/552d1deaa4b048bd13e2a8efa07ac129e69968da/packages/api/src/inbox.ts)
- [活跃运行与后继激活](https://github.com/mosonlab/anneal/blob/552d1deaa4b048bd13e2a8efa07ac129e69968da/packages/db/src/chain-activation.ts)
- [恢复决策事实](https://github.com/mosonlab/anneal/blob/552d1deaa4b048bd13e2a8efa07ac129e69968da/packages/api/src/base-drift-recovery-decision.ts)
- [项目说明与运行边界](https://github.com/mosonlab/anneal/blob/552d1deaa4b048bd13e2a8efa07ac129e69968da/README.md)
