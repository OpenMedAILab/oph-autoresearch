# 科研实施基线

## 执行进度看板

- 日期：2026-09-05。
- 状态：🔄 增量实施与独立复审中；本页记录基线，不代替最终验收回执。
- 基线分支：`feat/mvp-research-workbench`，HEAD `e4d3322f19b33c545819b4b5e15a50eaee4c5d33`。
- 当前批次：受限实例边界、任务与证据版本、Skill 来源锁、本地执行协议、上游超时和摘要记账。
- 外部前置：可信人类身份服务、专用非患者 SSH 执行环境尚未接入。它们不阻止本地合同、回归和编译验证，但不能以本地测试代替远端验收。

## 基线与唯一权威

实际工作目录为 `D:/PROJECT/Autosearch/oph-autoresearch-repo`。本轮沿用先前已整合的脏工作区直接增量修改，没有重新从远端覆盖代码。继续执行前保存的 81 项已存在文件哈希位于 `.tmp/pro-review-2026-09-05/continuation/preexisting-file-hashes.json`；最终比较须区分内容未变与必要增量整合，不能将所有变化都归为本轮新增。

科研持久化事实、投影、幂等记录和 outbox 继续由 `packages/store/src/research.ts` 与原 SQLite 存储裁决。核心合同实际位于 `packages/core/src/domain/research.ts`，不是任务包的建议目录。已有聊天、工具步骤、工作流及 EventBus 保持各自原有含义；科研批准不能从聊天审查或应用令牌推断。

已有迁移 35/36 是前两批实际注册的历史。本轮新增迁移由 Astra 单独分配，不能照搬上游迁移编号，也不能原地改写历史标记。测试与 smoke 使用隔离工作目录，不迁移或重启用户正在使用的实例。

实现决策见 `adr/0003-immutable-restricted-instance.md`、`adr/0004-task-evidence-and-local-protocol.md`。原始规格见 `pro-task-package-2026-09-05.md`；它包含完整目标，不能将任务包中的建议路径或验收要求读作已实现能力。

## 验证口径

独立审查由 GPT-6 Astra 执行；实现由 GPT-6 Astra 主控、GPT-5.6 Terra 承接有界任务。单元/故障注入、真实本地 HTTP、编译产物 HTTP、真实 SSH 和用户桌面验收分别报告。固定数字合成统计只证明该模板的执行与复算，不是医学影像训练、临床统计或科研效果验证。

本轮最终 gate、build、编译后 smoke、审查结果和原任务包逐项完成状态由本轮 receipts 记录。早期回执中的测试数字和限制保留为当时快照；后续回执描述新增能力，不回写历史测试数字。
