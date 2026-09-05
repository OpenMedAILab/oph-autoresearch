# oph-autoresearch：Codex 执行任务包

日期：2026-09-05。性质：研究评审产生的实施规格，不是已实施或已测试声明。本文件没有修改远端仓库。

## 0. 执行身份与不可突破的约束

请求以 **GPT-6 Astra** 为开发主控、**GPT-5.6 Terra** 为开发子代理。Astra负责方案裁决、接口冻结、合并、最终验收；Terra只负责有界任务。最多同时运行3个Terra，连同Astra共4槽。运行环境无法提供这些名称时必须报告，不得谎称已使用，也不得静默替代。这些名称仅是开发代理分工，不得写死为产品中所有研究角色的模型。

保持Bun/TypeScript单体内核、oph CLI/serve、HTTP/WebSocket、SolidJS、Tauri 2、SQLite，以及现有packages边界。不得一次性重写。不得自动发布、发PR、安装未审核第三方代码、连接真实患者数据或执行未批准的远程作业。

评审时实际读取的是：
- 仓库：https://github.com/OpenMedAILab/oph-autoresearch
- 分支：`feat/mvp-research-workbench`
- HEAD：`e4d3322f19b33c545819b4b5e15a50eaee4c5d33`
- 提交时间：2026-09-04 09:36:47 UTC。
- 上游：https://github.com/qingxueyanshang/qywork-qingyan-harness
- 上游默认分支：`master`；已读取HEAD：`ce7f53b4afeb22b48650ab2e13395c671cc0b5a5`，2026-09-04 15:28:22 UTC。
- 上游文档基线：`a4892602`，其后至上述HEAD为27个提交。

本地还有用户未提交的SSH、PDF、用量、Agent循环、CLI探测和UI改动。评审看不到它们。以上远端SHA不是“覆盖本地”的许可。

## 1. A00：首先保护工作区并冻结接口

Astra先只读运行 `git branch --show-current`、`git rev-parse HEAD`、`git status --porcelain=v2`、`git diff --stat`、`git diff --cached --stat`，检查未跟踪文件、迁移版本和现有测试脚本。禁止 `reset --hard`、`clean -fd`、自动stash、切换或覆盖脏工作区。

建立本地变更清单：文件路径、责任人、内容哈希、是否阻塞计划任务。敏感差异不得上传。需要备份时仅写入用户授权的本地受控目录。实现工作从独立worktree开始；先明确哪些本地变更需要纳入实施基线。不得把“基于远端SHA实现完成”冒充“已与本地脏改动集成完成”。

冻结以下建议新增契约（名称可在A00一次性调整，之后变更必须由Astra审批）：
- `packages/core/src/research/contracts.ts`
- `docs/research/adr-001-control-execution-evidence.md`
- `docs/research/implementation-baseline.md`
- `docs/research/ownership-map.md`

Astra独占：各包`src/index.ts`导出、根package/lock文件、`packages/store/src/schema.ts`及迁移注册、共享HTTP/WS协议、旧server装配入口、现有App/ResearchWorkspace接线，以及与本地脏改动相交的旧文件。Terra通过新模块和明确的接线补丁建议交付，不并行争抢这些文件。

**不能按本评审直接占用迁移35。** 已读取项目schema为34，上游基线已到38，且本地可能有新增迁移。先清点实际版本，再由Astra唯一分配迁移ID。历史迁移不得就地改写。

## 2. 已有能力与不应重复实现的部分

以下判断来自固定SHA的静态阅读，不代表测试通过：
- `packages/server/src/delegate.ts` 的 `workflowRecords` 已从SQLite工具步骤取记录，使用 `foldWorkflow` 恢复待审查工作流；不能继续写“workflow只有内存Map”。
- `packages/team/src/orchestrator.ts` 已有DAG校验、并发、checkpoint和节点级 `revisionClosure`。
- `packages/server/src/team-run.ts` 已新建成员Session，并检查成员终止原因；不是只看有无文本。但成员共享项目目录，科研证据隔离未得到强制保证。
- `packages/server/src/bus.ts` 已有streamId、5000帧保留窗口和断线/跨流resync；不得用第二套临时状态覆盖它。
- `packages/tools/src/ssh.ts` 已有路径边界、remote realpath和readOnly检查，但图像可作为data.images返回，写命令仍为shell字符串；不具备研究审批绑定。
- `packages/runtime/src/extensions.ts` 已装配MCP与Plugins；安装/加载不等于受研究策略治理。
- `apps/web/src/components/ResearchWorkspace.tsx` 当前从会话工具记录和角色/任务名称推断阶段；“等待人工审核”不能代表真正的人类身份审批。

