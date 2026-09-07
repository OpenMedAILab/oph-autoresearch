/** Real loopback HTTP and isolated Git prove runner-side numeric projection and immutable lock bytes. */
import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createRunnerDvcCollector,
  createRunnerMlflowCollector,
  type RunnerMlflowSource,
} from './tracking-adapters.ts'

const runId = '0123456789abcdef0123456789abcdef'
const referenceId = '52d8e8b9-f5ec-408f-bf86-0c72b93f90df'
const canary = 'PRIVATE_PATIENT_PATH_CANARY'

function source(baseUrl: string): RunnerMlflowSource {
  return {
    referenceId,
    baseUrl,
    runId,
    authorization: 'Bearer local-fixture-only',
    metrics: { auroc: { min: 0, max: 1 }, missing: { min: 0, max: 1 } },
    numericParams: { learning_rate: { min: 0, max: 1 } },
  }
}

function payload(value: unknown = 0.85) {
  return {
    run: {
      info: { run_id: runId, status: 'FINISHED', run_name: canary, artifact_uri: `s3://${canary}` },
      data: {
        metrics: [
          { key: 'auroc', value },
          { key: canary, value: 987654321 },
        ],
        params: [
          { key: 'learning_rate', value: '0.001' },
          { key: 'patient', value: canary },
        ],
        tags: [{ key: 'notes', value: canary }],
      },
    },
  }
}

test('only approved numeric aggregates leave the real MLflow HTTP collector', async () => {
  const requests: string[] = []
  let authorized = false
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(`${url.pathname}${url.search}`)
      authorized = request.headers.get('authorization') === 'Bearer local-fixture-only'
      return Response.json(payload())
    },
  })
  try {
    const config = source(`http://127.0.0.1:${server.port}/tracking/`)
    const collect = createRunnerMlflowCollector(config)
    config.metrics.auroc!.min = 1
    config.runId = 'f'.repeat(32)
    const result = await collect()
    expect(authorized).toBe(true)
    expect(requests).toEqual([`/tracking/api/2.0/mlflow/runs/get?run_id=${runId}`])
    expect(result).toEqual({
      source: 'mlflow',
      referenceId,
      status: 'FINISHED',
      metrics: { auroc: 0.85, missing: null },
      numericParams: { learning_rate: 0.001 },
      verification: 'provider-reported',
      artifactAccess: 'not-collected',
    })
    expect(JSON.stringify(result)).not.toContain(canary)
    expect(JSON.stringify(result)).not.toContain(runId)
  } finally {
    server.stop(true)
  }
})

test('redirects, mismatched identities, out-of-range values and duplicate metrics fail closed', async () => {
  let redirectedCalls = 0
  const target = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      redirectedCalls++
      return Response.json(payload())
    },
  })
  let mode = 'redirect'
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      if (mode === 'redirect') return Response.redirect(`http://127.0.0.1:${target.port}/${canary}`)
      const data = payload(mode === 'range' ? 1.1 : mode === 'nonfinite' ? 'NaN' : 0.85)
      if (mode === 'identity') data.run.info.run_id = 'f'.repeat(32)
      if (mode === 'duplicate') data.run.data.metrics.push({ key: 'auroc', value: 0.9 })
      return Response.json(data)
    },
  })
  try {
    const collect = createRunnerMlflowCollector(source(`http://127.0.0.1:${server.port}`))
    await expect(collect()).rejects.toThrow('source unavailable')
    expect(redirectedCalls).toBe(0)
    for (mode of ['identity', 'range', 'nonfinite', 'duplicate'])
      await expect(collect()).rejects.toThrow()
    expect(() => createRunnerMlflowCollector(source('http://private-clinical-host/'))).toThrow(
      'HTTPS',
    )
  } finally {
    server.stop(true)
    target.stop(true)
  }
})

test('DVC reference hashes a committed lock even when the working copy later contains different bytes', async () => {
  const temporary = join(import.meta.dir, '..', '..', '..', '..', '.tmp', 'tracking-adapter-tests')
  await mkdir(temporary, { recursive: true })
  const root = await mkdtemp(join(temporary, 'run-'))
  const config = join(root, 'empty-git-config')
  await writeFile(config, '')
  async function git(args: string[]) {
    const child = Bun.spawn(
      ['git', '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd: root,
        env: { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`Fixture Git failed: ${stderr}`)
    return stdout.trim()
  }
  await git(['init', '--initial-branch=main', '--object-format=sha1'])
  const lock = `schema: '2.0'\nstages:\n  evaluation:\n    deps:\n      - path: ${canary}\n        md5: abcdef\n`
  await writeFile(join(root, 'dvc.lock'), lock)
  await git(['add', '--', 'dvc.lock'])
  await git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Synthetic DVC metadata',
  ])
  const revision = await git(['rev-parse', 'HEAD'])
  await writeFile(join(root, 'dvc.lock'), 'uncommitted changed bytes')
  const result = await createRunnerDvcCollector({ referenceId, repositoryRoot: root, revision })()
  expect(result).toEqual({
    source: 'dvc',
    referenceId,
    revision,
    lockSha256: `sha256:${new Bun.CryptoHasher('sha256').update(lock).digest('hex')}`,
    lockByteLength: Buffer.byteLength(lock),
    verification: 'git-lock-bytes',
    dataAccess: 'not-collected',
  })
  expect(JSON.stringify(result)).not.toContain(canary)
  expect(JSON.stringify(result)).not.toContain(root)
  expect(await readFile(join(root, 'dvc.lock'), 'utf8')).toBe('uncommitted changed bytes')
  expect(() =>
    createRunnerDvcCollector({ referenceId, repositoryRoot: root, revision: 'main' }),
  ).toThrow('full commit')
  const emptyRoot = join(root, 'not-a-repository')
  await mkdir(emptyRoot)
  const originalGitDir = process.env.GIT_DIR
  try {
    process.env.GIT_DIR = join(root, '.git')
    await expect(
      createRunnerDvcCollector({ referenceId, repositoryRoot: emptyRoot, revision })(),
    ).rejects.toThrow('root mismatch')
    expect(
      await createRunnerDvcCollector({ referenceId, repositoryRoot: root, revision })(),
    ).toEqual(result)
  } finally {
    if (originalGitDir === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = originalGitDir
  }
})
