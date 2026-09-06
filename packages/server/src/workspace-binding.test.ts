import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getWorkspace, listWorkspaces, Store, upsertWorkspace } from '@oph-autoresearch/store'
import * as tools from '@oph-autoresearch/tools'
import { type ApiDeps, handleApi } from './api/index.ts'
import { resolveWorkspaceServerBinding, verifyWorkspaceServerBinding } from './workspace-binding.ts'

const profile: tools.SshProfile = {
  id: 'fixture-server',
  name: 'Fixture',
  host: 'gpu.example.org',
  username: 'researcher',
  port: 22,
  root: '/research',
  readOnly: false,
  hostKeyPolicy: 'strict',
}
describe('研究项目与服务器目录绑定', () => {
  let store: Store
  let home: string
  let oldHome: string | undefined
  let profiles: ReturnType<typeof spyOn>
  let inspect: ReturnType<typeof spyOn>
  const call = (path: string, body?: unknown) =>
    handleApi(
      new URL(`http://localhost${path}`),
      new Request(
        `http://localhost${path}`,
        body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) },
      ),
      {
        store,
        config: {
          active: { provider: 'p', model: 'm' },
          providers: { p: { kind: 'openai_chat_completions', models: { m: {} } } },
          mode: 'auto',
        },
        watchGit: () => {},
      } as unknown as ApiDeps,
    )
  beforeEach(async () => {
    store = new Store({ path: ':memory:' })
    oldHome = process.env.OPH_AUTORESEARCH_HOME
    home = await mkdtemp(join(tmpdir(), 'oph-project-binding-'))
    process.env.OPH_AUTORESEARCH_HOME = home
    profiles = spyOn(tools, 'loadSshProfiles').mockResolvedValue([profile])
    inspect = spyOn(tools, 'inspectSshDirectory').mockResolvedValue('/research/project')
  })
  afterEach(async () => {
    profiles.mockRestore()
    inspect.mockRestore()
    store.close()
    if (oldHome === undefined) delete process.env.OPH_AUTORESEARCH_HOME
    else process.env.OPH_AUTORESEARCH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  })
  test('尚无项目也能读取服务器配置，解除首项目创建的循环依赖', async () => {
    const response = await call('/api/ssh/profiles')
    expect(response?.status).toBe(200)
    expect(await response!.json()).toMatchObject({
      profiles: [expect.objectContaining({ id: profile.id })],
    })
  })
  test('新项目与首会话原子保存规范化目录，返回与重新读取都保留绑定', async () => {
    const response = await call('/api/workspaces', {
      name: 'bound-project',
      serverBinding: { profileId: profile.id, remoteRoot: '/research/project/' },
    })
    expect(response?.status).toBe(200)
    const data = (await response!.json()) as {
      workspace: ReturnType<typeof upsertWorkspace>
      conversations: unknown[]
    }
    expect(data.workspace.serverBinding).toEqual({
      version: 1,
      profileId: profile.id,
      remoteRoot: '/research/project',
      connectionHash: tools.sshProfileConnectionHash(profile),
      verifiedAt: expect.any(Number),
    })
    expect(inspect).toHaveBeenCalledWith(profile, '/research/project/', true)
    expect(data.conversations).toHaveLength(1)
    expect(getWorkspace(store, data.workspace.id)?.serverBinding).toEqual(
      data.workspace.serverBinding,
    )
    expect(JSON.stringify(data.workspace.serverBinding)).not.toContain(profile.host)
    const active = await call(`/api/workspace?ws=${data.workspace.id}`)
    expect(await active!.json()).toMatchObject({ serverBinding: data.workspace.serverBinding })
    const again = await call('/api/workspaces', { path: data.workspace.rootPath })
    expect(again?.status).toBe(200)
    expect(inspect).toHaveBeenCalledTimes(1)
  })
  test('无绑定、无效服务器和不可写目录都不会创建项目或目录', async () => {
    for (const serverBinding of [
      undefined,
      { profileId: 'missing', remoteRoot: '/research/project' },
      { profileId: profile.id, remoteRoot: 'relative' },
    ]) {
      expect((await call('/api/workspaces', { name: 'rejected', serverBinding }))?.status).toBe(422)
    }
    inspect.mockRejectedValue(new Error('目录不可写'))
    expect(
      (
        await call('/api/workspaces', {
          name: 'rejected',
          serverBinding: { profileId: profile.id, remoteRoot: '/research/project' },
        })
      )?.status,
    ).toBe(422)
    expect(listWorkspaces(store)).toHaveLength(0)
    expect(await stat(join(home, 'workspaces')).catch(() => null)).toBeNull()
  })
  test('旧项目可初次绑定，但不能改派到其他目录', async () => {
    const old = upsertWorkspace(store, home, 'historical')
    const body = { profileId: profile.id, remoteRoot: '/research/project' }
    expect((await call(`/api/workspaces/${old.id}/server-binding`, body))?.status).toBe(200)
    inspect.mockResolvedValue('/research/other')
    expect(
      (
        await call(`/api/workspaces/${old.id}/server-binding`, {
          ...body,
          remoteRoot: '/research/other',
        })
      )?.status,
    ).toBe(409)
    expect(getWorkspace(store, old.id)?.serverBinding?.remoteRoot).toBe('/research/project')
  })
  test('配置被删除或连接身份被修改时不回退到其他服务器', async () => {
    const ws = upsertWorkspace(store, home, 'test')
    ws.serverBinding = await verifyWorkspaceServerBinding({
      profileId: profile.id,
      remoteRoot: '/research/project',
    })
    expect((await resolveWorkspaceServerBinding(ws)).profile.root).toBe('/research/project')
    profiles.mockResolvedValue([{ ...profile, host: 'changed.example.org' }])
    await expect(resolveWorkspaceServerBinding(ws)).rejects.toThrow()
    profiles.mockResolvedValue([])
    await expect(resolveWorkspaceServerBinding(ws)).rejects.toThrow('已删除')
    delete ws.serverBinding
    await expect(resolveWorkspaceServerBinding(ws)).rejects.toThrow('尚未绑定')
  })
  test('SSH 返回根目录外的规范路径也拒绝', async () => {
    inspect.mockResolvedValue('/outside/project')
    await expect(
      verifyWorkspaceServerBinding({ profileId: profile.id, remoteRoot: '/research/link' }),
    ).rejects.toThrow('越过允许根目录')
  })
})
