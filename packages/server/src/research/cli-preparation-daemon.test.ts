import { expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyCandidateReceipt } from './cli-preparation-candidate.ts'
import {
  type CliPreparationJobSpec,
  cliPreparationAdapterConfigHash,
  cliPreparationExecutableHash,
} from './cli-preparation-job.ts'
import { JobDaemon } from './job-daemon.ts'

function hash(label: string) {
  return `sha256:${new Bun.CryptoHasher('sha256').update(label).digest('hex')}`
}

async function waitFor(daemon: JobDaemon, key: string, status: string) {
  for (let i = 0; i < 300; i++) {
    if (daemon.query(key)?.status === status) return
    await Bun.sleep(10)
  }
  throw new Error(`job did not reach ${status}`)
}

function spec(
  dispatchKey: string,
  maxRuntimeMs = 2_000,
  adapterId = 'fixture',
): CliPreparationJobSpec {
  return {
    version: 3,
    dispatchKey,
    campaignId: 'campaign-prep',
    taskRevisionId: 'task-prep',
    templateId: 'synthetic-summary-v1',
    backendPolicyHash: hash('device-backend-policy'),
    inputHash: hash('frozen-data-input'),
    resource: { cpu: 1, memoryMb: 256 },
    lease: {
      ownerId: 'daemon',
      token: 'prep-lease',
      fence: 1,
      expiresAt: Date.now() + 60_000,
    },
    execution: {
      adapter: 'cli-preparation-v1',
      preparationId: `prepare-${dispatchKey}`,
      candidateId: `candidate-${dispatchKey}`,
      clientDispatchKey: `client-${dispatchKey}`,
      adapterId,
      adapterConfigHash: hash('placeholder-adapter-config'),
      model: 'fixture-model',
      instructions: 'Return a review-only candidate.',
      configHash: hash('frozen-proposal-config'),
      deviceId: 'local-fixture',
      maxRuntimeMs,
      maxCost: 1,
    },
  }
}

async function fixture(script: string): Promise<{ root: string; daemon: JobDaemon; cli: string }> {
  const root = await mkdtemp(join(tmpdir(), 'oph-cli-prep-daemon-'))
  const cli = join(root, 'fake-cli')
  await writeFile(cli, script)
  await chmod(cli, 0o755)
  const daemon = new JobDaemon({
    dbPath: join(root, 'jobs.sqlite'),
    outputRoot: join(root, 'output'),
    cliPreparation: {
      backendPolicyHash: hash('device-backend-policy'),
      workspaceRoot: root,
      workspaceScope: '.',
      credentialHome: join(root, 'credentials'),
      adapters: [
        {
          deviceId: 'local-fixture',
          kind: 'codex-exec',
          executable: cli,
          binaryHash: cliPreparationExecutableHash(cli),
          id: 'fixture',
          model: 'fixture-model',
        },
      ],
    },
  })
  return { root, daemon, cli }
}

test('JobDaemon runs an admitted fake CLI and verifies the complete v3 candidate receipt', async () => {
  const event = JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: JSON.stringify({ code: 'export const candidate = 1' }),
    },
  })
  const { root, daemon } = await fixture(`#!/bin/sh\nprintf '%s\\n' '${event}'\n`)
  try {
    const job = spec('prep-success')
    job.execution.adapterConfigHash = cliPreparationAdapterConfigHash({
      kind: 'codex-exec',
      executable: join(root, 'fake-cli'),
      binaryHash: cliPreparationExecutableHash(join(root, 'fake-cli')),
      id: 'fixture',
      model: 'fixture-model',
    })
    daemon.submit(job)
    const worker = await daemon.launchWorker(job.dispatchKey)
    expect(await worker.exited).toBe(0)
    await waitFor(daemon, job.dispatchKey, 'completed')
    const bytes = await readFile(join(root, 'output', job.dispatchKey, 'candidate.json'))
    const receipt = JSON.parse(bytes.toString())
    expect(verifyCandidateReceipt(receipt, job)).toBe(true)
    expect(receipt).toMatchObject({
      inputHash: job.inputHash,
      configHash: job.execution.configHash,
      dispatchKey: job.dispatchKey,
      clientDispatchKey: job.execution.clientDispatchKey,
      taskRevisionId: job.taskRevisionId,
      draft: { humanApprovalRequired: true, usage: null, code: 'export const candidate = 1' },
    })
    expect(receipt.draft.inputHash).not.toBe(job.inputHash)
    receipt.inputHash = hash('tampered')
    expect(verifyCandidateReceipt(receipt, job)).toBe(false)
  } finally {
    daemon.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects unknown administrator adapters before launch', async () => {
  const { root, daemon } = await fixture('#!/bin/sh\nexit 0\n')
  try {
    const job = spec('prep-unknown', 2_000, 'not-admitted')
    job.execution.adapterConfigHash = hash('not-admitted')
    expect(() => daemon.submit(job)).toThrow('adapter is not admitted')
  } finally {
    daemon.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('cancellation and v3 execution deadlines terminate a preparation worker without a candidate', async () => {
  const { root, daemon } = await fixture('#!/bin/sh\ntrap "" TERM\nwhile :; do sleep 1; done\n')
  try {
    const cancelled = spec('prep-cancel')
    cancelled.execution.adapterConfigHash = cliPreparationAdapterConfigHash({
      kind: 'codex-exec',
      executable: join(root, 'fake-cli'),
      binaryHash: cliPreparationExecutableHash(join(root, 'fake-cli')),
      id: 'fixture',
      model: 'fixture-model',
    })
    daemon.submit(cancelled)
    const cancelWorker = await daemon.launchWorker(cancelled.dispatchKey)
    await waitFor(daemon, cancelled.dispatchKey, 'running')
    await Bun.sleep(50)
    expect(daemon.cancel(cancelled.dispatchKey)?.status).toBe('cancel_requested')
    await cancelWorker.exited
    await waitFor(daemon, cancelled.dispatchKey, 'cancelled')
    const restarted = new JobDaemon({
      dbPath: join(root, 'jobs.sqlite'),
      outputRoot: join(root, 'output'),
      cliPreparation: {
        backendPolicyHash: hash('device-backend-policy'),
        workspaceRoot: root,
        workspaceScope: '.',
        credentialHome: join(root, 'credentials'),
        adapters: [
          {
            deviceId: 'local-fixture',
            kind: 'codex-exec',
            executable: join(root, 'fake-cli'),
            binaryHash: cliPreparationExecutableHash(join(root, 'fake-cli')),
            id: 'fixture',
            model: 'fixture-model',
          },
        ],
      },
    })
    expect(restarted.query(cancelled.dispatchKey)?.status).toBe('cancelled')
    restarted.close()

    const timedOut = spec('prep-timeout', 50)
    timedOut.execution.adapterConfigHash = cliPreparationAdapterConfigHash({
      kind: 'codex-exec',
      executable: join(root, 'fake-cli'),
      binaryHash: cliPreparationExecutableHash(join(root, 'fake-cli')),
      id: 'fixture',
      model: 'fixture-model',
    })
    daemon.submit(timedOut)
    const timeoutWorker = await daemon.launchWorker(timedOut.dispatchKey)
    await timeoutWorker.exited
    await waitFor(daemon, timedOut.dispatchKey, 'cancelled')
    expect(daemon.query(timedOut.dispatchKey)?.outputPath).toBeNull()
  } finally {
    daemon.close()
    await rm(root, { recursive: true, force: true })
  }
})
