---
name: ssh-data-audit
description: 通过 SSH 对远程眼科影像数据执行隐私安全的只读审计；用于生成脱敏 dataset_manifest，而不下载原始影像或暴露患者级信息。
---

# SSH 远程数据只读审计

## 连接与输入校验

1. SSH 主机必须是用户提供且已存在于本机 SSH 配置中的别名，只接受字母、数字、点、下划线和连字符。
2. 远程路径必须是绝对 POSIX 路径；拒绝换行、`..`、通配符和 shell 元字符。命令中始终把路径作为单独的带引号参数。
3. 第一次只执行 `pwd`、`test -d`、`find`/Python 聚合脚本等只读操作。禁止 `scp`、`rsync`、挂载、删除、移动、改名和改权限。

## 最小披露

- 不在工具输出或本地产物中打印文件名、目录名、患者号、姓名、日期、accession number、DICOM tag 值或逐例预测。
- 如需患者级去重/划分，只在服务器端用研究专用盐做不可逆 token；盐和映射不回传。
- 小样本单元格默认抑制（建议 n < 10 写为 `<10`），避免稀有组合重识别。
- 允许回传：总数、分布、缺失率、尺寸/格式汇总、哈希后的数据快照标识、异常类别及数量。

## 必查项目

- 计数层级：患者、眼别、就诊/检查、序列、图像；说明每个数字的去重键。
- 模态与设备：眼底彩照/OCT/OCTA/裂隙灯、厂商/设备的聚合分布。
- 标签：定义、来源、时间窗、缺失和冲突；不要回传逐例标签。
- 质量：无法解码、尺寸异常、空文件、重复内容、左右眼/时间信息异常。
- 泄漏：同一患者、同一眼、同次检查、近重复图像是否跨 train/val/test；预训练或外部测试集是否重叠。
- 偏倚：中心、设备、时间、年龄段、性别等可用亚组的聚合覆盖；敏感字段仅在获授权时统计。

## 输出契约

写入 `research/dataset_manifest.json`，至少包含：`schema_version`、`generated_at`、`ssh_alias`、`remote_root_redacted`、`snapshot_id`、`counting_units`、`modalities`、`labels`、`missingness`、`quality`、`split_policy`、`leakage_checks`、`subgroups`、`limitations`。路径只保留用户已知的逻辑根或脱敏别名。

若任何统计需要写临时文件，先向用户说明并等待批准；默认在 stdout 内完成聚合且不落盘。
