---
name: ssh-experiment-runner
description: 在 SSH GPU 服务器上执行已批准的眼科影像 AI 实验；用于可复现训练、监控、评估和生成 run_receipt，不传输原始数据。
---

# SSH 实验执行

## 启动闸门

只有同时满足以下条件才可执行训练或远程写入：

- `research/study_protocol.md` 与 `research/experiment_spec.yaml` 已存在且无待定关键字段；
- 当前会话中用户已明确批准方案冻结检查点；
- 数据快照与 `research/dataset_manifest.json` 一致；
- 远程输出目录与预计资源消耗已经回显给用户。

否则只做检查并返回缺口，不得用“先跑一下”绕过。

## 可复现执行

- 在远程仓库记录代码 commit、dirty 状态、依赖锁文件哈希、容器/conda 环境、CUDA/驱动和 GPU 型号。
- 每次运行生成唯一 run id；冻结完整配置、随机种子、数据快照、拆分清单哈希和启动命令。
- 拆分必须以患者为最小隔离单位；双眼、纵向随访和近重复图像不得跨集合。
- 先跑小规模 smoke test，再跑基线；确认指标方向、样本数和损失无异常后才提交正式训练。
- 不覆盖既有输出目录。失败也记录退出码、最后阶段和可公开的错误摘要。
- 只拉取脱敏聚合指标、曲线、模型卡和无患者信息的图表；权重是否下载由用户单独决定。

## 监控与停止

监控作业状态、资源利用、NaN/发散、过拟合和数据加载异常。命中协议停止规则时停止后续阶段并汇报；不要擅自改学习率、样本过滤或主要指标后继续跑。

## 输出契约

写入或追加 `research/run_receipt.json`。每个 run 至少包含：`run_id`、`status`、`started_at`、`finished_at`、`ssh_alias`、`remote_run_dir_redacted`、`code_commit`、`code_dirty`、`environment`、`dataset_snapshot`、`split_hash`、`config_hash`、`seeds`、`command_redacted`、`resources`、`artifacts`、`metrics_summary`、`exit_code`、`limitations`。不得写密钥、真实患者路径或逐例数据。
