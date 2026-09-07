/**
 * oph-autoresearch 工作区模板。
 *
 * 模板在服务端内嵌，而不是运行时从源码目录读取：发布后的 `oph` 是单文件 sidecar，
 * 源码旁的 assets 不一定存在。初始化补缺失文件；团队模板升级只补字段和角色，不覆盖已有自定义值。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ResearchTemplateResult {
  created: string[]
  existing: string[]
  updated: string[]
}

const DEFAULT_TEAM = {
  templateVersion: 4,
  name: 'oph-autoresearch 眼科科研团队',
  rules: {
    maxConcurrent: 4,
    shared:
      '原始眼科影像与直接标识符不得离开获授权的 SSH 服务器。默认只读；训练、写入远程目录或改变数据前必须经过明确检查点。所有结论必须能追溯到研究产物与运行回执。',
  },
  roles: [
    {
      id: 'coordinator',
      name: '研究协调员',
      description: '通过主控聊天推进调研、方案确认、实验与论文审稿',
      systemPrompt:
        '先读取 oph-research-pipeline。继承已有项目与服务器目录，用 research_control context/prepare 和 workflow/preset 从主题启动研究。内部子代理输出由你核验，研究方案必须等待用户在聊天卡确认。资料与方案保存在版本文档，遇到执行缺项时保留前期成果。',
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
        'research_control',
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
        '先读取 oph-research-reporting 技能。逐条读取 claim_evidence_map，只写已接受或明确标注限制的主张；不新增数字、不弱化局限，不把研究验证写成临床可用。 写稿前读取已保存刊会画像和文献正文证据。官方规则与范文推断分开；使用真实审稿意见只限被授权进入模型上下文的训练集。检索和示例学习不是参数微调。',
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
    {
      id: 'clinical-challenger',
      name: '临床反证员',
      description: '从临床路径、适用人群和失败病例角度主动推翻候选假设与研究结论',
      systemPrompt:
        '你是对抗性审查者，不替候选方案润色。优先寻找不适用人群、替代解释、标签定义冲突、临床无意义终点和会导致结论失效的反例；输出可验证的反证清单。',
      modules: ['临床反例', '适用边界', '替代解释', '失败判据'],
      skills: ['oph-question-design', 'oph-results-review'],
      allowedTools: [
        'read_skill',
        'read_file',
        'list_dir',
        'glob',
        'grep',
        'web_search',
        'web_fetch',
      ],
      maxSteps: 20,
    },
    {
      id: 'methodology-critic',
      name: '方法学批评员',
      description: '独立检查设计、统计、数据泄漏、评价指标和多重比较问题',
      systemPrompt:
        '你只依据显式产物与机器可核验证据审查。主动构造数据泄漏、偏倚、指标选择、样本量、阈值与多重比较方面的失败路径；不要把另一个模型的同意当作验证。',
      modules: ['研究设计批评', '统计审查', '泄漏挑战', '稳健性压力测试'],
      skills: ['oph-study-protocol', 'oph-results-review'],
      allowedTools: ['read_skill', 'read_file', 'list_dir', 'glob', 'grep', 'run_command'],
      maxSteps: 24,
    },
    {
      id: 'reproducibility-auditor',
      name: '可复现审计员',
      description: '核实命令是否真实运行，并校验代码、环境、配置、数据快照和结果之间的证据链',
      systemPrompt:
        '你是独立审计者。不得用 mock、跳过或模型自述代替真实验证；逐项核对运行日志、退出码、代码提交、环境锁定、配置哈希、数据快照和输出文件。证据不足就标记未验证。',
      modules: ['运行真实性', '环境与配置哈希', '产物追踪', '端到端复现'],
      skills: ['ssh-experiment-runner', 'oph-results-review'],
      allowedTools: ['read_skill', 'read_file', 'list_dir', 'glob', 'grep', 'run_command'],
      maxSteps: 24,
    },
    {
      id: 'venue-analyst',
      name: '刊会与写作范例专员',
      description: '分析投稿刊会、官方规则与相关高引用及近期范文',
      systemPrompt:
        '先读 oph-venue-analysis。输出带来源日期的 evidence 与 venue 结构供主控入库。只有摘要时不能分析全文写法。',
      modules: ['刊会适配', '官方投稿要求', '范文分析'],
      skills: ['oph-venue-analysis'],
      allowedTools: [
        'read_skill',
        'read_file',
        'list_dir',
        'glob',
        'grep',
        'web_search',
        'web_fetch',
        'write_file',
      ],
      maxSteps: 28,
    },
    {
      id: 'experiment-preparer',
      name: '实验准备专员',
      description: '在方案确认后整理本地实验交接包',
      systemPrompt:
        '只读取明确交付的确认方案、数据清单和项目绑定。实际生成 research/experiment_handoff.md，列出任务、预期产物、环境及执行缺项，并返回 handoff 结构。你的权限仅限本地准备，禁止远端执行、训练或声称已有实验结果。',
      modules: ['方案交接', '实验准备', '缺项识别'],
      skills: ['oph-study-protocol'],
      allowedTools: [
        'read_skill',
        'read_file',
        'list_dir',
        'glob',
        'grep',
        'write_file',
        'edit_file',
      ],
      maxSteps: 24,
    },
    {
      id: 'manuscript-reviewer',
      name: '稿件证据与规范审稿员',
      description: '独立审阅稿件证据、引用和刊会规范',
      systemPrompt:
        '先读 oph-manuscript-review。仅依据明确交付的稿件版本、实验产物、文献及刊会档案点评；不共享写作推理。输出具体定位、严重程度和可执行建议。',
      modules: ['稿件审阅', '引用核验', '刊会规范'],
      skills: ['oph-manuscript-review'],
      allowedTools: [
        'read_skill',
        'read_file',
        'list_dir',
        'glob',
        'grep',
        'web_search',
        'web_fetch',
      ],
      maxSteps: 24,
    },
  ],
} as const

const LEGACY_ROLE_FIELDS = {
  coordinator: {
    description: '贯穿六阶段，拆解任务、编排角色、维护产物契约和人工检查点',
    systemPrompt:
      '你负责协调，不代替数据审计员或独立审查员下结论。先读取 oph-research-pipeline 技能；每个阶段只接受满足契约的产物。方案冻结后必须等待用户批准。',
  },
  'research-questioner': {
    description: '将临床科研意图转成可检验问题，并建立可追溯的文献证据底稿',
    systemPrompt:
      '先读取 oph-question-design 技能。围绕 PICO/PECO、预期用途、主要终点和可证伪假设工作；文献结论必须保留来源与适用边界，不把搜索摘要当作证据。',
  },
  'data-auditor': {
    description: '通过 SSH 对眼科影像数据做只读盘点、完整性与泄漏风险检查',
    systemPrompt:
      '先读取 ssh-data-audit 技能。只在远端聚合统计，不打印或下载文件名、患者标识、DICOM 头或原始影像；不得修改远程数据。将脱敏汇总写入 dataset_manifest.json。',
  },
  'protocol-statistician': {
    description: '冻结纳排标准、患者级划分、终点、统计方法、基线和消融计划',
    systemPrompt:
      '先读取 oph-study-protocol 技能。所有主要分析、阈值、亚组、缺失处理和失败判据都必须在实验前冻结；发现样本量或标签定义不足时停止并提出最小决策清单。',
  },
  'experiment-engineer': {
    description: '在 SSH GPU 服务器执行已批准的基线、训练和评估并保留回执',
    systemPrompt:
      '先读取 ssh-experiment-runner 技能。没有明确的方案批准记录不得启动训练。原始数据留在远端；固定配置、种子和代码版本，记录完整运行回执。',
  },
  'independent-reviewer': {
    description: '使用独立上下文复核数据划分、统计结果与论文主张',
    systemPrompt:
      '先读取 oph-results-review 技能。不要沿用执行者的未验证解释；从运行回执和机器可核验产物独立复算。发现证据不足时明确驳回，不补造数字。',
  },
  'evidence-writer': {
    description: '只依据已通过复核的证据生成科研报告、模型卡和论文初稿',
    systemPrompt:
      '先读取 oph-research-reporting 技能。逐条读取 claim_evidence_map，只写已接受或明确标注限制的主张；不新增数字、不弱化局限，不把研究验证写成临床可用。',
  },
  'clinical-challenger': {
    description: '从临床路径、适用人群和失败病例角度主动推翻候选假设与研究结论',
    systemPrompt:
      '你是对抗性审查者，不替候选方案润色。优先寻找不适用人群、替代解释、标签定义冲突、临床无意义终点和会导致结论失效的反例；输出可验证的反证清单。',
  },
  'methodology-critic': {
    description: '独立检查设计、统计、数据泄漏、评价指标和多重比较问题',
    systemPrompt:
      '你只依据显式产物与机器可核验证据审查。主动构造数据泄漏、偏倚、指标选择、样本量、阈值与多重比较方面的失败路径；不要把另一个模型的同意当作验证。',
  },
  'reproducibility-auditor': {
    description: '核实命令是否真实运行，并校验代码、环境、配置、数据快照和结果之间的证据链',
    systemPrompt:
      '你是独立审计者。不得用 mock、跳过或模型自述代替真实验证；逐项核对运行日志、退出码、代码提交、环境锁定、配置哈希、数据快照和输出文件。证据不足就标记未验证。',
  },
} as Record<string, Record<string, string>>

const TEAM_CONFIG = `${JSON.stringify(DEFAULT_TEAM, null, 2)}\n`

const PIPELINE_SKILL =
  '---\nname: oph-research-pipeline\ndescription: 主控聊天驱动眼科科研；用于已有项目与数据的文献/刊会调研、方案人工确认、实验交接、证据写作和稿件审阅。\n---\n\n# 主控科研助手\n\n用户提供主题后，先用 research_control context 继承已有目录、服务器绑定和资料。没有研究记录时用 prepare {goal,idempotencyKey} 创建；不要求用户去流程页面或重新填写目录。工具返回的内部标识只在工具间使用。\n\n## 默认工作流\n\n1. 获取 workflow/preset phase=discovery，把返回的 workflow 参数实际交给现有 workflow 工具。文献专员、刊会专员与数据审计员并行，方案统计员综合。数据已准备时先读取清单，必要时才做授权范围内的只读核对。公开文献调研不要求实验环境就绪。\n2. 主控核验输出，用 evidence/fetch 或 record_document/write 保存可定位文献片段、刊会画像，再保存 study。字段以 context.documentSchemas 为准。研究问题、候选比较、主要终点、患者级拆分、基线/消融、资源与停止规则应清楚；未知项不填成事实。\n3. 向用户展示推荐方案与刊会依据，等待聊天方案卡“确认方案并继续”。内部 workflow checkpoint 由主控核验并续接；这不代表人类批准。无需每个内部阶段都询问用户。\n4. 用户确认具体方案版本后，preparation 预设把它交给实验准备专员。实际生成本地交接包后登记 handoff，保留确认方案引用、任务、预期产物和执行缺项。不要把准备完成称为训练完成。\n5. 正式运行前才用 preflight 检查对应执行能力，复用既有执行工具与批准。当前执行器缺失时清楚说明当前节点缺什么，不抹去调研成果。未知运行状态先观察/核对，不盲目重投；取消请求不等于已经停止。\n6. 真实结果经独立复核后，writing 预设使用文献、刊会档案与已接受主张写稿，保存 manuscript；peerreview 预设由临床贡献、方法统计、证据规范三个独立上下文审稿，保存 peerreview，并最多完成一轮返修。发布/投稿仍由用户决定。\n\n## 资料与学习\n\n刊会资料用一个稳定 key 区分期刊或会议届次/track，保存官方要求的来源、日期和适用版本。范文选择说明相关性、高引用或近期代表性；引用数查不到保持 null。官方要求与写法推断结构分开，只有摘要不能声称学习了全文写法。\n\n真实稿件与对应审稿意见按被审版本保存为 reviewcase。同一论文各轮次按 paperGroup 分组，不跨训练/验证/测试集；local-only 和保留集不进入写作或审稿模型。合成样例不算真实审稿案例。检索/示例写作不修改参数；实际微调需另行连接训练后端、数据许可和评测，不能显示假训练成功。\n\n## 不改变的研究边界\n\n原始影像、DICOM 头、患者标识及逐例结果留在授权服务器。本地保存脱敏聚合、代码、方案和汇总产物。方案确认只授权所描述的准备与推进范围；实际远端写入、训练仍遵守既有批准与权限，改变数据、实验范围或资源预算需重新确认。执行者与复核者使用不同模型或独立上下文；证据、负结果和反例不得删除或补造。\n'
const LEGACY_PIPELINE_HASH = '5729f459fd2fb887699f7b1826b7ab84d2734db59c39a10265db7365671e69c4'

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
- \`jiuwenswarm\`：Channel Adapter、Channel Manager、入站/出站 Pipeline 与 Session Router，适合作为飞书、企业微信和 QQ 遥控通道的边界。

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
- \`artifact_ledger.yaml\`：结论、数据快照、代码、运行与验证证据总账
- \`pitfall_registry.yaml\`：失败路线、反例、偏倚与后续回避规则

方案冻结和结果复核后都必须停在人工检查点。
`

const PATTERN_CONFIG = `${JSON.stringify(
  {
    schemaVersion: 1,
    patterns: [
      {
        id: 'candidate-challenge-synthesis',
        name: '候选—反证—综合',
        stages: ['问题建模', '方案冻结'],
        topology: [
          'parallel_candidates',
          'independent_challenge',
          'synthesis',
          'tool_verification',
          'checkpoint',
        ],
        defaultConcurrency: 3,
      },
      {
        id: 'distributed-audit',
        name: '分布式数据审计',
        stages: ['数据审计'],
        topology: ['partitioned_readonly_audits', 'leakage_challenge', 'synthesis', 'checkpoint'],
        defaultConcurrency: 4,
      },
      {
        id: 'experiment-dag',
        name: '远程实验 DAG',
        stages: ['远程实验'],
        topology: ['isolated_experiment_tracks', 'stress_tests', 'receipt_audit', 'checkpoint'],
        defaultConcurrency: 2,
      },
      {
        id: 'self-verification',
        name: '独立自验证',
        stages: ['独立复核'],
        topology: [
          'fresh_context_review',
          'recalculation',
          'falsification',
          'evidence_map',
          'checkpoint',
        ],
        defaultConcurrency: 3,
      },
      {
        id: 'document-review',
        name: '证据约束文档审查',
        stages: ['研究输出'],
        topology: [
          'draft',
          'citation_check',
          'statistics_check',
          'reproducibility_check',
          'synthesis',
          'checkpoint',
        ],
        defaultConcurrency: 3,
      },
    ],
  },
  null,
  2,
)}\n`

const ARTIFACT_LEDGER = `schema_version: 1
artifacts: []
# 每条记录至少包含：artifact_id, stage, path, source, data_snapshot,
# code_revision, config_hash, run_id, verification, created_at。
`

const PITFALL_REGISTRY = `schema_version: 1
pitfalls: []
# 失败路线和反例不删除。每条记录至少包含：pitfall_id, stage, trigger,
# evidence, impact, mitigation, status, related_artifacts。
`

const VENUE_SKILL =
  '---\nname: oph-venue-analysis\ndescription: 为科研主题分析投稿期刊/会议，收集官方要求、相关高引用与近期范文，建立可追溯写作档案。\n---\n\n# 刊会分析\n\n从主题、研究类型和现有数据评估适配度，给出推荐与不适配理由。阅读官网投稿指南，记录URL、获取日期和适用版本；会议须记录届次与track。未知要求明确列出，不猜测截止日期或费用。\n\n同时选择主题相关高引用文章与近期代表文章，保留统计提供方、查询日期与选入理由。引用数未知为null，不等于零。先获取可获得正文、定位章节/段落/页码，再分析引言、贡献、实验、图表、讨论与局限写法；仅元数据/摘要不能支撑全文写法分析。\n\n输出 context.documentSchemas 对应的 evidence 和 venue 记录，交由主控用版本文档入库。rules只放官网明确要求；writingInferences放从范文归纳的观察，并引用相应evidenceKey。公开阅读不自动意味着有训练许可。\n'
const MANUSCRIPT_REVIEW_SKILL =
  '---\nname: oph-manuscript-review\ndescription: 对具体稿件版本执行多角色Agent审稿，使用可追溯证据和刊会规范，输出定位明确的问题与返修建议。\n---\n\n# 稿件审稿\n\n以当前稿件版本、实验结果、文献和刊会画像为输入，使用独立于写作的上下文。分别核对临床贡献、设计统计、主张与证据及官方规范；明确区分证据缺失和表达问题。\n\n每条意见记录角色、段落/图表/主张定位、major/minor、问题及可执行建议。不得编造审稿人身份、真实同行评审或录用保证。主控汇总为peerreview版本文档，至多一轮自动返修，保留原稿与问题处理记录。\n\n审稿案例仅从允许model-context的train数据取例；local-only、validation/test及合成样例不能充当真实校准证据。被审稿版本与最终发表版不可混淆。导入数据不等于已改善模型，检索和提示修正不是参数微调。\n'

const TEMPLATE_FILES: Readonly<Record<string, string>> = {
  '.agents/skills/oph-venue-analysis/SKILL.md': VENUE_SKILL,
  '.agents/skills/oph-manuscript-review/SKILL.md': MANUSCRIPT_REVIEW_SKILL,
  '.oph/team.json': TEAM_CONFIG,
  '.oph/patterns.json': PATTERN_CONFIG,
  '.agents/skills/oph-research-pipeline/SKILL.md': PIPELINE_SKILL,
  '.agents/skills/oph-question-design/SKILL.md': QUESTION_DESIGN_SKILL,
  '.agents/skills/oph-study-protocol/SKILL.md': STUDY_PROTOCOL_SKILL,
  '.agents/skills/oph-research-reporting/SKILL.md': REPORTING_SKILL,
  '.agents/skills/ssh-data-audit/SKILL.md': DATA_AUDIT_SKILL,
  '.agents/skills/ssh-experiment-runner/SKILL.md': EXPERIMENT_SKILL,
  '.agents/skills/oph-results-review/SKILL.md': REVIEW_SKILL,
  'research/README.md': RESEARCH_README,
  'research/OPEN_SOURCE_STACK.md': OPEN_SOURCE_STACK,
  'research/artifact_ledger.yaml': ARTIFACT_LEDGER,
  'research/pitfall_registry.yaml': PITFALL_REGISTRY,
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
  if (typeof parsed.templateVersion !== 'number' || parsed.templateVersion < 4) {
    parsed.templateVersion = 4
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
    for (const field of ['description', 'systemPrompt'] as const) {
      if (
        existing[field] === LEGACY_ROLE_FIELDS[defaultRole.id]?.[field] &&
        existing[field] !== defaultRole[field]
      ) {
        existing[field] = defaultRole[field]
        changed = true
      }
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

  const pipelinePath = join(workspaceRoot, '.agents/skills/oph-research-pipeline/SKILL.md')
  if (
    createHash('sha256').update(readFileSync(pipelinePath)).digest('hex') === LEGACY_PIPELINE_HASH
  ) {
    writeFileSync(pipelinePath, PIPELINE_SKILL)
    result.updated.push('.agents/skills/oph-research-pipeline/SKILL.md')
  }
  const teamPath = join(workspaceRoot, '.oph/team.json')
  if (!result.created.includes('.oph/team.json') && migrateTeamConfig(teamPath)) {
    result.updated.push('.oph/team.json')
  }

  return result
}
