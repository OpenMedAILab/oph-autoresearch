# oph-autoresearch

面向眼科影像 / AI 模型研究的本地优先自动科研工作台。它以 qywork Agent Harness 为底座，在本机组织研究、调度多模型 Agent、保存审计记录，并通过 SSH 在远程服务器上盘点数据与执行 GPU 实验。

> 当前处于 MVP 开发阶段，仅用于科研辅助，不是医疗器械，不提供临床诊断或治疗建议。

## MVP 能做什么

- 从“研究问题 → 数据审计 → 方案冻结 → 实验 → 独立复核”组织研究流程。
- 原始影像、DICOM 头和患者标识留在 SSH 服务器，本机只保存脱敏汇总与研究产物。
- 自动初始化四个眼科科研 Skill：流程编排、SSH 数据审计、SSH 实验执行、结果独立复核。
- 默认提供研究协调员、数据审计员、实验执行员、独立复核员四种角色。
- 模型与角色解耦：角色默认继承当前会话模型，也可在 `.qy/team.json` 中分别配置 provider / model / effort。
- 探测并调用 Claude Code、Codex CLI、Gemini、Qwen、Grok、Kimi 等本机原生 CLI。
- 使用 workflow DAG、checkpoint、revise / resume 和 SQLite 账本保留可追溯过程。

后续计划接入医生标注与结果审阅网站，形成主动学习和标注复核闭环。

## 安全边界

```text
本机：研究问题、方案、Agent 调度、脱敏汇总、运行回执、审计账本
  │ SSH（只读审计；批准后才允许实验写入）
  ▼
服务器：原始眼科影像、患者级索引、训练代码、GPU 作业、模型产物
```

- 数据审计默认只读，禁止下载原始影像或输出患者级信息。
- 方案冻结后必须经过人工检查点，才可启动训练。
- 实验执行者与结果审查者应使用不同模型，或至少使用互不共享上下文的独立会话。
- 产物中的每项结论必须能追溯到数据快照、配置、代码版本和运行回执。

## 本地开发

需要 [Bun 1.3.14+](https://bun.sh)、Node.js 22+；桌面模式还需要 Rust / Cargo 和系统 WebView2。

```powershell
git clone https://github.com/OpenMedAILab/oph-autoresearch.git
cd oph-autoresearch
bun install
bun run packages/cli/src/index.ts init
./scripts/start.ps1 -Mode web
```

桌面开发使用：

```powershell
./scripts/start.ps1
```

首次打开研究项目时，应用只补齐缺失的 `.agents/skills/*`、`.qy/team.json` 和 `research/README.md`，不会覆盖已有内容。

SSH 连接使用本机 `~/.ssh/config` 中已经配置好的主机别名。不要把密码、私钥或患者路径写进仓库。

## 测试

```powershell
bun run gate
bun run build
```

`gate` 包含 TypeScript / Solid 类型检查、Biome、单元与集成测试、Rust `cargo check`。开发分支只有在这些检查通过，并完成本地界面冒烟测试后才推送。

## 关键研究产物

| 阶段 | 产物 |
| --- | --- |
| 研究问题 | `research/research_question.yaml` |
| 远程数据审计 | `research/dataset_manifest.json` |
| 方案冻结 | `research/study_protocol.md`、`research/experiment_spec.yaml` |
| 训练与评估 | `research/run_receipt.json` |
| 独立复核 | `research/claim_evidence_map.yaml` |

## 技术栈

- Bun + TypeScript Agent Loop
- SolidJS Web UI
- Tauri 2 桌面壳
- SQLite 本地运行账本
- Skills、MCP、Plugins、多 Agent 与外部 CLI

内部 `@qywork/*` 包名和 `QYWORK_*` 兼容变量暂时保留，以控制首版迁移风险；它们不代表产品仍是通用编程 Agent。

## 许可证与来源

OpenMedAILab 新增代码按根目录 [MIT License](LICENSE) 授权。项目包含来自 [qywork-qingyan-harness](https://github.com/qingxueyanshang/qywork-qingyan-harness) 的 Apache-2.0 代码，该部分继续遵循 [Apache-2.0](LICENSES/Apache-2.0.txt)、[NOTICE](NOTICE) 和 [第三方许可证清单](THIRD_PARTY_NOTICES.md)。