## 3. 核心契约

### 3.1 对象与不可变版本

- Campaign：研究目标、政策快照、预算、状态、当前计划版本；不等同于Conversation。
- TaskRevision：显式stageId、任务类型、依赖的确切产物版本、输入/输出schema、backend约束、验收规则、预算。冻结后不可就地改写。
- Attempt：一次实际执行，引用TaskRevision，记录backend/model/provider/skill快照、dispatchId、幂等键、lease、fencing token、remoteJobId、状态和回执。
- ArtifactVersion：不可变内容hash、媒体类型、数据分级、producerAttempt、存放位置、输入版本、schema与验证结果。远端患者数据仅用不透明引用，不能把患者ID哈希当作匿名产物。
- Evidence：主张、支持/反驳/不确定关系、来源快照、精确定位、机器结果引用、适用人群和限制。
- Approval：可鉴别的人类操作者、审批种类、decision、bundleHash、policyHash、scope、有效期、预算/尝试次数限制。与现有WorkflowCheckpoint彻底区分。
- ResearchEvent：追加式事实，不覆写历史。Outbox：与事实和状态同事务提交后推送。

旧聊天/工具记录保留现有含义；导入科研视图只能标记`legacy_unverified`。禁止补造审批人、当时的产物hash、远端退出码或未知用量。聊天删除不得顺带级联删除已接受的科研证据账本。

### 3.2 事件与投影

```ts
interface ResearchEventV1 {
  schemaVersion: 1;
  eventId: string;
  campaignId: string;
  campaignSeq: number;
  entity: { kind: string; id: string; revision: number };
  type: string;
  actor: { kind: 'human' | 'agent' | 'system' | 'runner'; id: string };
  causationId?: string;
  correlationId: string;
  idempotencyKey?: string;
  occurredAt: string;
  payload: unknown; // 各event.type必须另有运行时schema，不接受未校验JSON
}
```

数据库唯一约束：`eventId`、`(campaignId,campaignSeq)`、命令的幂等键及Attempt的dispatchId。业务状态、事件、outbox必须单事务；不能先发WebSocket再写账。

现有EventBus的streamId/seq继续负责传输流；新增research capability与`research.event`载荷承载持久化campaignSeq。REST快照必须携带lastCampaignSeq；WS重放与REST投影必须来自同一持久化事实。重复事件去重，缺口请求补齐，超范围明确resync，旧客户端仍能使用聊天功能。

建议ResearchRepository端口：`createCampaign`、`getSnapshot`、`appendCommand(expectedRevision, idempotencyKey)`、`listEvents(afterSeq)`、`claimAttempt`、`renewLease`、`saveReceipt`。任何重试的幂等键范围和冲突错误都必须在A00冻结。

### 3.3 成功与取消

Attempt进程完成不等于Task验收，更不等于Campaign发布。必须分开：
`queued / running / reconciling / cancel_requested / cancelled / failed / succeeded`，以及Task的`unverified / verified / accepted / stale / rejected`。

SSH断连后不能直接写failed并重投；先用相同dispatchId查询远端作业。无法证明状态则保持unknown/reconciling。杀掉本地ssh不能视作远端已取消。必须收到远端调度器或受控进程组确认后才能进入cancelled。

## 4. 硬策略与审批

研究硬策略位于主控之外，且在调用工具、原生CLI、MCP、Plugin和网络出口时统一执行。产品的`full`模式、角色提示词、Skill元数据都不能授权患者数据外传或绕过人类审批。

明确分开：
1. 主会话对内容的WorkflowCheckpoint审查；
2. 人类协议冻结批准；
3. 人类远端写入/JobSpec批准；
4. 人类结论发布批准。

人类actor从受认证的UI或医生网站身份映射中取得，不接受模型在JSON中声称`actor=human`。模型凭证不得调用批准端点。审批接口需要工作区/研究作用域、重放保护和适当的浏览器来源检查。

bundleHash由规范化的协议、数据快照、split、代码/dirty补丁、环境、JobSpec、输出契约、policy和预算组成。绑定内容改变时追加失效事件，阻断后续派发。旧审批历史保留。撤销已启动作业的批准不等于作业回滚，应进入停止请求和状态核对。

