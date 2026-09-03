/**
 * oph-autoresearch 工作区模板。
 *
 * 模板在服务端内嵌，而不是运行时从源码目录读取：发布后的 `oph` 是单文件 sidecar，
 * 源码旁的 assets 不一定存在。初始化只补缺失文件，绝不覆盖医生或研究者已经修改的内容。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ResearchTemplateResult {
  created: string[]
  existing: string[]
}

const TEAM_CONFIG = `${JSON.stringify(
  {
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
        description: '拆解研究问题、编排阶段、维护产物契约和人工检查点',
        systemPrompt:
          '你负责协调，不代替数据审计员或独立审查员下结论。先读取 oph-research-pipeline 技能；每个阶段只接受满足契约的产物。方案冻结后必须等待用户批准。',
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
        id: 'data-auditor',
        name: '数据审计员',
        description: '通过 SSH 对眼科影像数据做只读盘点、完整性与泄漏风险检查',
        systemPrompt:
          '先读取 ssh-data-audit 技能。只在远端聚合统计，不打印或下载文件名、患者标识、DICOM 头或原始影像；不得修改远程数据。将脱敏汇总写入 dataset_manifest.json。',
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
        id: 'experimenter',
        name: '实验执行员',
        description: '在 SSH GPU 服务器执行已批准的基线、训练和评估并保留回执',
        systemPrompt:
          '先读取 ssh-experiment-runner 技能。没有明确的方案批准记录不得启动训练。原始数据留在远端；固定配置、种子和代码版本，记录完整运行回执。',
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
    ],
  },
  null,
  2,
)}\n`

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
6. **医生审阅（接口预留）**
   - 只交换脱敏任务 id、标注状态与审阅决定；不得把浏览器当成原始数据传输通道。

## 推荐编排

使用 workflow 明确依赖：研究协调员 → 数据审计员 → 研究协调员（方案）→ checkpoint → 实验执行员 → 独立复核员 → checkpoint。没有依赖的检查可并行，但审查节点不得与被审对象共享隐式上下文。

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
  '.agents/skills/ssh-data-audit/SKILL.md': DATA_AUDIT_SKILL,
  '.agents/skills/ssh-experiment-runner/SKILL.md': EXPERIMENT_SKILL,
  '.agents/skills/oph-results-review/SKILL.md': REVIEW_SKILL,
  'research/README.md': RESEARCH_README,
}

/** 补齐研究工作区模板。`wx` 保证并发初始化也不会覆盖用户文件。 */
export function ensureResearchWorkspace(workspaceRoot: string): ResearchTemplateResult {
  const result: ResearchTemplateResult = { created: [], existing: [] }
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

  return result
}
