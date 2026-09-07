/** Actual HTTP evaluation proof. Usage: [--training | --retinal] [--daemon | --tracking] [compiled-cli-path]. */
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResearchCampaign } from '@oph-autoresearch/core'
import { Store } from '@oph-autoresearch/store'
import type { RunnerTrackingConfig } from '../packages/server/src/research/runner-tracking.ts'
import { serve } from '../packages/server/src/server.ts'

const root = resolve('.tmp/research-evaluation-smoke')
await mkdir(root, { recursive: true })
const directory = await mkdtemp(join(root, 'run-'))
const workspace = join(directory, 'workspace')
const home = join(directory, 'home')
await mkdir(workspace)
await mkdir(home)
process.env.OPH_AUTORESEARCH_HOME = home
const token = crypto.randomUUID()
const args = process.argv.slice(2)
if (
  args.some(
    (arg) =>
      arg.startsWith('--') && !['--training', '--retinal', '--daemon', '--tracking'].includes(arg),
  )
)
  throw new Error(
    'Usage: research-evaluation-smoke.ts [--training | --retinal] [--daemon | --tracking] [compiled-cli-path]',
  )
const executableArgs = args.filter(
  (arg) => !['--training', '--retinal', '--daemon', '--tracking'].includes(arg),
)
if (executableArgs.length > 1) throw new Error('Only one compiled CLI path is accepted')
const training = args.includes('--training')
const retinal = args.includes('--retinal')
const tracked = args.includes('--tracking')
const daemon = args.includes('--daemon') || tracked
const daemonRoot = join(directory, 'daemon')
if (training && retinal) throw new Error('Choose one template per run')
const source = executableArgs[0] ? resolve(executableArgs[0]) : undefined
let store: Store | undefined
let app: ReturnType<typeof serve> | undefined
let child: ReturnType<typeof Bun.spawn> | undefined
let stdout: Promise<string> | undefined
let stderr: Promise<string> | undefined
let base: string
let executable: string | undefined
let tracking: RunnerTrackingConfig | undefined
let trackingServer: ReturnType<typeof Bun.serve> | undefined
let trackingCalls = 0
const trackingPath = join(directory, 'tracking.json')
const trackingCanary = 'private-tracking-canary'
const trackingRunId = 'b'.repeat(32)
let revision: string | undefined
if (tracked) {
  const repositoryRoot = join(directory, 'synthetic-dvc')
  await mkdir(repositoryRoot)
  const gitEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  )
  function git(args: string[]) {
    const result = Bun.spawnSync(['git', '-C', repositoryRoot, ...args], {
      env: gitEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) throw new Error('Synthetic DVC fixture setup failed')
    return result.stdout.toString().trim()
  }
  git(['init', '--quiet'])
  await writeFile(
    join(repositoryRoot, 'dvc.lock'),
    `schema: '2.0'\nstages: {}\n# ${trackingCanary}\n`,
  )
  git(['add', '--', 'dvc.lock'])
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'synthetic lock',
  ])
  revision = git(['rev-parse', 'HEAD'])
  trackingServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      trackingCalls++
      assert(
        new URL(request.url).searchParams.get('run_id') === trackingRunId,
        'Wrong tracking run',
      )
      assert(
        request.headers.get('authorization') === 'Bearer fixture-only',
        'Missing fixture authorization',
      )
      return Response.json({
        run: {
          info: { run_id: trackingRunId, status: 'FINISHED', artifact_uri: trackingCanary },
          data: {
            metrics: [{ key: 'auroc', value: 0.8 }],
            params: [],
            tags: [{ key: 'private', value: trackingCanary }],
          },
        },
      })
    },
  })
  tracking = {
    schema: 'runner-tracking-config-v1',
    dataClass: 'synthetic',
    mlflow: [
      {
        referenceId: crypto.randomUUID(),
        baseUrl: trackingServer.url.href,
        runId: trackingRunId,
        authorization: 'Bearer fixture-only',
        metrics: { auroc: { min: 0, max: 1 } },
        numericParams: {},
      },
    ],
    dvc: [{ referenceId: crypto.randomUUID(), repositoryRoot, revision }],
  }
  await writeFile(trackingPath, JSON.stringify(tracking))
}

