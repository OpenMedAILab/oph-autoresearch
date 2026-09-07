import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadRemoteChannels,
  REMOTE_CHANNEL_CATALOG,
  type RemoteChannelConfig,
  remoteChannelStatus,
  saveRemoteChannels,
} from './remote-channels.ts'

const channel: RemoteChannelConfig = {
  id: 'oph-feishu',
  kind: 'feishu',
  name: '科研遥控',
  enabled: true,
  appId: 'feishu-app',
  secretEnv: 'OPH_FEISHU_SECRET',
  allowFrom: ['doctor-1'],
  controlLevel: 'review',
}

describe('远程遥控通道配置', () => {
  test('只提供飞书、企业微信与 QQ 三种通道', () => {
    expect(REMOTE_CHANNEL_CATALOG.map((item) => item.kind)).toEqual(['feishu', 'wecom', 'qq'])
  })

  test('只落环境变量名，不接受空白操作者列表', async () => {
    const previous = process.env.OPH_AUTORESEARCH_HOME
    process.env.OPH_AUTORESEARCH_HOME = await mkdtemp(join(tmpdir(), 'oph-remote-channel-'))
    try {
      await saveRemoteChannels([{ ...channel, secret: 'must-not-be-stored' }])
      expect(await loadRemoteChannels()).toEqual([channel])
      await expect(saveRemoteChannels([{ ...channel, allowFrom: [] }])).rejects.toThrow('操作者')
    } finally {
      if (previous === undefined) delete process.env.OPH_AUTORESEARCH_HOME
      else process.env.OPH_AUTORESEARCH_HOME = previous
    }
  })

  test('状态区分未注入凭证与可启动', () => {
    const previous = process.env.OPH_FEISHU_SECRET
    delete process.env.OPH_FEISHU_SECRET
    expect(remoteChannelStatus(channel).state).toBe('missing_credential')
    process.env.OPH_FEISHU_SECRET = 'secret'
    expect(remoteChannelStatus(channel).state).toBe('configured')
    if (previous === undefined) delete process.env.OPH_FEISHU_SECRET
    else process.env.OPH_FEISHU_SECRET = previous
  })
})
