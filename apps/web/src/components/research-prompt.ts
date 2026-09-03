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
1. 先读取并遵循 oph-research-pipeline 技能；需要访问远程数据时再读取 ssh-data-audit 或 ssh-experiment-runner。
2. 第一阶段只做远程只读盘点、数据泄漏风险检查和研究方案，不启动训练。
3. 原始影像始终留在 SSH 服务器，不下载到本机；本机只保存脱敏元数据、方案、代码和汇总结果。
4. 产出 research/research_question.yaml、research/dataset_manifest.json 和 research/study_protocol.md。
5. 完成方案后停止在检查点，向我汇报数据概况、风险、拟定实验和需要确认的决定，得到批准后再启动基线实验。
6. 优先把实现与审查交给不同模型；可用时调用外部 Claude Code 或 Codex CLI，并保留各自回执。`
}