if (source) {
  executable = join(directory, process.platform === 'win32' ? 'oph.exe' : 'oph')
  await copyFile(source, executable)
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = probe.port!
  probe.stop(true)
  base = `http://127.0.0.1:${port}`
  const spawned = Bun.spawn(
    [
      executable,
      'serve',
      '--cwd',
      workspace,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      ...(daemon ? ['--research-daemon-root', daemonRoot] : []),
      ...(tracked ? ['--research-tracking', trackingPath] : []),
    ],
    {
      cwd: directory,
      env: { ...process.env, OPH_AUTORESEARCH_HOME: home, OPH_AUTORESEARCH_TOKEN: token },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  child = spawned
  stdout = new Response(spawned.stdout).text()
  stderr = new Response(spawned.stderr).text()
} else {
  store = new Store({ path: join(directory, 'ledger.sqlite') })
  app = serve({
    store,
    config: { active: { provider: 'unused', model: 'unused' }, providers: {}, mode: 'auto' },
    workspaceRoot: workspace,
    host: '127.0.0.1',
    port: 0,
    token,
    ...(daemon
      ? {
          researchDaemon: {
            dbPath: join(daemonRoot, 'jobs.sqlite'),
            outputRoot: join(daemonRoot, 'outputs'),
            ...(tracking ? { tracking } : {}),
          },
        }
      : {}),
  })
  base = `http://127.0.0.1:${app.port}`
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
async function response(path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  })
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  const result = await response(path, body)
  assert(result.ok, `${path}: ${result.status} ${await result.clone().text()}`)
  return result.json() as Promise<T>
}
try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      await response('/api/health')
        .then((result) => result.ok)
        .catch(() => false)
    ) {
      ready = true
      break
    }
    if (child?.exitCode !== null && child?.exitCode !== undefined) break
    await Bun.sleep(50)
  }
  assert(ready, 'Evaluation HTTP server did not become ready')
  const { conversation } = await request<{ conversation: { id: string } }>('/api/conversations', {
    title: 'Isolated fixed evaluation proof',
  })
  const { campaign: created } = await request<{ campaign: ResearchCampaign }>(
    '/api/research/campaigns',
    {
      parentConversationId: conversation.id,
      goal: 'Evaluate bundled non-patient synthetic scores',
      idempotencyKey: 'evaluation-create',
    },
  )
  const path = `/api/research/campaigns/${created.id}`
  const dispatch = {
    templateId: retinal
      ? 'synthetic-retinal-image-v1'
      : training
        ? 'synthetic-training-evaluation-v1'
        : 'synthetic-evaluation-v1',
    expectedVersion: created.version,
    dispatchKey: 'evaluation-dispatch',
  }
  type Completed = { campaign: ResearchCampaign; attemptId: string; replayed: boolean }
  const completed = await request<Completed>(`${path}/synthetic`, dispatch)
  const replay = await request<Completed>(`${path}/synthetic`, dispatch)
  assert(replay.replayed && replay.campaign.attempts.length === 1, 'Replay created another Attempt')
  const attempt = completed.campaign.attempts.find((row) => row.id === completed.attemptId)
  assert(attempt?.status === 'completed', 'Evaluation did not complete')
  if (daemon)
    assert(
      attempt.backend === 'localhost-daemon' &&
        attempt.jobSpec?.dispatchKey === attempt.id &&
        attempt.jobSpecHash,
      'Daemon did not consume the same persisted Attempt/JobSpec',
    )
  const artifact = completed.campaign.artifactVersions.find(
    (row) => row.id === attempt.artifactVersionId,
  )
  assert(artifact?.schemaId === dispatch.templateId, 'Artifact schema was not bound')
  assert(
    artifact.mediaType === 'application/json' && artifact.dataClass === 'synthetic',
    'Artifact metadata differs',
  )
  assert(
    artifact.producerAttemptId === attempt.id && artifact.validation,
    'Artifact producer or verification missing',
  )
  const receiptPath = `${path}/synthetic/receipt?attemptId=${encodeURIComponent(attempt.id)}`
  const receipt = await request<{ contentHash: string; humanApproval: boolean }>(receiptPath)
  const output = fileURLToPath(artifact.uri)
  const bytes = await readFile(output)
  const hash = `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`
  assert(
    hash === artifact.contentHash && hash === receipt.contentHash,
    'Actual bytes differ from recorded hash',
  )
  assert(receipt.humanApproval === false, 'Machine evaluation was mislabeled as human approval')
  const evidence = JSON.parse(bytes.toString('utf8'))
  if (tracked) {
    assert(trackingCalls === 1, 'Tracking collection repeated')
    assert(
      evidence.tracking.policyHash === attempt.trackingPolicyHash &&
        attempt.jobSpec?.trackingPolicyHash === attempt.trackingPolicyHash,
      'Tracking did not bind the persisted Attempt',
    )
    assert(
      evidence.tracking.workerPid !== (child?.pid ?? process.pid),
      'Tracking ran in controller',
    )
    assert(
      evidence.tracking.sources[0].metrics.auroc === 0.8 &&
        evidence.tracking.sources[1].revision === revision,
      'Actual MLflow/DVC source results missing',
    )
    for (const secret of [
      trackingCanary,
      trackingRunId,
      'Bearer fixture-only',
      tracking!.dvc[0]!.repositoryRoot,
    ])
      assert(!bytes.includes(secret), 'Private tracking data crossed output boundary')
  }
  // These expectations are hand-derived from the frozen fixture, not imported from the evaluator.
  assert(
    // Retinal validation image has 64 pixels at 172; train means are 58 and 198,
    // centered at 128. Fixed logistic of (172-128)/32 gives the threshold.
    Math.abs(evidence.report.threshold.value - (retinal ? 1 / (1 + Math.exp(-44 / 32)) : 0.8)) <
      1e-12,
    'Validation threshold differs from the fixture',
  )
  assert(evidence.report.metrics.auroc.value === 1, 'Pairwise test ranking differs')
  assert(
    evidence.report.metrics.sensitivity.value === 0.75,
    'Expected 3/4 positive observations detected',
  )
  assert(
    evidence.report.metrics.specificity.value === 1,
    'Expected 3/3 negative observations detected',
  )
  assert(evidence.report.metrics.accuracy.value === 6 / 7, 'Expected 6/7 observations correct')
  assert(evidence.report.bootstrap.unit === 'patient', 'Bootstrap unit differs')
  assert(evidence.report.groupCounts.test.patients === 4, 'Expected four test patient clusters')
  assert(!bytes.includes('patientId'), 'Aggregate artifact includes observation identities')
  let preprocessingTamperStatus: number | null = null
  if (training || retinal) {
    const preprocessing = evidence.preprocessing
    assert(
      preprocessing.fitSplit === 'train' && preprocessing.trainingObservations === 2,
      'Training-only fit metadata missing',
    )
    assert(preprocessing.algorithm === 'subtract_training_mean', 'Wrong fitted transformation')
    assert(
      Math.abs(preprocessing.parameters.mean) < 1e-12,
      'Two symmetric training features must fit mean zero',
    )
    const parametersHash = `sha256:${new Bun.CryptoHasher('sha256').update(JSON.stringify(preprocessing.parameters)).digest('hex')}`
    assert(
      parametersHash === preprocessing.parametersHash,
      'Fitted parameter hash differs from actual parameters',
    )
    const altered = structuredClone(evidence)
    altered.preprocessing.parameters.mean = 1
    await writeFile(output, `${JSON.stringify(altered)}\n`)
    preprocessingTamperStatus = (await response(receiptPath)).status
    assert(preprocessingTamperStatus === 409, 'Tampered fitted parameters were not rejected')
    await writeFile(output, bytes)
  }
  let featureTamperStatus: number | null = null
  if (retinal) {
    assert(
      evidence.featureExtraction.width === 8 &&
        evidence.featureExtraction.height === 8 &&
        evidence.featureExtraction.images === 11 &&
        evidence.featureExtraction.modality === 'synthetic-fundus' &&
        evidence.featureExtraction.protocol === 'mean_grayscale_brightness_normalized',
      'Actual synthetic image extraction is missing',
    )
    assert(!bytes.includes('pixels') && !bytes.includes('subjectId'), 'Raw image data in aggregate')
    const altered = structuredClone(evidence)
    altered.featureExtraction.featureHash = `sha256:${'0'.repeat(64)}`
    await writeFile(output, `${JSON.stringify(altered)}\n`)
    featureTamperStatus = (await response(receiptPath)).status
    assert(featureTamperStatus === 409, 'Tampered image feature receipt was not rejected')
    await writeFile(output, bytes)
  }

  const tampered = structuredClone(evidence)
  tampered.report.metrics.auroc.value = 0.5
  await writeFile(output, `${JSON.stringify(tampered)}\n`)
  const tamperResponse = await response(receiptPath)
  assert(tamperResponse.status === 409, 'Tampered report was not rejected')
  await writeFile(output, bytes)
  await request(receiptPath)
  const { campaign: current } = await request<{ campaign: ResearchCampaign }>(path)
  await request(`${path}/proposals`, {
    expectedVersion: current.version,
    idempotencyKey: 'invalidate-evaluation',
    command: { kind: 'setPolicy', policy: { revision: 'changed-after-evaluation' } },
  })
  const staleResponse = await response(receiptPath)
  assert(staleResponse.status === 409, 'Stale evaluation was not rejected')
  const result = {
    ok: true,
    mode: source ? 'compiled' : 'source',
    templateId: dispatch.templateId,
    executable: executable ?? null,
    sourceTreeRequiredByServer: !source,
    campaignId: created.id,
    attemptId: attempt.id,
    backend: attempt.backend ?? 'builtin-local',
    jobSpecHash: attempt.jobSpecHash ?? null,
    tracking: evidence.tracking ?? null,
    trackingCalls,
    artifactVersionId: artifact.id,
    byteLength: bytes.length,
    contentHash: hash,
    threshold: evidence.report.threshold,
    metrics: evidence.report.metrics,
    preprocessing: evidence.preprocessing ?? null,
    preprocessingTamperStatus,
    featureExtraction: evidence.featureExtraction ?? null,
    featureTamperStatus,
    replayed: true,
    tamperedReceiptStatus: tamperResponse.status,
    staleReceiptStatus: staleResponse.status,
    humanApproval: false,
  }
  await writeFile(join(directory, 'receipt.json'), `${JSON.stringify(result, null, 2)}\n`, {
    flag: 'wx',
  })
  process.stdout.write(
    `${JSON.stringify({ ...result, receiptPath: join(directory, 'receipt.json') })}\n`,
  )
} finally {
  trackingServer?.stop(true)
  app?.stop()
  store?.close()
  if (child) {
    child.kill()
    await child.exited
    await writeFile(join(directory, 'stdout.log'), await stdout!)
    await writeFile(join(directory, 'stderr.log'), await stderr!)
  }
}