返工按“产物版本被消费的边”反向闭包计算；保留未受影响的任务、负结果及反证。不得仅凭同名文件或最新聊天摘要决定返工。

## 5. SSH与CLI执行契约

### 5.1 只读审计

区分“普通公开/已批准脱敏工作区”和“受限临床工作区”。后者默认只允许受审核的远端聚合模板，禁止原图、DICOM头、文件名、患者标识、逐例标签/预测进入本地工具结果、浏览器缓存、WS、日志、SQLite或模型上下文。

过滤必须发生在远端汇总及本地入口，不能先落盘再脱敏。小样本抑制只是风险控制的一部分，阈值可由机构配置，不能宣称某个n阈值保证匿名化。

保留现有路径realpath守卫，但实际权限依赖远端只读账号、ACL、受限命令或等效隔离，不依赖客户端Boolean。没有这种保障的backend必须显示能力不足。

### 5.2 JobSpec与Runner

JobSpec包含：templateId/templateVersion、受校验argv、codeCommit/dirtyPatchHash、environmentDigest、datasetSnapshot、splitHash、configHash、逻辑输入输出根、CPU/GPU/RAM/磁盘/时长预算、网络允许项、outputSchemas、approvalId/bundleHash、dispatchId/idempotencyKey。**不接受任意shell command字符串作为研究写入合同。**

Runner端口：`submit(spec, approvalCapability)`、`getStatus(dispatchId)`、`cancel(dispatchId)`、`collectReceipts(dispatchId)`。

远端持久化唯一dispatch登记：同一键和同一hash返回原job；同一键不同hash必须冲突，不能创建第二个job。lease/fencing或等效事务约束阻止本地重启/并发worker重复派发。分配独立输出目录，禁止覆盖旧Attempt。

取消与超时经过实际远端状态核对。输出只接收契约内脱敏聚合和hash清单；标准输出同样可能包含敏感信息，必须隔离和筛选。

### 5.3 原生CLI

给CLI单独worktree/scratch和最小环境变量/凭证集合。已有CLI自己的登录态不应自动变成患者服务器权限。记录可执行版本、请求/实际可观测模型、外部session句柄、任务/产物hash及退出原因。无法观测模型或token时显示unknown，不伪造零用量。

backend capability必须明确是否支持隔离、恢复、结构化结果及审查新上下文。不能安全隔离的CLI不承接受限临床任务。CLI退出0只是执行回执，产物验证另算。

## 6. 独立复核、统计与Skills

Reviewer使用新context和只读EvidencePack，不继承执行者聊天、未核验解释或共享自动记忆；运行日志与必要反证可以作为显式证据输入。初次独立判断封存后再综合。换模型是额外多样性，不替代上下文隔离与机器复算。

统计模板必须覆盖患者/双眼/访次/近重复分组泄漏，训练集内fit预处理，验证集选阈值，冻结测试集只做预设评估。相关观测的区间方法和比较方法须在协议中指定；不从结果反推检验。NaN/Infinity/越界指标必须拒绝或标明不可估计，单类测试集不得补成0.5。所有数值主张必须指向已验证的聚合产物。

新增`.oph/skills.lock.json`：originRepo、commitSHA、skillPath、contentHash、license/SPDX、依赖锁、scriptHash、允许工具/网络/数据级别、支持backend、评测集版本、审核人和状态。执行固定Skill快照，不随上游main漂移。

Skill不能自授权限。外部技能的自动安装、自动绘图、自动调用Bash、隐藏查询日志、临时换统计检验等建议必须按本项目规则裁剪。自身演化只产生候选Skill，经过评测/审批才晋升。

优先验证的来源（未安装、未执行）：
- K-Dense `1e5eeffbdad3749125afe7ab48a39694e27f181c`，`skills/hypothesis-generation/SKILL.md`、`skills/statistical-analysis/SKILL.md`、`skills/literature-review/SKILL.md`：逐项裁剪后导入。
- ToolUniverse `22661b6053ec1531b78f6f7ec050dd0bf56f78cc`，`plugin/skills/tooluniverse-literature-deep-research/SKILL.md`：借鉴检索分解；不得自动继承Bash授权或将其T1–T4视作临床证据等级。
- PaperQA2：用公开文献语料建立可定位原文证据，不传患者数据。
- MONAI/nnU-Net：远端受控执行依赖，分别用于医学影像与分割基线，不是本地编排替代品。
- MLflow/DVC：远端追踪与数据版本，向本地输出脱敏引用；不启用无筛选autolog/自动上传。

