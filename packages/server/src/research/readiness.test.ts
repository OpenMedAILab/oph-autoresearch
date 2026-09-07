import { expect, test } from 'bun:test'
import type { Workspace } from '@oph-autoresearch/core'
import { bindWorkspaceServer, Store, upsertWorkspace } from '@oph-autoresearch/store'
import type { ApiRequestDeps } from '../api/types.ts'
import { researchReadiness } from './readiness.ts'

test('readiness uses the current formal workspace binding and reports missing configuration plus live SSH as unknown', async () => {
  const store = new Store({ path: ':memory:' })
  try {
    const workspace = upsertWorkspace(store, '/tmp/readiness-project', 'readiness')
    bindWorkspaceServer(store, workspace.id, {
      version: 1,
      profileId: 'saved-profile',
      remoteRoot: '/srv/readiness-project',
      connectionHash: `sha256:${'a'.repeat(64)}`,
      verifiedAt: Date.now(),
    })
    let resolved = 0
    const result = await researchReadiness({
      store,
      workspaceId: workspace.id,
      workspaceRoot: workspace.rootPath,
      resolveFormalWorkspaceBinding: async (saved: Workspace) => {
        resolved++
        expect(saved.id).toBe(workspace.id)
        return {
          binding: saved.serverBinding!,
          profile: { root: '/srv/readiness-project' },
        }
      },
    } as unknown as ApiRequestDeps)

    expect(resolved).toBe(1)
    expect(result.checks.find((check) => check.key === 'binding')).toMatchObject({
      status: 'ready',
    })
    expect(result.checks.find((check) => check.key === 'formal_backend')).toMatchObject({
      status: 'blocked',
    })
    expect(result.checks.find((check) => check.key === 'ssh_live')).toMatchObject({
      status: 'unknown',
    })
    expect(result.formalConfigurationReady).toBe(false)
  } finally {
    store.close()
  }
})
