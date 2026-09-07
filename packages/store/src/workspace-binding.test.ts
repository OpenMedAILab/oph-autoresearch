import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './db.ts'
import { bindWorkspaceServer, getWorkspace, upsertWorkspace } from './repos.ts'

test('项目服务器绑定重开持久化、重复绑定幂等、拒绝改派', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oph-binding-store-'))
  const path = join(dir, 'ledger.db')
  let store = new Store({ path })
  try {
    const ws = upsertWorkspace(store, '/local/project', 'project')
    const binding = {
      version: 1 as const,
      profileId: 'test',
      remoteRoot: '/remote/project',
      connectionHash: `sha256:${'a'.repeat(64)}`,
      verifiedAt: Date.now(),
    }
    expect(ws.serverBinding).toBeUndefined()
    bindWorkspaceServer(store, ws.id, binding)
    store.close()
    store = new Store({ path })
    expect(getWorkspace(store, ws.id)?.serverBinding).toEqual(binding)
    expect(
      bindWorkspaceServer(store, ws.id, { ...binding, verifiedAt: Date.now() + 1 }).serverBinding,
    ).toEqual(binding)
    for (const change of [
      { profileId: 'other' },
      { remoteRoot: '/remote/other' },
      { connectionHash: `sha256:${'b'.repeat(64)}` },
    ]) {
      expect(() => bindWorkspaceServer(store, ws.id, { ...binding, ...change })).toThrow(
        '不能静默改派',
      )
    }
    for (const remoteRoot of [
      'relative',
      '/remote/../etc',
      '/remote/./project',
      '/remote/\nproject',
    ]) {
      expect(() => bindWorkspaceServer(store, ws.id, { ...binding, remoteRoot })).toThrow(
        '绑定无效',
      )
    }
    expect(getWorkspace(store, ws.id)?.serverBinding).toEqual(binding)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
