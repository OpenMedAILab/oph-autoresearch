# 完整计划执行看板

2026-09-05。GPT-6 Astra 主控、GPT-5.6 Terra 实现、GPT-6 Astra 独立审查。用户授权完成现有 Pro 计划的本地实现、验证、打包及当前功能分支推送。外部环境验收单独列出。

## 基线与交付范围

分支 `feat/mvp-research-workbench`，开始 HEAD `e4d3322f19b33c545819b4b5e15a50eaee4c5d33`，最高迁移 37。124 项原 dirty 文件基线位于 `.tmp/pro-review-2026-09-05/full-plan/preexisting-file-hashes.json`；保留既有工作，不 reset/clean/stash，提交排除个人记忆和临时产物。

## 实现与验收

| 范围 | 已实现与验证 | 外部或产品能力边界 |
|---|---|---|
| T01/T02/T06 持久合同与谱系 | 同一 Campaign/event/outbox 权威，CAS/idempotency，task revision/attempt/artifact/approval 精确绑定与失效闭包 | 真实机构账本迁移与运维验收待外部环境 |
| T03/T07 Evidence Session / CLI | verified receipt → locked EvidencePack → fresh Session；内置 CLI 子进程通过父级唯一预算 guard 出站；结构化结果核验；两种 compiled 后端通过 | 外部 Codex/Claude CLI 不属于该执行入口；cwd/minenv 不代表 OS 沙箱 |
| T04 可信审批 | startup Ed25519 allowlist，approve/revoke/LabelSet 签名与范围核验，proof 重放保护 | 真实临床 IdP、医生身份尚未接通 |
| T05/T12 daemon / SSH | 同一 Runner + 固定 OpenSSH transport + 常驻远端 authority；unknown 恢复仍绑定原 Attempt；lease watchdog、取消真实退出、固定设备 health/slot 报价与审批绑定 | 本机实际服务/worker、回环 transport、ssh -G 通过；无实机 SSH 主机验收；无 OS CPU/内存硬限额 |
| T07/T08 公开文献 | Crossref/PubMed 官方 metadata、定位符/响应 hash → 引用 → EvidencePack；compiled Crossref 联合模型 fixture 通过 | 元数据不是全文；未声称论文结论已人工复核 |
| T09 研究界面 | 九执行阶段映射六阶段，任务/尝试/产物/审批/LabelSet/文献/预算未知/设备/审查 backend/失效可见；web 回归及构建通过 | 本轮不声称安装后人工桌面验收 |
| T10 固定评估 | summary、score、train-only mean fit + 固定 logistic scorer、11 张 8×8 合成图像提取，均走真实 Runner/receipt，compiled 通过 | 非真实临床图像训练或临床性能验证 |
| T11 模型稳定性 | 三类 provider wire cap、唯一派发、未知用量留空且保留预算、完成后来源 stale；独审探针关闭 | smoke provider 为本地 SSE，无付费模型账单验收 |
| P1 Pattern / P2 经评测策略 | 固定九阶段、两个任务、各自批准；auto 在三个自包含合成模板按固定顺序选首个达标项；blocked 零任务、重新规划保留历史；public metadata false 在 HTTP 前阻断 | 非跨真实数据集自适应选模 |
| P1 精选 Skills | 三个 K-Dense 候选固定源码 hash、长度、静态评估与 reportHash；拒绝结果进入 Pattern | 全部 rejected-until-reviewed，不执行依赖闭包/行为未审核的第三方 Skill |
| P1 MLflow/DVC | worker 读取固定 startup 源，审批/Attempt/JobSpec 绑定 trackingPolicyHash，aggregate receipt → EvidencePack；source 和 compiled 图像+tracking 通过 | synthetic 配置；机构服务账号、患者数据仓库待外部验收 |
| P2 LabelSet | 签名不可变聚合引用、successor、旧版本和下游失效；真实 HTTP 测试签名更新通过 | 无真实医生身份或远端临床标签验收 |
| P2 机构治理 | 启动 manifest 固定 loopback host/boundary/公钥指纹/daemon/public metadata 权限；运行中拒绝拓宽 | 防火墙、ACL、服务账号和密钥保管需实机验收 |
| T12/A02 备份与交付 | fixture live-WAL 一致快照、原产物字节/ledger hash 比较，输出新路径；全量 gate、compiled smoke、实际 Tauri/NSIS 打包证据见最终回执 | 恢复保留原 immutable file URI，不代表迁移后的应用回执路径恢复；不操作真实用户库 |

## 完成依据

最终测试、独审、安装包 SHA256 和分支交付信息以 [完整执行回执](receipts/2026-09-05-full-plan.md) 为准。构建后的 CLI 已通过 summary、score、training+daemon、retinal+tracking、CLI review、公开文献+Session review 和常驻 authority 验证。常驻 authority 在本机回环环境接受 100 次同键提交及重启后第 101 次提交，仍只有一个作业。

本地实现完成与外部部署验收分别记录。缺少专用非患者 SSH 主机和可信身份配置，不连接患者环境、不伪造远端/临床验收。
