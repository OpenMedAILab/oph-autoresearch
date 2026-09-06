import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FormalExecutionPlan } from '@oph-autoresearch/core'
import { cliPreparationExecutableHash } from './cli-preparation-job.ts'
import { type FormalOciJobSpec, formalExecutionPlanHash } from './formal-job.ts'
import { FormalOciAdapter, type PodmanCommand, probeRootlessPodman } from './formal-oci.ts'

function hash(value: Uint8Array | string) {
  return `sha256:${new Bun.CryptoHasher('sha256').update(value).digest('hex')}`
}

test('formal OCI adapter admits only rootless cgroup-v2 Podman and builds a closed argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-formal-oci-'))
  const podman = join(root, 'podman-fixture')
  const dataset = join(root, 'dataset')
  const output = join(root, 'out')
  const mainPy = join(root, 'main.py')
  const candidateReceipt = join(root, 'candidate.json')
  const labels = join(root, 'labels.json')
  await mkdir(dataset)
  await mkdir(output)
  await writeFile(podman, '#!/bin/sh\nexit 0\n')
  await chmod(podman, 0o755)
  await writeFile(mainPy, 'print("fixed candidate")\n')
  await writeFile(candidateReceipt, '{"candidate":"fixed"}\n')
  await writeFile(
    labels,
    JSON.stringify([
      { id: 'case-a', label: 1 },
      { id: 'case-b', label: 0 },
    ]),
  )
  const calls: string[][] = []
  const command: PodmanCommand = {
    run(argv) {
      calls.push([...argv])
      if (argv[0] === 'info')
        return {
          exitCode: 0,
          stdout: Buffer.from(
            JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: 'v2' } }),
          ),
          stderr: new Uint8Array(),
        }
      return { exitCode: 0, stdout: Buffer.from('worker output'), stderr: new Uint8Array() }
    },
  }
  try {
    const plan: FormalExecutionPlan = {
      schema: 'research-formal-plan-v1',
      planId: 'plan-1',
      taskRevisionId: 'task-1',
      candidateArtifactId: 'candidate-1',
      codeHash: hash(await Bun.file(mainPy).bytes()),
      candidateReceiptHash: hash(await Bun.file(candidateReceipt).bytes()),
      workspaceBindingHash: hash('workspace'),
      ociImageDigest: `sha256:${'a'.repeat(64)}`,
      entryArgv: ['python3', 'main.py'],
      dataManifestHash: hash('data-manifest'),
      labelSetContentHash: hash(await Bun.file(labels).bytes()),
      trustedEvaluatorId: 'binary-classification-v1',
      trustedEvaluatorHash: hash('trusted-evaluator'),
      resources: {
        maxRuntimeMs: 10_000,
        cpu: 1,
        memoryMb: 128,
        pidsLimit: 32,
        network: 'disabled',
      },
      datasetMount: { target: '/dataset', readOnly: true },
      outputMount: { target: '/out' },
    }
    const adapter = new FormalOciAdapter(
      {
        podmanExecutable: podman,
        podmanBinaryHash: cliPreparationExecutableHash(podman),
        candidates: [{ candidateArtifactId: plan.candidateArtifactId, mainPy, candidateReceipt }],
        datasets: [{ dataManifestHash: plan.dataManifestHash, root: dataset }],
        labels: [{ labelSetContentHash: plan.labelSetContentHash, path: labels }],
        evaluators: [{ id: 'binary-classification-v1', hash: plan.trustedEvaluatorHash }],
      },
      command,
      'linux',
    )
    const job: FormalOciJobSpec = {
      version: 4,
      dispatchKey: 'formal-1',
      campaignId: 'campaign-1',
      taskRevisionId: plan.taskRevisionId,
      formalPlan: plan,
      formalPlanHash: formalExecutionPlanHash(plan),
      lease: { ownerId: 'daemon', token: 'lease', fence: 1, expiresAt: Date.now() + 60_000 },
      execution: {
        adapter: 'formal-rootless-oci-v1',
        containerName: 'formal-1',
        authorityEpoch: 'e'.repeat(32),
      },
    }
    const argv = adapter.argv(job, output)
    expect(argv).toContain('--network')
    expect(argv).toContain('none')
    expect(argv).toContain('--read-only')
    expect(argv).toContain('--cap-drop')
    expect(argv).toContain('ALL')
    expect(argv).toContain('no-new-privileges')
    expect(argv).not.toContain('--rm')
    expect(argv.slice(-3)).toEqual([plan.ociImageDigest, 'python3', 'main.py'])
    expect(adapter.run(job, output).exitCode).toBe(0)
    expect(calls[0]).toEqual(['info', '--format', 'json'])

    await writeFile(
      `${output}/predictions.json`,
      JSON.stringify([
        { id: 'case-a', probability: 0.9 },
        { id: 'case-b', probability: 0.2 },
      ]),
    )
    expect(adapter.evaluate(job, output)).toMatchObject({
      planHash: job.formalPlanHash,
      metrics: { accuracy: 1, tp: 1, tn: 1, fp: 0, fn: 0 },
    })
    await writeFile(
      `${output}/predictions.json`,
      JSON.stringify([{ id: 'case-a', probability: 0.9 }]),
    )
    expect(() => adapter.evaluate(job, output)).toThrow('complete truth registry')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('formal OCI probe rejects rootful, cgroup-v1, and non-Linux hosts', () => {
  const rootful: PodmanCommand = {
    run: () => ({
      exitCode: 0,
      stdout: Buffer.from(
        JSON.stringify({ host: { security: { rootless: false }, cgroupVersion: 'v1' } }),
      ),
      stderr: new Uint8Array(),
    }),
  }
  expect(() => probeRootlessPodman(rootful, 'linux')).toThrow('rootless with cgroup v2')
  expect(() => probeRootlessPodman(rootful, 'darwin')).toThrow('requires Linux')
})
