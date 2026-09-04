export interface ResearchLaunchInput {
  direction: string
  modality: string
  task: string
  sshAlias: string
  remotePath: string
}

export function isResearchInputReady(input: ResearchLaunchInput): boolean {
  return Boolean(input.direction.trim() && input.sshAlias.trim() && input.remotePath.trim())
}

export function buildResearchPrompt(input: ResearchLaunchInput): string {
  return `请启动眼科影像自动科研 MVP 工作流。

## 研究输入
- 研究方向：${input.direction.trim()}
- 影像模态：${input.modality}
- 任务类型：${input.task}
- SSH 主机别名：${input.sshAlias.trim()}
- 远程数据路径：${input.remotePath.trim()}

## 执行要求
1. 先读取并遵循 oph-research-pipeline 技能和 .oph/patterns.json；需要访问远程数据时再读取 ssh-data-audit 或 ssh-experiment-runner。
2. 第一阶段只做远程只读盘点、数据泄漏风险检查和研究方案，不启动训练。
3. 原始影像始终留在 SSH 服务器，不下载到本机；本机只保存脱敏元数据、方案、代码和汇总结果。
4. 第一轮采用“候选—反证—综合”和“分布式数据审计”Pattern，生成者、临床反证员和方法学批评员使用独立上下文；每张 workflow 图都以人工 checkpoint 收尾。
5. 产出 research/research_question.yaml、research/dataset_manifest.json 和 research/study_protocol.md，并同步更新 research/artifact_ledger.yaml 与 research/pitfall_registry.yaml。
6. 完成方案后停止在检查点，向我汇报数据概况、风险、拟定实验和需要确认的决定，得到批准后再启动基线实验。
7. 优先把生成、反证和审查交给不同模型；workflow 节点需要时显式填写 provider + model，可用时调用外部 Claude Code 或 Codex CLI，并保留各自回执。`
}
