# 研究产物

此目录保存脱敏、可审计的研究产物。原始影像、DICOM 头、患者标识和逐例预测不得放入本目录或提交到 Git。

标准产物：

- `research_question.yaml`：研究问题与终点
- `dataset_manifest.json`：SSH 端只读审计后的脱敏数据清单
- `study_protocol.md`：冻结研究方案
- `experiment_spec.yaml`：可执行实验规格
- `run_receipt.json`：运行与环境回执
- `claim_evidence_map.yaml`：独立复核后的主张—证据映射
- `artifact_ledger.yaml`：结论、数据快照、代码、运行与验证证据总账
- `pitfall_registry.yaml`：失败路线、反例、偏倚与后续回避规则

方案冻结和结果复核后都必须停在人工检查点。
