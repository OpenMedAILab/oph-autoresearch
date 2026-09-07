import { expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import type { ResearchExecutionAuthority } from './daemon-execution.ts'
import type { DurableJob } from './job-daemon.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'
import { cancelSyntheticRun, reconcileSyntheticRun, startSyntheticRun } from './synthetic-runner.ts'

test('untrusted authority bytes are rejected before disk and ledger content; recovery never contacts a replacement authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-authority-ingress-'))
  const store = new Store({ path: ':memory:' })
  const canary = 'private-invalid-authority-canary'
  let job: DurableJob | null = null
  const authority: ResearchExecutionAuthority = {
    submit(spec) {
      job = {
        spec,
        specHash: sha256(canonicalJson(spec)),
        status: 'completed',
        contentHash: sha256(canary),
        outputPath: null,
        error: null,
      }
      return job
    },
    query() {
      return job
    },
    cancel() {
      return job
    },
    receipt() {
      return Buffer.from(canary)
    },
    reconcileInterrupted() {},
    hasAvailableSlot() {
      return false
    },
    async launchWorker() {
      throw new Error('not used')
    },
  }
  try {
    const ws = upsertWorkspace(store, root, 'ingress')
    const parent = createConversation(store, {
      workspaceId: ws.id,
      provider: 'none',
      model: 'none',
    })
    const made = createResearchCampaign(store, {
      workspaceId: ws.id,
      parentConversationId: parent.id,
      goal: 'ingress',
      policy: {},
      inputs: {},
      budget: { currency: 'USD', limit: 0 },
      idempotencyKey: 'create',
    })
    if (!made.ok) throw new Error(made.message)
    const result = await startSyntheticRun({
      store,
      workspaceRoot: root,
      campaignId: made.campaign.id,
      expectedVersion: 1,
      dispatchKey: 'once',
      daemonBackend: { daemon: authority },
    })
    expect(result).toMatchObject({ ok: false, code: 'execution_unknown' })
    let current = getResearchCampaign(store, made.campaign.id)!
    expect(current.artifactVersions).toHaveLength(0)
    expect(JSON.stringify(current)).not.toContain(canary)
    expect(await readdir(root)).toHaveLength(0)
    const attemptId = current.attempts[0]!.id
    const recovered = await reconcileSyntheticRun({
      store,
      workspaceRoot: root,
      campaignId: current.id,
      expectedVersion: current.version,
      attemptId,
      daemonBackend: { daemon: authority },
    })
    expect(recovered).toMatchObject({ ok: false, code: 'execution_unknown' })
    expect(await readdir(root)).toHaveLength(0)
    let replacementCalls = 0
    const replacement = {
      ...authority,
      backendPolicyHash: sha256('other-device'),
      query() {
        replacementCalls++
        return job
      },
      cancel() {
        replacementCalls++
        return job
      },
      reconcileInterrupted() {
        replacementCalls++
      },
    }
    current = getResearchCampaign(store, current.id)!
    await reconcileSyntheticRun({
      store,
      workspaceRoot: root,
      campaignId: current.id,
      expectedVersion: current.version,
      attemptId,
      daemonBackend: { daemon: replacement },
    })
    current = getResearchCampaign(store, current.id)!
    cancelSyntheticRun({
      store,
      campaignId: current.id,
      expectedVersion: current.version,
      attemptId,
      daemonBackend: { daemon: replacement },
    })
    expect(replacementCalls).toBe(0)
    expect(getResearchCampaign(store, current.id)!.artifactVersions).toHaveLength(0)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
