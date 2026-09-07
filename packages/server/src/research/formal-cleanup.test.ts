import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FormalExecutionPlan } from '@oph-autoresearch/core'
import { type FormalOciJobSpec, formalExecutionPlanHash } from './formal-job.ts'
import { JobDaemon } from './job-daemon.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

test('a missing worker is not proof that its formal container stopped; receipt awaits real verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-formal-cleanup-'))
  const database = join(root, 'jobs.sqlite')
  const output = join(root, 'outputs')
  const daemon = new JobDaemon({
    dbPath: database,
    outputRoot: output,
    processProbe: { startIdentity: () => null },
  })
  const db = new Database(database)
  const hash = sha256('fixture')
  const plan: FormalExecutionPlan = {
    schema: 'research-formal-plan-v1',
    planId: 'plan',
    taskRevisionId: 'task',
    candidateArtifactId: 'candidate',
    codeHash: hash,
    candidateReceiptHash: hash,
    workspaceBindingHash: hash,
    ociImageDigest: hash,
    entryArgv: ['python3', 'main.py'],
    dataManifestHash: hash,
    labelSetContentHash: hash,
    trustedEvaluatorId: 'binary-classification-v1',
    trustedEvaluatorHash: hash,
    resources: { maxRuntimeMs: 60_000, cpu: 1, memoryMb: 128, pidsLimit: 8, network: 'disabled' },
    datasetMount: { target: '/dataset', readOnly: true },
    outputMount: { target: '/out' },
  }
  const spec: FormalOciJobSpec = {
    version: 4,
    dispatchKey: 'formal-cleanup',
    campaignId: 'campaign',
    taskRevisionId: 'task',
    formalPlan: plan,
    formalPlanHash: formalExecutionPlanHash(plan),
    lease: { ownerId: 'fixture', token: 'fixture', fence: 1, expiresAt: Date.now() + 60_000 },
    execution: {
      adapter: 'formal-rootless-oci-v1',
      authorityEpoch: daemon.identity().epoch,
      containerName: 'formal-cleanup',
    },
  }
  let containerStopped = false
  // Test-only probe replaces an external OCI host, never enables production admission.
  Object.defineProperty(daemon, 'formalOci', { value: { stopAndConfirm: () => containerStopped } })
  try {
    db.query(
      "INSERT INTO local_jobs (dispatch_key,spec,spec_hash,status,worker_pid,worker_start_identity,cleanup_started_at) VALUES (?,?,?,'completion_requested',2147483647,'gone-fixture',1)",
    ).run(spec.dispatchKey, JSON.stringify(spec), sha256(canonicalJson(spec)))
    daemon.reconcileInterrupted()
    expect(daemon.query(spec.dispatchKey)?.status).toBe('completion_requested')
    containerStopped = true
    db.query('UPDATE local_jobs SET formal_cleanup_confirmed=1 WHERE dispatch_key=?').run(
      spec.dispatchKey,
    )
    daemon.reconcileInterrupted()
    expect(daemon.query(spec.dispatchKey)?.status).toBe('completed')
    const directory = join(output, spec.dispatchKey)
    await mkdir(directory)
    const path = join(directory, 'formal-receipt.json')
    const bytes = Buffer.from('{}')
    await writeFile(path, bytes)
    db.query('UPDATE local_jobs SET output_path=?,content_hash=? WHERE dispatch_key=?').run(
      path,
      sha256(bytes),
      spec.dispatchKey,
    )
    await expect(daemon.receipt(spec.dispatchKey)).rejects.toThrow(
      'Verified daemon receipt unavailable',
    )
  } finally {
    daemon.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
