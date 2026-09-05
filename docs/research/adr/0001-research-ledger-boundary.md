# Research Ledger 第一批边界

## 执行进度看板

- 最后更新：2026-09-05，基线 `e4d3322f19b33c545819b4b5e15a50eaee4c5d33`。
- 当前批次：科研提案、版本、事件与查询；自测通过，待用户验收，不代表完整 P0。
- 阻塞项：独立可信人类身份渠道和专用合成数据 SSH 环境未配置。

| 工作 | 状态 |
|---|---|
| 调度取消与父会话归属 | 已完成待验收 |
| Campaign、不可变产物版本、事件与原子投影 | 已完成待验收 |
| HTTP 提案/查询及最小界面 | 已完成待验收 |
| 验证与任务回执 | 全 gate 通过；详见第一批回执 |

## 裁决

保留 Bun、Solid、Tauri、SQLite、EventBus 和 workflow 工具步骤恢复。通用 workflow 的执行事实仍由既有步骤账本裁决；ResearchEvent 只裁决本批新增的科研提案、产物版本与人工审批事实。聊天和旧 workflow 不自动转换成已核验科研证据，兼容展示标记 `legacy_unverified`。新增科研持久化边界及保留旧视图由本次用户明确授权。

现有依据：`packages/core/src/domain/workflow.ts` 的 `WorkflowProjection.approvals` 是字符串，`foldWorkflow` 从父会话步骤重建；`packages/server/src/delegate.ts` 从 `listRuns/listSteps` 装配记录。它们没有独立 Campaign 身份或绑定科研输入版本的人工批准事实，因此不能用聊天审查文本冒充科研审批。本批不对两种账本双写同一状态，不自动迁移旧记录，不增加远程执行入口。

ResearchEvent 是新科研状态唯一真源；SQLite 投影和 outbox 是同一事务内的派生记录。命令有幂等键和 expectedVersion；同键异内容拒绝。产物版本不可覆盖。批准绑定当前策略、输入、预算与产物版本组成的 bundleHash，变更后失效，撤销保留历史。

事件携带完整版本快照。第二批已增加固定合成 TaskRevision/Attempt、真实产物字节核验、outbox 投递和 UI 刷新；手动登记产物仍不能冒充核验结果。第一批历史范围见 [第一批回执](../receipts/2026-09-05-research-foundation.md)，当前整合范围见 [本地合成纵切片回执](../receipts/2026-09-05-local-synthetic.md)。

## 身份边界

现有应用 bearer token 可以被 Agent 使用，只证明应用访问权，不能证明人类身份。请求正文的 actor、Origin、浏览器 UA、本地地址也不构成人类证明。因此本批 HTTP 批准与撤销端点封闭，返回 `human_identity_unavailable`；界面说明审批渠道未配置，不呈现可批准按钮。内部账本审批语义用于可信调用方接线和测试，尚未向网络开放。后续必须提供 Agent 不可取得的独立身份凭据和明确授权流程。

本批提案与登记产物不会授权 SSH 写入、运行实验或发布结论。未连接任何保存的患者服务器；既有普通文件预览能力不在本批范围。

## 五问与复审

1. 现有执行权威：workflow 步骤、编排器和 Session。新增科研事实权威：ResearchEvent。
2. 取消错误最早发生在调度循环；子会话归属错误最早发生在续接装配。两处原地修复，不由 UI 遮盖。
3. 科研批准所需不可变版本与独立身份不在现有字符串审批契约内，新增明确领域边界，不改名伪装现有审查。
4. 删除的是取消后继续派发行为及不检查父归属的续接行为；旧科研视图按用户要求保留并显式标记未核验。
5. 新增科研持久化路径，已获本次用户授权；不新增实际 Agent/SSH 执行入口。

复审推翻了“本地 UI nonce 自动等于人类身份”的方案：同一 Agent 可读取的渠道无法证明人类。也不将本批称为完整 P0：受控 SSH 纵切片、真实人类审批、TaskRevision/Attempt 执行绑定、科研输出契约核验、技能供应链与动态路由仍需后续实施。
