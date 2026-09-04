---
name: oph-research-pipeline
description: 眼科影像 AI 研究的端到端编排技能；用于从研究问题、SSH 数据审计和方案冻结推进到实验、独立复核与论文证据映射。
---

# 眼科影像自动科研流程

## 不可突破的边界

- 这是科研辅助流程，不输出临床诊断或治疗建议。
- 原始影像、DICOM 头、患者标识和逐例结果留在获授权的 SSH 服务器。
- 本地只保存脱敏聚合、研究方案、代码、配置、日志摘要和可公开图表。
- 默认只读。远端训练、写文件、提交作业或改变数据必须在方案冻结检查点获得用户明确批准。
- 角色职责与模型配置分离。优先让执行者与审查者使用不同模型或至少独立上下文；可用时选择 `cli:claude`、`cli:codex` 等外部原生 CLI。
- 开始编排前读取 `.oph/patterns.json`。固定的是六阶段治理骨架，阶段内部的角色数量、模型和依赖图由 Pattern 动态决定。

## 阶段与产物契约

1. **研究问题** → `research/research_question.yaml`
   - 必含：研究目标、主要假设、目标人群、输入模态、预测目标、主要/次要终点、预期用途、排除项。
2. **远程数据审计** → `research/dataset_manifest.json`
   - 调用 `ssh-data-audit`；只接受脱敏聚合。
   - 必含：数据快照标识、病例/眼/检查/图像数、模态与标签分布、缺失、重复、划分单位、泄漏风险、质量问题。
3. **方案冻结** → `research/study_protocol.md` + `research/experiment_spec.yaml`
   - 预先确定纳排标准、患者级拆分、主要指标、置信区间、亚组、基线、消融、停止规则和失败判据。
   - 到此创建 workflow checkpoint，汇报尚未决定的问题；未经批准不得训练。
4. **基线与正式实验** → `research/run_receipt.json`
   - 调用 `ssh-experiment-runner`；每次运行有唯一 run id，配置不可静默改变。
5. **独立复核** → `research/claim_evidence_map.yaml`
   - 调用 `oph-results-review`；主张必须逐条指向可核验的指标、图表或统计输出。
6. **研究输出** → 研究报告、模型卡与可复现归档
   - 调用 `oph-research-reporting`；只写入已通过独立复核的主张，最终发布前停在研究者审阅检查点。

## Pattern 选择与执行

- **候选—反证—综合**：问题建模和方案冻结。至少两个独立候选，一个 clinical-challenger 或 methodology-critic，再由协调员综合；反对意见不得从综合稿中删除。
- **分布式审计**：数据审计。按中心、模态、标签、缺失和泄漏风险拆成互不重叠的只读轨道，再由 data-auditor 汇总。
- **实验 DAG**：远程实验。每个 Worker 负责独立配置/脚本或运行目录，禁止并发编辑同一文件；并发值按 GPU 和项目硬上限设置。
- **自验证**：独立复核。independent-reviewer 与 reproducibility-auditor 使用新上下文复算，methodology-critic 主动制造反例。
- **文档审查**：研究输出。写作、引用、统计和复现声明分开核验，最终再综合。

每张 workflow 图都必须以 checkpoint 验收其 agent 节点。节点可显式填写 provider + model；生成者与审查者优先使用不同模型家族。工具结果、失败路线和反例分别写入 `research/artifact_ledger.yaml` 与 `research/pitfall_registry.yaml`，不得只留在聊天记录里。

## 推荐编排

按阶段分别建立 workflow，而不是一张固定角色长链：候选/探索并行 → Critic/Challenger 对抗检查 → Synthesizer 综合 → 工具验证 → checkpoint。主会话批准后再进入下一阶段；revise 必须携带累计反例回到原子会话。没有依赖的检查可并行，但审查节点不得与被审对象共享隐式上下文。

## 失败即停止

出现以下任一情况，不得继续训练或撰写结论：患者级划分无法确认、标签定义不清、数据版本不可追溯、关键亚组数量未知、远程路径或 SSH 主机未经确认、产物缺字段、回执与实际文件不一致。