## 7. UI映射与真实状态

6个UI阶段映射9个执行阶段：
- 问题建模：question、literature；
- 数据审计：dataset_audit；
- 方案冻结：protocol_freeze；
- 远程实验：smoke、experiment、evaluation；
- 独立复核：independent_review；
- 研究输出：release。

每个Task必须携带stageId。禁止通过role名/task字符串猜测研究阶段，也不能用“最后一张workflow完成”代表整个阶段已验收。

UI分别显示模型审查、人类待审批、执行中、状态未知、取消请求、已取消、证据未验证、已验收、审批失效。显示实际backend和观测到的用量来源。刷新、重启、断线后读取同一投影。

医生网站未来通过有身份的审批与版本化LabelSet引用接入。患者级标注留远端；本地只接收获准的汇总及不可变引用。标签版本改变应触发受影响数据、方案、评估和结论的失效检查。

## 8. P0/P1/P2与纵切片

P0：研究数据出口策略、HumanApproval、不可变产物与Attempt账本、受控Runner最小实现、取消/幂等/重启核对、真实UI状态；仅在合成数据上贯通。
P1：丰富证据检索、受策略约束的Pattern编译、跨后端隔离与恢复、精选Skills评测、医学影像模板、远端MLflow/DVC适配和上游稳定性修复。
P2：医生网站身份与LabelSet协议、队列与多设备资源调度、经评测的自适应策略、机构级部署治理。不得P0就引入第二套通用Agent框架。

最小纵切片：合成/公开非患者数据的一项受限眼科影像任务 → 公开文献证据 → 远端只读聚合 → 冻结协议和CPU smoke JobSpec → 人类绑定hash批准 → 真正远端执行 → 结构化receipt和有限指标 → 新上下文复核并机器复算 → claim-evidence map → 人类批准导出报告。

必演示：提交后断线并重启；重复提交不产生第二个job；配置变更使旧审批失效；取消须远端确认；含敏感canary的文件名/图片/日志不得出现在本地或模型载荷。

## 9. 批次任务与文件所有权

所有下列路径均为建议新增目录，A00须先核实是否与本地未提交文件重名。默认每批最多3个Terra；批间由Astra冻结已合并接口后再启动。模块共享文件变更交由Astra串行完成。

