import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResearchCampaign } from '@oph-autoresearch/core'

const source = resolve(
  process.argv[2] ?? 'apps/desktop/src-tauri/bin/oph-x86_64-pc-windows-msvc.exe',
)
const root = resolve('.tmp/research-compiled-smoke')
await mkdir(root, { recursive: true })
const directory = await mkdtemp(join(root, 'run-'))
const executable = join(directory, process.platform === 'win32' ? 'oph.exe' : 'oph')
await copyFile(source, executable)
const workspace = join(directory, 'workspace')
const home = join(directory, 'home')
await mkdir(workspace)
await mkdir(home)
const token = crypto.randomUUID()
const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
const port = probe.port!
probe.stop(true)
const base = `http://127.0.0.1:${port}`
const child = Bun.spawn(
  [executable, 'serve', '--cwd', workspace, '--host', '127.0.0.1', '--port', String(port)],
  {
    cwd: directory,
    env: { ...process.env, OPH_AUTORESEARCH_HOME: home, OPH_AUTORESEARCH_TOKEN: token },
    stdout: 'pipe',
    stderr: 'pipe',
  },
)
const stdout = new Response(child.stdout).text()
const stderr = new Response(child.stderr).text()
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  })
  assert(response.ok, `${path}: ${response.status} ${await response.clone().text()}`)
  return response.json() as Promise<T>
}
try {
  let ready = false
  for (let tries = 0; tries < 200; tries++) {
    if (
      await fetch(`${base}/api/health`)
        .then((response) => response.ok)
        .catch(() => false)
    ) {
      ready = true
      break
    }
    await new Promise((done) => setTimeout(done, 25))
  }
  assert(ready, 'compiled server failed to start')
  const { conversation } = await request<{ conversation: { id: string } }>('/api/conversations', {
    title: 'Compiled synthetic proof',
  })
  const { campaign: created } = await request<{ campaign: ResearchCampaign }>(
    '/api/research/campaigns',
    {
      parentConversationId: conversation.id,
      goal: 'Compiled fixture proof',
      idempotencyKey: 'create',
    },
  )
  const path = `/api/research/campaigns/${created.id}`
  const dispatch = { expectedVersion: created.version, dispatchKey: 'compiled-dispatch' }
  type Completed = { campaign: ResearchCampaign; attemptId: string; replayed: boolean }
  const completed = await request<Completed>(`${path}/synthetic`, dispatch)
  const replayed = await request<Completed>(`${path}/synthetic`, dispatch)
  assert(
    completed.campaign.attempts[0]?.status === 'completed',
    'compiled fixture did not complete',
  )
  assert(
    replayed.replayed && replayed.campaign.attempts.length === 1,
    'lost-ack replay duplicated execution',
  )
  const attemptId = completed.attemptId
  const receipt = await request<{ contentHash: string; humanApproval: boolean }>(
    `${path}/synthetic/receipt?attemptId=${encodeURIComponent(attemptId)}`,
  )
  const artifact = completed.campaign.artifactVersions[0]
  assert(artifact, 'missing compiled artifact')
  const bytes = await readFile(fileURLToPath(artifact.uri))
  const hash = `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`
  assert(
    receipt.contentHash === hash && receipt.humanApproval === false,
    'compiled receipt not independently bound to bytes',
  )
  const result = {
    ok: true,
    executable,
    workspace,
    sourceTreeRequired: false,
    receipt,
    byteLength: bytes.length,
    replayed: true,
  }
  await writeFile(join(directory, 'receipt.json'), `${JSON.stringify(result, null, 2)}\n`, {
    flag: 'wx',
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  child.kill()
  await child.exited
  await writeFile(join(directory, 'stdout.log'), await stdout)
  await writeFile(join(directory, 'stderr.log'), await stderr)
}
