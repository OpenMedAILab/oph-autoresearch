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

async function fixture(
  script: string | ((root: string) => string),
): Promise<{ root: string; daemon: JobDaemon; cli: string }> {
  const root = await mkdtemp(join(tmpdir(), 'oph-cli-prep-daemon-'))
  const cli = join(root, 'fake-cli')
  await writeFile(cli, typeof script === 'function' ? script(root) : script)
  await chmod(cli, 0o755)
  const daemon = new JobDaemon({
    dbPath: join(root, 'jobs.sqlite'),
    outputRoot: join(root, 'output'),
    cliPreparation: adminConfig(root, cli),
  })
  return { root, daemon, cli }
}

function adminConfig(root: string, cli: string) {
  return {
    backendPolicyHash: hash('device-backend-policy'),
    workspaceRoot: root,
    workspaceScope: '.',
    credentialHome: join(root, 'credentials'),
    adapters: [
      {
        deviceId: 'local-fixture',
        kind: 'codex-exec' as const,
        executable: cli,
        binaryHash: cliPreparationExecutableHash(cli),
        id: 'fixture',
        model: 'fixture-model',
      },
    ],
  }
}

function bindAdmittedAdapter(job: CliPreparationJobSpec, cli: string) {
  job.execution.adapterConfigHash = cliPreparationAdapterConfigHash({
    kind: 'codex-exec',
    executable: cli,
    binaryHash: cliPreparationExecutableHash(cli),
    id: 'fixture',
    model: 'fixture-model',
  })
}

async function waitForPid(path: string) {
  for (let i = 0; i < 300; i++) {
    try {
      const text = await Bun.file(path).text()
      const pid = Number(text.trim())
      if (Number.isSafeInteger(pid) && pid > 1) return pid
    } catch {}
    await Bun.sleep(10)
  }
  throw new Error(`PID marker was not written: ${path}`)
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number) {
  for (let i = 0; i < 300; i++) {
    if (!processExists(pid)) return
    await Bun.sleep(10)
  }
  throw new Error(`process did not exit: ${pid}`)
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
    await worker.exited
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

test('durably completes a receipt while killing a stream-closed CLI grandchild', async () => {
  const event = JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: JSON.stringify({ code: 'export const candidate = 2' }) },
  })
  const { root, daemon, cli } = await fixture((fixtureRoot) => {
    const childMarker = join(fixtureRoot, 'completion-grandchild.pid')
    return `#!/bin/sh
/bin/sh -c 'trap "" TERM; while :; do sleep 1; done' </dev/null >/dev/null 2>&1 &
echo $! > '${childMarker}'
printf '%s\\n' '${event}'
`
  })
  try {
    const job = spec('prep-completion')
    bindAdmittedAdapter(job, cli)
    daemon.submit(job)
    const worker = await daemon.launchWorker(job.dispatchKey)
    const grandchildPid = await waitForPid(join(root, 'completion-grandchild.pid'))
    expect(processExists(grandchildPid)).toBe(true)
    await waitFor(daemon, job.dispatchKey, 'completion_requested')
    expect(
      await Promise.race([worker.exited.then(() => true), Bun.sleep(5).then(() => false)]),
    ).toBe(false)
    await worker.exited
    await waitFor(daemon, job.dispatchKey, 'completed')
    await waitForExit(grandchildPid)
    const receipt = JSON.parse(
      (await readFile(join(root, 'output', job.dispatchKey, 'candidate.json'))).toString(),
    )
    expect(verifyCandidateReceipt(receipt, job)).toBe(true)
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

test('a restarted authority kills a started TERM-ignoring CLI group without a candidate', async () => {
  let daemon: JobDaemon | undefined
  let restarted: JobDaemon | undefined
  const { root, daemon: first, cli } = await fixture('')
  daemon = first
  const cliPidMarker = join(root, 'cli.pid')
  const grandchildPidMarker = join(root, 'grandchild.pid')
  await writeFile(
    cli,
    `#!/bin/sh
echo $$ > '${cliPidMarker}'
/bin/sh -c 'trap "" TERM; while :; do sleep 1; done' &
echo $! > '${grandchildPidMarker}'
trap '' TERM
while :; do sleep 1; done
`,
  )
  await chmod(cli, 0o755)
  // Recreate the authority after writing the executable so startup captures its bytes.
  daemon.close()
  daemon = new JobDaemon({
    dbPath: join(root, 'jobs.sqlite'),
    outputRoot: join(root, 'output'),
    cliPreparation: adminConfig(root, cli),
  })
  try {
    const cancelled = spec('prep-cancel')
    bindAdmittedAdapter(cancelled, cli)
    daemon.submit(cancelled)
    const cancelWorker = await daemon.launchWorker(cancelled.dispatchKey)
    await waitFor(daemon, cancelled.dispatchKey, 'running')
    const cliPid = await waitForPid(cliPidMarker)
    const grandchildPid = await waitForPid(grandchildPidMarker)
    expect(processExists(cliPid)).toBe(true)
    expect(processExists(grandchildPid)).toBe(true)
    daemon.close({ terminateWorkers: false })
    daemon = undefined
    restarted = new JobDaemon({
      dbPath: join(root, 'jobs.sqlite'),
      outputRoot: join(root, 'output'),
      cliPreparation: adminConfig(root, cli),
    })
    expect(restarted.cancel(cancelled.dispatchKey)?.status).toBe('cancel_requested')
    await cancelWorker.exited
    await waitFor(restarted, cancelled.dispatchKey, 'cancelled')
    expect(processExists(cliPid)).toBe(false)
    expect(processExists(grandchildPid)).toBe(false)
    expect(
      await Bun.file(join(root, 'output', cancelled.dispatchKey, 'candidate.json')).exists(),
    ).toBe(false)
  } finally {
    daemon?.close()
    restarted?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('normal daemon close synchronously kills a started CLI group and its grandchild', async () => {
  let daemon: JobDaemon | undefined
  const {
    root,
    daemon: first,
    cli,
  } = await fixture((fixtureRoot) => {
    const cliPidMarker = join(fixtureRoot, 'close-cli.pid')
    const grandchildPidMarker = join(fixtureRoot, 'close-grandchild.pid')
    return `#!/bin/sh
echo $$ > '${cliPidMarker}'
/bin/sh -c 'trap "" TERM; while :; do sleep 1; done' &
echo $! > '${grandchildPidMarker}'
trap '' TERM
while :; do sleep 1; done
`
  })
  daemon = first
  try {
    const job = spec('prep-close')
    bindAdmittedAdapter(job, cli)
    daemon.submit(job)
    const worker = await daemon.launchWorker(job.dispatchKey)
    await waitFor(daemon, job.dispatchKey, 'running')
    const cliPid = await waitForPid(join(root, 'close-cli.pid'))
    const grandchildPid = await waitForPid(join(root, 'close-grandchild.pid'))
    daemon.close()
    daemon = undefined
    await worker.exited
    await waitForExit(cliPid)
    await waitForExit(grandchildPid)
    expect(await Bun.file(join(root, 'output', job.dispatchKey, 'candidate.json')).exists()).toBe(
      false,
    )
  } finally {
    daemon?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('v3 execution deadline terminates preparation without a candidate', async () => {
  const { root, daemon, cli } = await fixture(
    '#!/bin/sh\ntrap "" TERM\nwhile :; do sleep 1; done\n',
  )
  try {
    const timedOut = spec('prep-timeout', 50)
    bindAdmittedAdapter(timedOut, cli)
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
