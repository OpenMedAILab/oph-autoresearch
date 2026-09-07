import { describe, expect, test } from 'bun:test'
import {
  buildResearchPrompt,
  isResearchInputReady,
  type ResearchLaunchInput,
} from './research-prompt.ts'

const ready: ResearchLaunchInput = {
  direction: '糖尿病视网膜病变分级',
  modality: '眼底彩照',
  task: '疾病分类',
  sshAlias: 'oph-gpu',
  remotePath: '/data/retina',
}

describe('眼科科研启动参数', () => {
  test('研究主题可直接启动调研，目录从现有项目继承', () => {
    expect(isResearchInputReady(ready)).toBe(true)
    expect(isResearchInputReady({ ...ready, sshAlias: ' ' })).toBe(true)
    expect(isResearchInputReady({ ...ready, remotePath: '' })).toBe(true)
  })

  test('任务指令带齐研究输入和远程数据边界', () => {
    const prompt = buildResearchPrompt(ready)
    expect(prompt).toContain('糖尿病视网膜病变分级')
    expect(prompt).toContain('ssh-data-audit')
    expect(prompt).toContain('oph-gpu')
    expect(prompt).toContain('/data/retina')
    expect(prompt).toContain('原始影像始终留在 SSH 服务器')
    expect(prompt).toContain('方案后停止在检查点')
  })
})
