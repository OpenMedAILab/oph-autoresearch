# 开源架构参考与六阶段映射

本文件记录架构参考，不直接复制外部项目代码。采用前应再次核对许可证、版本和医疗数据合规要求。

| 阶段 | 预置角色 | 可借鉴项目 | 借鉴点 |
| --- | --- | --- | --- |
| 1 问题建模 | 研究问题与证据检索员 | PaperQA2、STORM、GPT Researcher、Biomni | 文献检索、引用追踪、问题分解、证据综合 |
| 2 数据审计 | 数据审计员 | MONAI、pydicom、NiBabel、Deepchecks、DVC | 医学影像 I/O、质量检查、数据版本与泄漏审计 |
| 3 方案冻结 | 方案与统计设计员 | Agent Laboratory、MONAI Bundles | 方案模板、实验配置、人工检查点与可复现契约 |
| 4 远程实验 | 实验工程师 | MONAI、nnU-Net、MLflow、DVC、RD-Agent、AIDE | 强基线、实验追踪、远程训练与迭代编排 |
| 5 独立复核 | 独立复核员 | Deepchecks、Fairlearn、MLflow、MedPerf | 鲁棒性、公平性、复算、外部评估与审计 |
| 6 研究输出 | 证据写作与报告员 | PaperQA2、STORM、Quarto、Pandoc | 引用约束写作、报告生成与可复现归档 |

## OpenJiuwen 架构借鉴

- `agent-core`：ReAct Agent 与 Workflow Agent 分离、异步图执行、流式事件、状态中断与恢复。
- `agent-runtime`：服务、管理、部署策略、基础设施分层，可逐步扩展到本机进程、Docker 与集群。
- `agent-protocol`：以 MCP、A2A、A2X 作为工具和 Agent 间协议边界。
- `deepsearch`：查询规划、信息搜集、理解、反思、报告生成的多 Agent 研究循环。
- `jiuwenswarm`：Channel Adapter、Channel Manager、入站/出站 Pipeline 与 Session Router，适合作为飞书、企业微信和 QQ 遥控通道的边界。

## 本项目采用的编排边界

`Channel Adapter → Message Bus → Session Router → Agent / Approval / Audit`。机器人只负责传输和身份映射，不绕过现有会话、权限、审批、停止运行与审计账本。凭证仅保存环境变量名；所有通道必须配置操作者白名单。
