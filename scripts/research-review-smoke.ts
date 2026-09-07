/** Real HTTP + local SSE + test-signature proof, also against an isolated compiled CLI. */
import { generateKeyPairSync, sign } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ResearchCampaign } from '@oph-autoresearch/core'
import type { OphConfig } from '@oph-autoresearch/runtime'
import { Store } from '@oph-autoresearch/store'
import { canonicalJson, sha256 } from '../packages/server/src/research/skill-lock.ts'
import { SYNTHETIC_SKILL_BINDING } from '../packages/server/src/research/synthetic-skill.ts'
import { serve } from '../packages/server/src/server.ts'

const root = resolve('.tmp/research-review-smoke')
await mkdir(root, { recursive: true })
const directory = await mkdtemp(join(root, 'run-'))
const workspace = join(directory, 'workspace')
const home = join(directory, 'home')
await mkdir(workspace)
await mkdir(home)
process.env.OPH_AUTORESEARCH_HOME = home
const canary = `private-context-${crypto.randomUUID()}`
await writeFile(join(workspace, 'clinical.txt'), canary)
const token = crypto.randomUUID()
const pair = generateKeyPairSync('ed25519')
const auth = {
  issuers: {
    fixture: {
      publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      reviewerIds: ['test-reviewer'],
    },
  },
}
const authPath = join(directory, 'public-auth.json')
await writeFile(authPath, JSON.stringify(auth))
const requests: string[] = []
let evidenceId = ''
let reportUsage = true
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    requests.push(await request.text())
    const text = JSON.stringify({
      decision: 'supported',
      claims: [
        {
          claim: 'The fixed aggregate has eight observations.',
          artifactVersionIds: [evidenceId],
        },
      ],
      limitations: ['Synthetic fixture only; no clinical inference.'],
    })
    const events = [
      { type: 'response.created', response: { id: `review-${requests.length}` } },
      { type: 'response.output_text.delta', delta: text },
      {
        type: 'response.completed',
        response: {
          id: `review-${requests.length}`,
          status: 'completed',
          ...(reportUsage ? { usage: { input_tokens: 31, output_tokens: 7 } } : {}),
        },
      },
    ]
    return new Response(
      `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join('\n')}\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )
  },
})
const config: OphConfig = {
  active: { provider: 'local-test-provider', model: 'gpt-5.6-terra' },
  mode: 'auto',
  providers: {
    'local-test-provider': {
      kind: 'openai_responses',
      apiKey: 'local-test-key',
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      models: { 'gpt-5.6-terra': {} },
    },
  },
}
await writeFile(join(home, 'config.json'), JSON.stringify(config))
const args = process.argv.slice(2)
const literature = args.includes('--literature')
const cli = args.includes('--cli')
const executableArgs = args.filter((arg) => arg !== '--literature' && arg !== '--cli')
if (executableArgs.length > 1 || executableArgs.some((arg) => arg.startsWith('--')))
  throw new Error('Usage: research-review-smoke.ts [--literature] [--cli] [compiled-cli-path]')
const source = executableArgs[0] ? resolve(executableArgs[0]) : null
let app: ReturnType<typeof serve> | undefined
let store: Store | undefined
let child: ReturnType<typeof Bun.spawn> | undefined
let stdout: Promise<string> | undefined
let stderr: Promise<string> | undefined
let base: string
let workspaceId: string | undefined
let executable: string | null = null
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
      '--research-human-auth',
      authPath,
      ...(cli ? ['--research-review-cli'] : []),
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
    config,
    workspaceRoot: workspace,
    host: '127.0.0.1',
    port: 0,
    token,
    researchHumanAuth: auth,
    ...(cli ? { researchReviewCli: {} } : {}),
  })
  base = `http://127.0.0.1:${app.port}`
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
async function response(path: string, body?: unknown, proof?: string) {
  const url = new URL(path, base)
  if (workspaceId) url.searchParams.set('ws', workspaceId)
  return fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(proof ? { 'x-oph-human-proof': proof } : {}),
    },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  })
}
async function request<T>(path: string, body?: unknown, proof?: string): Promise<T> {
  const result = await response(path, body, proof)
  assert(result.ok, `${path}: ${result.status} ${await result.clone().text()}`)
  return result.json() as Promise<T>
}
function proof(campaign: ResearchCampaign, body: unknown) {
  const claims = {
    issuer: 'fixture',
    reviewerId: 'test-reviewer',
    proofId: crypto.randomUUID(),
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    workspaceId: campaign.workspaceId,
    campaignId: campaign.id,
    action: 'approve',
    bodyHash: sha256(canonicalJson(body)),
  }
  const payload = Buffer.from(canonicalJson(claims)).toString('base64url')
  return `v1.${payload}.${sign(null, Buffer.from(payload), pair.privateKey).toString('base64url')}`
}
try {
  let ready = false
  for (let n = 0; n < 100; n++) {
    if (
      await response('/api/health')
        .then((r) => r.ok)
        .catch(() => false)
    ) {
      ready = true
      break
    }
    await Bun.sleep(50)
  }
  assert(ready, 'Isolated server did not become ready')
  const { conversation } = await request<{ conversation: { id: string } }>('/api/conversations', {
    title: canary,
  })
  let { campaign } = await request<{ campaign: ResearchCampaign }>('/api/research/campaigns', {
    parentConversationId: conversation.id,
    goal: canary,
    idempotencyKey: 'review-campaign',
  })
  const path = `/api/research/campaigns/${campaign.id}`
  workspaceId = campaign.workspaceId
  const mutate = async (key: string, command: unknown) => {
    ;({ campaign } = await request<{ campaign: ResearchCampaign }>(`${path}/proposals`, {
      expectedVersion: campaign.version,
      idempotencyKey: key,
      command,
    }))
  }
  await mutate('review-budget', { kind: 'setBudget', budget: { currency: 'USD', limit: 100 } })
  if (literature) {
    const imported = await request<{ campaign: ResearchCampaign }>(`${path}/literature`, {
      doi: '10.1038/s41591-018-0107-6',
      expectedVersion: campaign.version,
      idempotencyKey: 'public-literature',
    })
    campaign = imported.campaign
    assert(
      campaign.literatureCitations?.length === 1 &&
        campaign.literatureCitations[0]?.fullText === false,
      'Verified public metadata was not persisted as a citation',
    )
  }
  await mutate('declare-summary', {
    kind: 'declareSyntheticTask',
    taskId: 'summary',
    artifactVersionIds: [],
    inputHash: 'sha256:43e5f2a62bb17464cf45a9f8f0f00ed73922843690f24262fa3ae031ef4b1e49',
    skillBinding: SYNTHETIC_SKILL_BINDING,
  })
  const taskId = campaign.taskRevisions[0]!.id
  async function approve(key: string, scope: unknown) {
    const body = {
      expectedVersion: campaign.version,
      idempotencyKey: key,
      bundleHash: campaign.bundleHash,
      scope,
    }
    assert((await response(`${path}/approve`, body)).status === 403, 'Bearer alone approved work')
    const header = proof(campaign, body)
    const first = await request<{ campaign: ResearchCampaign }>(`${path}/approve`, body, header)
    const replay = await request<{ campaign: ResearchCampaign }>(`${path}/approve`, body, header)
    assert(first.campaign.version === replay.campaign.version, 'Approval retry changed the ledger')
    campaign = first.campaign
    return campaign.approvals.at(-1)!.id
  }
  const executionApproval = await approve('approve-summary', {
    kind: 'execution',
    taskRevisionId: taskId,
    dispatchKey: 'summary',
    artifactVersionIds: [],
    currency: 'USD',
    maxCost: 0,
    expiresAt: Date.now() + 60_000,
  })
  const completed = await request<{ campaign: ResearchCampaign; attemptId: string }>(
    `${path}/synthetic`,
    {
      expectedVersion: campaign.version,
      dispatchKey: 'summary',
      taskRevisionId: taskId,
      approvalId: executionApproval,
    },
  )
  campaign = completed.campaign
  evidenceId = campaign.artifactVersions[0]!.id
  const reviews = []
  for (const [index, knownUsage] of [true, false].entries()) {
    reportUsage = knownUsage
    const { quote } = await request<{
      quote: {
        configHash: string
        evidencePackHash: string
        artifactVersionIds: string[]
        reservedCost: number
        currency: string
        maxRequests: number
        maxOutputTokens: number
      }
    }>(`${path}/review/quote`, { attemptIds: [completed.attemptId] })
    assert(
      quote.reservedCost > 0 && quote.maxRequests === 2 && quote.maxOutputTokens === 1024,
      'No bounded quote',
    )
    const dispatchKey = `review-${index}`
    const approvalId = await approve(`approve-${dispatchKey}`, {
      kind: 'model_review',
      dispatchKey,
      configHash: quote.configHash,
      evidencePackHash: quote.evidencePackHash,
      artifactVersionIds: quote.artifactVersionIds,
      currency: quote.currency,
      maxCost: quote.reservedCost,
      maxRequests: quote.maxRequests,
      maxOutputTokens: quote.maxOutputTokens,
      expiresAt: Date.now() + 60_000,
    })
    const body = {
      attemptIds: [completed.attemptId],
      expectedVersion: campaign.version,
      dispatchKey,
      approvalId,
    }
    const result = await request<{
      replayed: boolean
      review: {
        id: string
        status: string
        requestCount: number
        actualCost: number | null
        reservedCost: number
        text: string
      }
    }>(`${path}/review`, body)
    assert(
      result.review.status === 'done',
      `Model review did not complete: ${JSON.stringify(result)}`,
    )
    assert(result.review.requestCount === 1, 'Single response did not consume exactly one request')
    assert(
      knownUsage
        ? result.review.actualCost !== null && result.review.actualCost > 0
        : result.review.actualCost === null,
      'Unknown usage was misaccounted',
    )
    assert(result.review.reservedCost === quote.reservedCost, 'Reservation was silently released')
    const beforeReplay = requests.length
    const replay = await request<typeof result>(`${path}/review`, body)
    assert(
      replay.replayed && replay.review.id === result.review.id && requests.length === beforeReplay,
      'Review retry resent a request',
    )
    ;({ campaign } = await request<{ campaign: ResearchCampaign }>(path))
    assert(
      campaign.modelReviews?.find((row) => row.id === result.review.id)?.reservedCost ===
        quote.reservedCost,
      'Reservation was not durable',
    )
    reviews.push(result.review)
  }
  assert(
    requests.length === 2 && requests.every((body) => !body.includes(canary)),
    'Private campaign context escaped',
  )
  for (const body of requests)
    assert(JSON.parse(body).max_output_tokens === 1024, 'Wire output bound not enforced')
  const workspaces = await request<{ workspaces: Array<{ id: string }> }>('/api/workspaces')
  assert(
    workspaces.workspaces.length === 1 && workspaces.workspaces[0]?.id === workspaceId,
    'Evidence scratch was registered as a user workspace',
  )
  const previousWorkspaceId = workspaceId
  workspaceId = undefined
  const defaultCampaign = await request<{ campaign: ResearchCampaign }>(path)
  assert(
    defaultCampaign.campaign.id === campaign.id,
    'Evidence review changed the default workspace',
  )
  workspaceId = previousWorkspaceId
  if (literature)
    assert(
      requests.every(
        (body) =>
          body.includes('10.1038/s41591-018-0107-6') &&
          body.includes('Clinically applicable deep learning'),
      ),
      'Persisted public citation was not consumed by the actual evidence Session',
    )
  const receipt = {
    ok: true,
    mode: source ? 'compiled' : 'source',
    executable,
    provider: 'local SSE fixture; no paid model calls',
    identity: 'ephemeral test signer; no real human approval',
    campaignId: campaign.id,
    reviews,
    providerRequests: requests.length,
    privateContextAbsent: true,
    scratchWorkspaceAbsent: true,
    maxOutputTokensOnWire: 1024,
    literatureCitations: campaign.literatureCitations ?? [],
  }
  const receiptPath = join(directory, 'receipt.json')
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath })}\n`)
} finally {
  app?.stop()
  store?.close()
  if (child) {
    child.kill()
    await child.exited
    await writeFile(join(directory, 'stdout.log'), await stdout!)
    await writeFile(join(directory, 'stderr.log'), await stderr!)
  }
  provider.stop(true)
}
