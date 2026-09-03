/**
 * oph-autoresearch 工作区模板。
 *
 * 模板在服务端内嵌，而不是运行时从源码目录读取：发布后的 `oph` 是单文件 sidecar，
 * 源码旁的 assets 不一定存在。初始化补缺失文件；团队模板升级只补字段和角色，不覆盖已有自定义值。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ResearchTemplateResult {
  created: string[]
  existing: string[]
  updated: string[]
}

const DEFAULT_TEAM = {
  templateVersion: 2,
  name: 'oph-autoresearch 眼科科研团队',
  rules: {
    maxConcurrent: 3,
    shared:
      '原始眼科影像与直接标识符不得离开获授权的 SSH 服务器。默认只读；训练、写入远程目录或改变数据前必须经过明确检查点。所有结论必须能追溯到研究产物与运行回执。',
  },
  roles: [
    {
      id: 'coordinator',
      name: '研究协调员',
      description: '贯穿六阶段，拆解任务、编排角色、维护产物契约和人工检查点',
      systemPrompt:
        '你负责协调，不代替数据审计员或独立审查员下结论。先读取 oph-research-pipeline 技能；每个阶段只接受满足契约的产物。方案冻结后必须等待用户批准。',
      modules: ['阶段编排', '产物契约', '人工检查点', '子 Agent 调度'],
      skills: ['oph-research-pipeline'],
      allowedTools: [
        'read_skill',
        'read_file',
        'write_file',
        'edit_file',
        'list_dir',
        'glob',
        'grep',
        'write_todos',
        'subagent',
        'workflow',
      ],
      maxSteps: 24,
    },
    {
      id: 'research-questioner',
      name: '研究问题与证据检索员',
      description: '将临床科研意图转成可检验问题，并建立可追溯的文献证据底稿',
      systemPrompt:
        '先读取 oph-question-design 技能。围绕 PICO/PECO、预期用途、主要终点和可证伪假设工作；文献结论必须保留来源与适用边界，不把搜索摘要当作证据。',
      modules: ['PICO/PECO', '文献检索', '证据分级', '研究问题冻结'],
      skills: ['oph-question-design'],
      allowedTools: [
        'read_skill',
        'read_file',
        'write_file',
        'edit_file',
        'list_dir',
        'glob',
        'grep',
        'web_search',
        'web_fetch',
      ],
      maxSteps: 28,
    },
    {
      id: 'data-auditor',
      name: '数据审计员',
      description: '通过 SSH 对眼科影像数据做只读盘点、完整性与泄漏风险检查',
      systemPrompt:
        '先读取 ssh-data-audit 技能。只在远端聚合统计，不打印或下载文件名、患者标识、DICOM 头或原始影像；不得修改远程数据。将脱敏汇总写入 dataset_manifest.json。',
      modules: ['SSH 只读盘点', '影像格式检查', '数据质量', '泄漏与偏倚审计'],
      skills: ['ssh-data-audit'],
      allowedTools: [
        'read_skill',
        'read_file',
        'write_file',
        'edit_file',
        'list_dir',
        'glob',
        'grep',
        'run_command',
      ],
      maxSteps: 24,
    },
    {
      id: 'protocol-statistician',
      name: '方案与统计设计员',
      description: '冻结纳排标准、患者级划分、终点、统计方法、基线和消融计划',
      systemPrompt:
        '先读取 oph-study-protocol 技能。所有主要分析、阈值、亚组、缺失处理和失败判据都必须在实验前冻结；发现样本量或标签定义不足时停止并提出最小决策清单。',
      modules: ['研究方案', '样本量与效能', '统计分析计划', '实验规格'],
      skills: ['oph-study-protocol'],
      allowedTools: [
        'read_skill',
        'read_file',
        'write_file',
        'edit_file',
        'list_dir',
        'glob',
        'grep',
        'run_command',
      ],
      maxSteps: 28,
    },
    {
      id: 'experiment-engineer',
      name: '实验工程师',
      description: '在 SSH GPU 服务器执行已批准的基线、训练和评估并保留回执',
      systemPrompt:
        '先读取 ssh-experiment-runner 技能。没有明确的方案批准记录不得启动训练。原始数据留在远端；固定配置、种子和代码版本，记录完整运行回执。',
      modules: ['环境复现', '基线与训练', '实验追踪', '远程作业监控'],
      skills: ['ssh-experiment-runner'],
      allowedTools: [
        'read_skill',
        'read_file',
        'write_file',
        'edit_file',
        'list_dir',
        'glob',
        'grep',
        'run_command',
      ],
      maxSteps: 32,
    },
    {
      id: 'independent-reviewer',
      name: '独立复核员',
      description: '使用独立上下文复核数据划分、统计结果与论文主张',
      systemPrompt:
        '先读取 oph-results-review 技能。不要沿用执行者的未验证解释；从运行回执和机器可核验产物独立复算。发现证据不足时明确驳回，不补造数字。',
      modules: ['独立复算', '泄漏复核', '稳健性与公平性', '主张—证据审查'],
      skills: ['oph-results-review'],
      allowedTools: [
        'read_skill',
        'read_file',
        'write_file',
        'edit_file',
        'list_dir',
        'glob',
        'grep',
        'run_command',
      ],
      maxSteps: 24,
    },
    {
      id: 'evidence-writer',
      name: '证据写作与报告员',
      description: '只依据已通过复核的证据生成科研报告、模型卡和论文初稿',
      systemPrompt:
        '先读取 oph-research-reporting 技能。逐条读取 claim_evidence_map，只写已接受或明确标注限制的主张；不新增数字、不弱化局限，不把研究验证写成临床可用。',
      modules: ['证据映射', '模型卡', '图表说明', '科研报告与论文'],
      skills: ['oph-research-reporting'],
      allowedTools: [
        'read_skill',
        'read_file',
        'write_file',
        'edit_file',
        'list_dir',
        'glob',
        'grep',
      ],
      maxSteps: 24,
    },
  ],
} as const

const TEAM_CONFIG = `${JSON.stringify(DEFAULT_TEAM, null, 2)}\n`

const PIPELINE_SKILL = `---
name: oph-research-pipeline
description: 眼科影像 AI 研究的端到端编排技能；用于从研究问题、SSH 数据审计和方案冻结推进到实验、独立复核与论文证据映射。
---

# 眼科影像自动科研流程

## 不可突破的边界

- 这是科研辅助流程，不输出临床诊断或治疗建议。
- 原始影像、DICOM 头、患者标识和逐例结果留在获授权的 SSH 服务器。
- 本地只保存脱敏聚合、研究方案、代码、配置、日志摘要和可公开图表。
- 默认只读。远端训练、写文件、提交作业或改变数据必须在方案冻结检查点获得用户明确批准。
- 角色职责与模型配置分离。优先让执行者与审查者使用不同模型或至少独立上下文；可用时选择 \`cli:claude\`、\`cli:codex\` 等外部原生 CLI。

## 阶段与产物契约

1. **研究问题** → \`research/research_question.yaml\`
   - 必含：研究目标、主要假设、目标人群、输入模态、预测目标、主要/次要终点、预期用途、排除项。
2. **远程数据审计** → \`research/dataset_manifest.json\`
   - 调用 \`ssh-data-audit\`；只接受脱敏聚合。
   - 必含：数据快照标识、病例/眼/检查/图像数、模态与标签分布、缺失、重复、划分单位、泄漏风险、质量问题。
3. **方案冻结** → \`research/study_protocol.md\` + \`research/experiment_spec.yaml\`
   - 预先确定纳排标准、患者级拆分、主要指标、置信区间、亚组、基线、消融、停止规则和失败判据。
   - 到此创建 workflow checkpoint，汇报尚未决定的问题；未经批准不得训练。
4. **基线与正式实验** → \`research/run_receipt.json\`
   - 调用 \`ssh-experiment-runner\`；每次运行有唯一 run id，配置不可静默改变。
5. **独立复核** → \`research/claim_evidence_map.yaml\`
   - 调用 \`oph-results-review\`；主张必须逐条指向可核验的指标、图表或统计输出。
6. **研究输出** → 研究报告、模型卡与可复现归档
   - 调用 \`oph-research-reporting\`；只写入已通过独立复核的主张，最终发布前停在研究者审阅检查点。

## 推荐编排

使用 workflow 明确依赖：研究问题与证据检索员 → 数据审计员 → 方案与统计设计员 → checkpoint → 实验工程师 → 独立复核员 → 证据写作与报告员 → checkpoint。研究协调员负责跨阶段契约与返工路由；没有依赖的检查可并行，但审查节点不得与被审对象共享隐式上下文。

## 失败即停止

出现以下任一情况，不得继续训练或撰写结论：患者级划分无法确认、标签定义不清、数据版本不可追溯、关键亚组数量未知、远程路径或 SSH 主机未经确认、产物缺字段、回执与实际文件不一致。
`

const DATA_AUDIT_SKILL = `---
name: ssh-data-audit
description: 通过 SSH 对远程眼科影像数据执行隐私安全的只读审计；用于生成脱敏 dataset_manifest，而不下载原始影像或暴露患者级信息。
---

# SSH 远程数据只读审计

## 连接与输入校验

1. SSH 主机必须是用户提供且已存在于本机 SSH 配置中的别名，只接受字母、数字、点、下划线和连字符。
2. 远程路径必须是绝对 POSIX 路径；拒绝换行、\`..\`、通配符和 shell 元字符。命令中始终把路径作为单独的带引号参数。
3. 第一次只执行 \`pwd\`、\`test -d\`、\`find\`/Python 聚合脚本等只读操作。禁止 \`scp\`、\`rsync\`、挂载、删除、移动、改名和改权限。

## 最小披露

- 不在工具输出或本地产物中打印文件名、目录名、患者号、姓名、日期、accession number、DICOM tag 值或逐例预测。
- 如需患者级去重/划分，只在服务器端用研究专用盐做不可逆 token；盐和映射不回传。
- 小样本单元格默认抑制（建议 n < 10 写为 \`<10\`），避免稀有组合重识别。
- 允许回传：总数、分布、缺失率、尺寸/格式汇总、哈希后的数据快照标识、异常类别及数量。

## 必查项目

- 计数层级：患者、眼别、就诊/检查、序列、图像；说明每个数字的去重键。
- 模态与设备：眼底彩照/OCT/OCTA/裂隙灯、厂商/设备的聚合分布。
- 标签：定义、来源、时间窗、缺失和冲突；不要回传逐例标签。
- 质量：无法解码、尺寸异常、空文件、重复内容、左右眼/时间信息异常。
- 泄漏：同一患者、同一眼、同次检查、近重复图像是否跨 train/val/test；预训练或外部测试集是否重叠。
- 偏倚：中心、设备、时间、年龄段、性别等可用亚组的聚合覆盖；敏感字段仅在获授权时统计。

## 输出契约

写入 \`research/dataset_manifest.json\`，至少包含：\`schema_version\`、\`generated_at\`、\`ssh_alias\`、\`remote_root_redacted\`、\`snapshot_id\`、\`counting_units\`、\`modalities\`、\`labels\`、\`missingness\`、\`quality\`、\`split_policy\`、\`leakage_checks\`、\`subgroups\`、\`limitations\`。路径只保留用户已知的逻辑根或脱敏别名。

若任何统计需要写临时文件，先向用户说明并等待批准；默认在 stdout 内完成聚合且不落盘。
`

const EXPERIMENT_SKILL = `---
name: ssh-experiment-runner
description: 在 SSH GPU 服务器上执行已批准的眼科影像 AI 实验；用于可复现训练、监控、评估和生成 run_receipt，不传输原始数据。
---

# SSH 实验执行

## 启动闸门

只有同时满足以下条件才可执行训练或远程写入：

- \`research/study_protocol.md\` 与 \`research/experiment_spec.yaml\` 已存在且无待定关键字段；
- 当前会话中用户已明确批准方案冻结检查点；
- 数据快照与 \`research/dataset_manifest.json\` 一致；
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

写入或追加 \`research/run_receipt.json\`。每个 run 至少包含：\`run_id\`、\`status\`、\`started_at\`、\`finished_at\`、\`ssh_alias\`、\`remote_run_dir_redacted\`、\`code_commit\`、\`code_dirty\`、\`environment\`、\`dataset_snapshot\`、\`split_hash\`、\`config_hash\`、\`seeds\`、\`command_redacted\`、\`resources\`、\`artifacts\`、\`metrics_summary\`、\`exit_code\`、\`limitations\`。不得写密钥、真实患者路径或逐例数据。
`

const REVIEW_SKILL = `---
name: oph-results-review
description: 独立复核眼科影像 AI 实验的统计结果、数据泄漏、可复现性和论文主张；用于生成 claim_evidence_map 并给出接受、返工或驳回决定。
---

# 眼科 AI 结果独立复核

## 独立性

- 从冻结方案、数据清单、配置和运行回执开始复核，不把执行者的文字总结当作证据。
- 优先使用不同模型或外部 CLI；做不到时使用新的独立上下文，并明确记录限制。
- 只读访问远程结果。若复算需要写入或运行新分析，先进入新的批准检查点。

## 核验顺序

1. **身份与完整性**：run id、代码 commit、数据快照、拆分哈希、配置哈希和产物哈希一致。
2. **样本流**：训练/验证/测试的患者数与眼数能对上；排除原因闭合；无患者、双眼、纵向或近重复泄漏。
3. **指标复算**：确认正类、单位和平均方式；主要指标带 95% CI。分类至少核验 AUROC/AUPRC、敏感度、特异度、校准；分割至少核验 Dice/IoU 与病例级分布。
4. **比较有效性**：比较基线、预设消融与统计检验；多重比较、阈值选择和外部测试按冻结方案执行。
5. **临床与公平性**：按中心、设备和预设亚组报告不确定性；不把内部验证写成临床有效性。
6. **可复现性**：从回执能定位代码、环境、配置和不可变产物；随机种子重复结果在合理范围。

## 主张—证据映射

写入 \`research/claim_evidence_map.yaml\`。每条记录包含：\`claim_id\`、\`claim\`、\`evidence_artifacts\`、\`population\`、\`metric\`、\`estimate\`、\`confidence_interval\`、\`verification\`、\`limitations\`、\`decision\`。\`decision\` 只能是 \`accept\`、\`revise\` 或 \`reject\`。

任何数字找不到机器可核验来源时标记 reject；不得从日志片段猜测、补齐或四舍五入出新的结果。复核结束给出总体决定和最小返工清单，并停在人工检查点。
`

const QUESTION_DESIGN_SKILL = `---
name: oph-question-design
description: 将眼科临床科研意图转成可检验、可证伪并可检索证据的研究问题；用于问题建模、PICO/PECO、文献底稿和研究问题冻结。
---

# 眼科研究问题与证据检索

## 工作顺序

1. 明确预期用途、目标人群、就诊场景、输入模态、比较对象与决策点。
2. 用 PICO/PECO 写出主要问题，区分诊断、预后、筛查、分割、质量控制或生成任务。
3. 预先定义主要假设、主要终点、失败条件和不可回答的问题，避免看过结果后改题。
4. 分层检索系统综述、指南、外部验证研究和代表性方法；每条结论记录 DOI/PMID/URL、年份、队列与适用边界。
5. 输出 \`research/research_question.yaml\` 和文献证据表。搜索摘要只能用于导航，不能替代原文证据。

## 最小字段

\`intended_use\`、\`population\`、\`setting\`、\`index_test\`、\`comparator\`、\`outcomes\`、\`primary_hypothesis\`、\`exclusions\`、\`evidence_gaps\`、\`decision_log\`。
`

const STUDY_PROTOCOL_SKILL = `---
name: oph-study-protocol
description: 为眼科影像与 AI 研究冻结方案和统计分析计划；用于患者级拆分、样本量、终点、亚组、基线、消融、停止规则和实验规格。
---

# 眼科 AI 研究方案与统计设计

## 冻结项

- 纳入/排除标准、索引日期、标签来源和裁决流程。
- 患者级最小隔离单位；双眼、纵向检查、近重复图像和中心泄漏规则。
- 主要/次要指标、阈值选择、95% 置信区间、缺失值和多重比较处理。
- 预设亚组、外部测试、基线、消融、校准、公平性和失败判据。
- 样本量或精度目标、随机种子、资源预算、停止规则和偏离方案的记录方式。

## 输出与闸门

生成 \`research/study_protocol.md\` 与 \`research/experiment_spec.yaml\`。关键字段存在待定值、数据快照不明确或统计效能不足时，不得进入训练；列出需要研究者决定的最小问题，并创建人工检查点。
`

const REPORTING_SKILL = `---
name: oph-research-reporting
description: 将已通过独立复核的眼科 AI 证据整理为模型卡、图表说明、科研报告和论文初稿；用于主张—证据映射和可复现归档。
---

# 证据约束的科研写作

## 写作边界

- 只使用 \`claim_evidence_map.yaml\` 中已接受或明确要求修订的主张；不得从日志、聊天或图形外观补造数字。
- 每个结果句指向可核验产物，保留人群、单位、估计值、置信区间和限制。
- 清楚区分内部验证、外部验证、回顾性研究与前瞻性临床效用；科研软件输出不得写成诊断或治疗建议。
- 同时报告负结果、失败实验、方案偏离、缺失数据和适用范围。

## 产物

生成可追溯的摘要、方法、结果、局限、模型卡、数据说明和复现清单；图表只引用脱敏聚合数据。最终发布前停在研究者审阅检查点。
`

const OPEN_SOURCE_STACK = `# 开源架构参考与六阶段映射

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

- \`agent-core\`：ReAct Agent 与 Workflow Agent 分离、异步图执行、流式事件、状态中断与恢复。
- \`agent-runtime\`：服务、管理、部署策略、基础设施分层，可逐步扩展到本机进程、Docker 与集群。
- \`agent-protocol\`：以 MCP、A2A、A2X 作为工具和 Agent 间协议边界。
- \`deepsearch\`：查询规划、信息搜集、理解、反思、报告生成的多 Agent 研究循环。
- \`jiuwenswarm\`：Channel Adapter、Channel Manager、入站/出站 Pipeline 与 Session Router，适合作为钉钉、飞书、企业微信和 QQ 遥控通道的边界。

## 本项目采用的编排边界

\`Channel Adapter → Message Bus → Session Router → Agent / Approval / Audit\`。机器人只负责传输和身份映射，不绕过现有会话、权限、审批、停止运行与审计账本。凭证仅保存环境变量名；所有通道必须配置操作者白名单。
`

const RESEARCH_README = `# 研究产物

此目录保存脱敏、可审计的研究产物。原始影像、DICOM 头、患者标识和逐例预测不得放入本目录或提交到 Git。

标准产物：

- \`research_question.yaml\`：研究问题与终点
- \`dataset_manifest.json\`：SSH 端只读审计后的脱敏数据清单
- \`study_protocol.md\`：冻结研究方案
- \`experiment_spec.yaml\`：可执行实验规格
- \`run_receipt.json\`：运行与环境回执
- \`claim_evidence_map.yaml\`：独立复核后的主张—证据映射

方案冻结和结果复核后都必须停在人工检查点。
`

const TEMPLATE_FILES: Readonly<Record<string, string>> = {
  '.oph/team.json': TEAM_CONFIG,
  '.agents/skills/oph-research-pipeline/SKILL.md': PIPELINE_SKILL,
  '.agents/skills/oph-question-design/SKILL.md': QUESTION_DESIGN_SKILL,
  '.agents/skills/oph-study-protocol/SKILL.md': STUDY_PROTOCOL_SKILL,
  '.agents/skills/oph-research-reporting/SKILL.md': REPORTING_SKILL,
  '.agents/skills/ssh-data-audit/SKILL.md': DATA_AUDIT_SKILL,
  '.agents/skills/ssh-experiment-runner/SKILL.md': EXPERIMENT_SKILL,
  '.agents/skills/oph-results-review/SKILL.md': REVIEW_SKILL,
  'research/README.md': RESEARCH_README,
  'research/OPEN_SOURCE_STACK.md': OPEN_SOURCE_STACK,
}

function migrateTeamConfig(path: string): boolean {
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    parsed = value as Record<string, unknown>
  } catch {
    return false
  }

  let changed = false
  if (typeof parsed.templateVersion !== 'number' || parsed.templateVersion < 2) {
    parsed.templateVersion = 2
    changed = true
  }
  if (!Array.isArray(parsed.roles)) return false

  const roles = parsed.roles.filter((role): role is Record<string, unknown> =>
    Boolean(role && typeof role === 'object'),
  )
  for (const defaultRole of DEFAULT_TEAM.roles) {
    const existing = roles.find((role) => role.id === defaultRole.id)
    if (!existing) {
      roles.push(JSON.parse(JSON.stringify(defaultRole)) as Record<string, unknown>)
      changed = true
      continue
    }
    if (!Array.isArray(existing.modules)) {
      existing.modules = [...defaultRole.modules]
      changed = true
    }
    if (!Array.isArray(existing.skills)) {
      existing.skills = [...defaultRole.skills]
      changed = true
    }
  }
  parsed.roles = roles
  if (changed) writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return changed
}

/** 补齐研究工作区模板。普通文件用 `wx`；团队配置仅做可预测的增量迁移。 */
export function ensureResearchWorkspace(workspaceRoot: string): ResearchTemplateResult {
  const result: ResearchTemplateResult = { created: [], existing: [], updated: [] }
  mkdirSync(workspaceRoot, { recursive: true })

  for (const [relativePath, content] of Object.entries(TEMPLATE_FILES)) {
    const path = join(workspaceRoot, relativePath)
    mkdirSync(dirname(path), { recursive: true })
    try {
      writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' })
      result.created.push(relativePath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      result.existing.push(relativePath)
    }
  }

  const teamPath = join(workspaceRoot, '.oph/team.json')
  if (!result.created.includes('.oph/team.json') && migrateTeamConfig(teamPath)) {
    result.updated.push('.oph/team.json')
  }

  return result
}
