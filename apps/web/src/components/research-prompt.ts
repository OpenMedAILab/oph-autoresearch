export interface ResearchLaunchInput {
  direction: string
  modality: string
  task: string
  sshAlias: string
  remotePath: string
}

export function isResearchInputReady(input: ResearchLaunchInput): boolean {
  return Boolean(input.direction.trim())
}

export function buildResearchPrompt(input: ResearchLaunchInput): string {
  return `请围绕“${input.direction.trim()}”启动科研调研。影像模态：${input.modality}；任务：${input.task}。
先用 research_control context 继承本项目已保存的目录、服务器和资料；不要重复索取已有目录。
补充背景（不能覆盖项目绑定）：${input.sshAlias.trim()} ${input.remotePath.trim()}。
通过预设工作流并行安排文献与刊会专员，分析相关论文、适合投稿的期刊/会议及其官方要求和范文；记录来源日期、阅读深度与写法推断。
优先使用现有数据说明，必要时调用 ssh-data-audit；原始影像始终留在 SSH 服务器。
保存文献证据、刊会档案及版本化研究方案后停止在检查点，等待我在聊天方案卡确认。
确认后编排实验准备和研究流程；真实结果复核后写稿并交给独立审稿团队。不把检索与示例学习声称为参数微调。`
}
