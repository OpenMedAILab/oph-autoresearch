---
name: ssh-experiment-runner
description: 在 SSH GPU 服务器上完成环境准备、数据预处理、smoke、已批准的训练与评估，分离执行并监控长任务，生成 run_receipt；不传输原始数据。
---

# SSH 实验执行

## 启动闸门

只有同时满足以下条件才可执行训练或远程写入：

- `research/study_protocol.md` 与 `research/experiment_spec.yaml` 已存在且无待定关键字段；
- 正式训练前有人类批准的检查点记录；smoke 与预处理只在已授权的实验读写目录内进行。
- 数据快照与 `research/dataset_manifest.json` 一致；
- 远程输出目录与预计资源消耗已经回显。

否则只做检查并返回缺口，不得用「先跑一下」绕过。

## 环境与预处理

- 先只读核对：代码目录、依赖锁文件、容器/conda 环境、CUDA/驱动、GPU 型号与空闲情况、数据目录结构。
- 预处理脚本与拆分清单写在实验目录内，不改动原始数据目录；拆分以患者为最小隔离单位，输出拆分清单哈希。
- 预处理产物只保留脱敏中间结果；逐例文件名、患者标识不进入回执。

## 可复现执行

- 记录代码 commit、dirty 状态、依赖锁文件哈希、环境、CUDA/驱动和 GPU 型号。
- 每次运行生成唯一 run id；冻结完整配置、随机种子、数据快照、拆分清单哈希和启动命令。
- 先跑小规模 smoke（同步，`ssh_run_command`），确认指标方向、样本数和损失无异常；正式训练必须等人类批准。
- 不覆盖既有输出目录。失败也记录退出码、最后阶段和可公开的错误摘要。
- 只拉取脱敏聚合指标、曲线、模型卡和无患者信息的图表；权重是否下载由用户单独决定。

## 分离执行与监控

- 预计超过十分钟的任务用 `ssh_run_command` 的 `detach: true` 启动，回执里的 `runDir` 与 `pid` 立即写入 run_receipt。
- 终态只凭 `ssh_job_status`：`completed` / `failed` / `unknown`。`unknown` 不是失败也不是成功，先查 runDir 内的日志与退出码，不重复提交。
- 监控由主控用 create_schedule 定时调用 `ssh_job_status`；命中停止规则（NaN、发散、数据加载异常、资源超限）时停止后续阶段并汇报，不擅自改学习率、样本过滤或主要指标后继续跑。

## 输出契约

写入或追加 `research/run_receipt.json`。每个 run 至少包含：`run_id`、`status`、`started_at`、`finished_at`、`ssh_alias`、`remote_run_dir_redacted`、`run_dir`、`pid`、`code_commit`、`code_dirty`、`environment`、`dataset_snapshot`、`split_hash`、`config_hash`、`seeds`、`command_redacted`、`resources`、`artifacts`、`metrics_summary`、`exit_code`、`limitations`。不得写密钥、真实患者路径或逐例数据。实验脚本收尾时将含 metrics_summary 的单个完整 JSON 打印在日志末尾；终态由主控用 context.experimentSources 登记，run_dir / pid / exit_code 与真实 SSH 步骤保持一致。