| 批次 / ID | 负责范围 | 输入 → 输出契约 | 验收与依赖 |
|---|---|---|---|
| 0 / A00 Astra | core/research/contracts.ts、docs/research/、所有权表 | 真实基线/dirty清单 → 合同v1、错误码、迁移编号策略、文件锁 | 分支与SHA记录可复核；每个P0条件有测试入口；其余任务等待 |
| 1 / T01 Terra | packages/core/src/research/validators.ts、reducer.ts、对应tests；不改contracts/index | 合同v1 → schema验证、状态转移、canonical hash、版本闭包纯函数 | 重复/越序事件、非法转移、NaN/越界、闭包精确性；依赖A00 |
| 1 / T02 Terra | packages/store/src/research/*、独立迁移fixture；不改旧schema注册 | 合同v1 → Repository、事务事件/outbox、幂等和CAS | 同键并发、崩溃事务原子性、legacy不伪造、FK/迁移fixture；依赖A00 |
| 1 / T03 Terra | packages/runtime/src/research/policy/*、packages/tools/src/research/egress/* | 合同v1 → PolicyDecision与脱敏/拒绝结果 | full/CLI/MCP/Skill不越权；文本/路径/图片/日志canary；依赖A00 |
| 2 / T04 Terra | packages/team/src/research/approval/*、invalidation/* | T01–03接口 → 审批有效性、bundle绑定、精确返工服务 | 伪human、旧hash、过期、撤销、变更并发、最小返工；依赖T01–03 |
| 2 / T05 Terra | packages/tools/src/research/ssh-runner/*、独立runner协议fixture | JobSpec+审批能力 → submit/status/cancel/receipt端口 | 相同键只创建1job、冲突hash拒绝、失联unknown、取消确认、路径/输出边界；依赖T01–03 |
| 2 / T06 Terra | packages/server/src/api/research/*、packages/server/src/research-events/* | Repository+Policy → REST命令/快照、WS research事件适配 | 身份/归属、CAS409、同键返回、快照/流一致、旧客户端聊天兼容；依赖T01–03。审批调用先用已冻结端口，不重写T04 |
| 3 / T07 Terra | packages/team/src/research/scheduler/*、packages/runtime/src/research/backends/cli/* | T04/05/06 → 资源调度、Attempt恢复、CLI隔离、新Reviewer上下文 | lease过期/fencing、无重复派发、预算、不同父任务不能续接、审核context无隐式历史；依赖T04–06 |
| 3 / T08 Terra | packages/runtime/src/research/skills/*、packages/tools/src/research/sources/* | 合同/策略/Repository → Skill lock与公开文献SourceSnapshot | SHA/hash漂移拒绝，来源失效，prompt injection不授权，摘要/原文不混淆；依赖T01–03 |
| 3 / T09 Terra | apps/web/src/components/research/*、apps/web/src/lib/store/research/* | T04/06端口 → 六段真实状态UI、审批和证据视图 | 刷新/断线/重启状态一致；不靠关键词；waithuman≠modelreview；未知用量不写0；依赖T04/06 |
| 4 / T10 Terra | packages/tools/src/research/evaluators/*、tests/research/fixtures/clinical-synthetic/* | JobSpec与schema → 冻结的合成影像smoke/评估模板 | 患者分组泄漏、单类指标、CI单位、finite/range、receipt可复算；依赖T05/T08 |
| 4 / T11 Terra | tests/research/upstream/*、docs/research/upstream-port-audit.md；旧热文件只提补丁 | 上游固定SHA差异+本地dirty映射 → 可选择移植补丁与回归测试 | NodeState/父子归属/超时/summary用量逐项证明；不搬UI；不批量迁移；依赖Astra当前整合基线 |
| 4 / T12 Terra | tests/research/e2e/*、scripts/research-smoke/* | T04–09端口 → 故障注入、迁移、跨进程/真实SSH验收脚本 | 测试搭建可与T10并行；最终真实纵切片必须等T10及相关整合完成 |
| 每批末 / A01 Astra | 共享接线、根脚本、旧热文件、迁移注册、NOTICE | 各Terra交付 → 一个可运行集成版本和验收记录 | 串行整合；重复测试真实整合树；解决旧功能/dirty冲突；不因mock通过声称远端通过 |
| 最后 / A02 Astra | 验收报告和发布开关 | 所有P0实现/真实日志 → 完成/未验证/阻塞矩阵 | gate/build、真实非患者SSH纵切片、回滚演练；未通过硬门禁不能“完成” |

T01/T02/T03同批并行；T04/T05/T06同批并行；T07/T08/T09同批并行。T10/T11/T12仅文件范围不重叠时并行。Astra可在下一批前让Terra交叉复核，但仍不得超过3个子代理。任务不得私自增加子代理。

## 10. 每个Terra必须提交的交付回执

```yaml
task_id: Txx
base_commit: <实际worktree基线>
owned_paths: []
changed_paths: []
contract_version: research-v1
input_dependencies: []
implementation_summary: ''
commands_executed: []
tests_passed: []
tests_failed: []
tests_not_run: []
artifacts_and_log_hashes: []
upstream_sources_and_licenses: []
security_or_privacy_limitations: []
shared_file_integration_requests: []
rollback: ''
```

未执行的命令不能进入commands_executed；mock只能证明相应单元边界，不能替代真实执行的日志。不得改测试期望、跳过失败用例、篡改评估代码来制造通过。

## 11. 验收矩阵（目标，不是当前测量结果）

| 类别 | 必须通过 |
|---|---|
| 身份与门禁 | Agent不能签发HumanApproval；篡改bundle任一绑定项后阻断写入与发布；没有批准时执行器没有副作用 |
| 幂等 | 100次相同提交只产生1个远端job；同键不同spec返回冲突；重启后同样成立 |
| 故障恢复 | 在落盘前、落盘后未发流、远端已收未回、回执已收未入库等点注入故障；无伪成功，无无依据重跑 |
| 取消 | UI立即显示cancel_requested；只在远端证明终止后显示cancelled；迟到回执与撤销/取消有确定裁决规则 |
| 事件 | 重复、乱序、缺口、跨进程流变化后，REST/WS/reducer最终投影完全一致 |
| 隐私 | 指定canary在原始PNG/DICOM头/路径/逐例CSV/stdout中时，不能进入本地持久化、WS、预览缓存或模型请求 |
| 统计 | 双眼/多访次/近重复跨split被拒；预处理或阈值使用测试集被拒；NaN/Infinity/无定义指标不成“最佳” |
| 证据 | 发布前全部数字主张引用已验证产物版本；sourceKind明确；失效来源/缺原文定位明确降级 |
| Skills | 内容hash漂移、未批准来源、权限升级、依赖变化会阻断或要求复核；格式通过不等于内容正确 |
| 兼容 | 原有聊天、文件/PDF、SSH普通非临床浏览、CLI探测、用量与模型选择不回归；不覆盖用户dirty改动 |
| 迁移 | 真实旧库副本及schema fixture升级，完整性/FK/记录数量/关键hash验证；不能发明历史事实 |

固定SHA的根package.json已定义：`bun run gate`（TypeScript、Biome只读检查、测试、Rust check）、`bun run build`，以及`bun run smoke:serve`。实施时先确认实际工作区脚本未改变再运行。不要把会写文件的`bun run check`当成只读检查。真实SSH纵切片需要专门脚本和明确的非患者测试目标，不能拿smoke:serve代替。

## 12. 回滚策略

新增研究模块受独立feature flag控制，但关掉新执行器后必须拒绝受限科研写入，不能回落旧无限制shell。旧聊天功能可保留。

数据库升级前生成一致备份（考虑WAL），验证可读；新增表/列优先。回滚优先停写研究模块、保留证据、使用兼容读路径或回退到一致备份；禁止自动执行破坏性down migration。已发起的远端作业仍须独立核对/取消，回滚本地程序不会自动回滚远端副作用。

上游移植逐项带来源commit、文件映射和回归测试；保留Apache-2.0许可与NOTICE、修改说明。根MIT文件不能用于覆盖上游许可。

## 13. 可直接发送给Astra的启动指令

> 你是GPT-6 Astra开发主控，使用GPT-5.6 Terra执行有界任务，最多同时3个Terra。先完成A00：只读核对目标分支、真实HEAD、本地未提交与未跟踪改动、schema和测试入口，不得reset/clean/stash或覆盖工作区。将本任务包作为方案输入，先冻结接口、文件所有权和P0验收矩阵，再依赖分批执行。不要把设计文档当实现；保留已有SQLite工具步骤恢复和EventBus机制。先贯通合成数据上的“只读审计—版本绑定人工批准—受控远端JobSpec—真实回执—独立复核—发布批准”。所有受限数据出口和审批必须由代码强制，不能由提示词替代。每个任务交付实际命令/日志/失败/未执行项，最后由你在真实整合树验收。未经用户另行授权，不连接患者服务器、不运行患者数据实验、不发PR、不发布。

## 14. 关键证据链接

- [固定目标提交](https://github.com/OpenMedAILab/oph-autoresearch/commit/e4d3322f19b33c545819b4b5e15a50eaee4c5d33)
- [工作流持久化入口](https://github.com/OpenMedAILab/oph-autoresearch/blob/e4d3322f19b33c545819b4b5e15a50eaee4c5d33/packages/server/src/delegate.ts)
- [SQLite迁移](https://github.com/OpenMedAILab/oph-autoresearch/blob/e4d3322f19b33c545819b4b5e15a50eaee4c5d33/packages/store/src/schema.ts)
- [SSH工具与出口](https://github.com/OpenMedAILab/oph-autoresearch/blob/e4d3322f19b33c545819b4b5e15a50eaee4c5d33/packages/tools/src/ssh.ts)
- [研究UI](https://github.com/OpenMedAILab/oph-autoresearch/blob/e4d3322f19b33c545819b4b5e15a50eaee4c5d33/apps/web/src/components/ResearchWorkspace.tsx)
- [上游27个提交比较](https://github.com/qingxueyanshang/qywork-qingyan-harness/compare/a4892602...ce7f53b4afeb22b48650ab2e13395c671cc0b5a5)
- [Google原文，2026-08-27](https://antigravity.google/blog/teamwork-when-ai-becomes-a-research-partner)
- [Google当前Teamwork文档，2026-09-05读取](https://antigravity.google/docs/teamwork)
- [Agent Skills格式规范，2026-09-05读取](https://agentskills.io/specification)

本评审没有运行仓库测试/构建、连接SSH、验证原生CLI实际登录态、评测第三方技能或证明机构级合规。所有这类结论必须在实施验收时单独取得证据。
