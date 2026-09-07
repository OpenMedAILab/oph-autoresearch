import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResearchCampaign, ResearchEvent } from '@oph-autoresearch/core'
import { Store } from '@oph-autoresearch/store'
import { serve } from '../packages/server/src/server.ts'

// Never loads the user's database, SSH settings or global extensions.
const root = join(import.meta.dir, '..', '.tmp', 'research-smoke')
await mkdir(root, { recursive: true })
const directory = await mkdtemp(join(root, 'run-'))
const home = join(directory, 'home')
const workspace = join(directory, 'workspace')
await mkdir(home)
await mkdir(workspace)
process.env.OPH_AUTORESEARCH_HOME = home
const databasePath = join(directory, 'ledger.sqlite')
const store = new Store({ path: databasePath })
const app = serve({
  store,
  config: { active: { provider: 'unused', model: 'unused' }, providers: {}, mode: 'auto' },
  workspaceRoot: workspace,
  host: '127.0.0.1',
  port: 0,
  token: crypto.randomUUID(),
})
const base = `http://127.0.0.1:${app.port}`

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  })
  assert(response.ok, `${path}: ${response.status} ${await response.clone().text()}`)
  return response.json() as Promise<T>
}

try {
  const unauthenticated = await fetch(`${base}/api/research/campaigns`)
  assert(unauthenticated.status === 401, 'HTTP authentication must reject unauthenticated access')
  const { conversation } = await request<{ conversation: { id: string } }>('/api/conversations', {
    title: 'Synthetic HTTP smoke',
  })
  const created = await request<{ campaign: ResearchCampaign }>('/api/research/campaigns', {
    parentConversationId: conversation.id,
    goal: 'Built-in synthetic HTTP smoke',
    idempotencyKey: 'create-smoke',
  })
  const path = `/api/research/campaigns/${created.campaign.id}`
  const dispatch = {
    expectedVersion: created.campaign.version,
    dispatchKey: 'fixed-smoke-dispatch',
  }
  const completed = await request<{ campaign: ResearchCampaign; replayed: boolean }>(
    `${path}/synthetic`,
    dispatch,
  )
  assert(completed.campaign.attempts.length === 1, 'one dispatch must produce exactly one Attempt')
  assert(completed.campaign.attempts[0]?.status === 'completed', 'Attempt must complete')
  assert(
    completed.campaign.taskRevisions[0]?.status === 'verified',
    'Task must be independently validated',
  )
  const replay = await request<{ campaign: ResearchCampaign; replayed: boolean }>(
    `${path}/synthetic`,
    dispatch,
  )
  assert(
    replay.replayed && replay.campaign.attempts.length === 1,
    'duplicate dispatch must reuse its Attempt',
  )
  const artifact = completed.campaign.artifactVersions[0]
  assert(artifact, 'verified artifact must exist')
  const bytes = await readFile(fileURLToPath(artifact.uri))
  const hasher = new Bun.CryptoHasher('sha256')
  const hash = `sha256:${hasher.update(bytes).digest('hex')}`
  assert(hash === artifact.contentHash, 'HTTP artifact hash must match actual file bytes')
  const { events } = await request<{ events: ResearchEvent[] }>(`${path}/events`)
  const { campaign } = await request<{ campaign: ResearchCampaign }>(path)
  assert(
    events.at(-1)?.sequence === campaign.version,
    'HTTP event sequence must equal snapshot version',
  )
  const pending = store.db
    .query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM research_outbox WHERE delivered_at IS NULL',
    )
    .get()
  assert(pending?.count === 0, 'committed outbox must be delivered')
  app.stop()
  store.close()
  const reopened = new Store({ path: databasePath })
  assert(
    reopened.db.query('SELECT id FROM research_events WHERE campaign_id = ?').all(campaign.id)
      .length === events.length,
    'events survive physical database reopen',
  )
  reopened.close()
  const receiptPath = join(directory, 'receipt.json')
  const receipt = {
    ok: true,
    directory,
    receiptPath,
    campaignId: campaign.id,
    attemptId: campaign.attempts[0]?.id,
    campaignSeq: campaign.version,
    artifactHash: hash,
    artifactUri: artifact.uri,
    byteLength: bytes.length,
    replayed: replay.replayed,
  }
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
} catch (error) {
  app.stop()
  store.close()
  throw error
}
