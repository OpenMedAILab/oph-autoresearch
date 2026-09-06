import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DurableJob, JobSpec } from './job-daemon.ts'
import {
  createSshDaemonClient,
  createSshDaemonClientForTest,
  type SshDaemonConfig,
} from './ssh-daemon-client.ts'
import { fixedResearchTemplate } from './template-registry.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}

function hashBytes(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function job(
  spec: JobSpec,
  status: DurableJob['status'] = 'queued',
  bytes?: Uint8Array,
): DurableJob {
  return {
    spec,
    specHash: hash(spec),
    status,
    outputPath: status === 'completed' ? '/remote/receipt.json' : null,
    contentHash: bytes ? hashBytes(bytes) : null,
    error: null,
  }
}

async function freshConfig(): Promise<SshDaemonConfig> {
  const root = await mkdtemp(join(tmpdir(), 'oph-ssh-daemon-client-'))
  roots.push(root)
  const identityFile = join(root, 'identity')
  const knownHostsFile = join(root, 'known_hosts')
  await writeFile(identityFile, 'test private key placeholder\n')
  await writeFile(knownHostsFile, 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest\n')
  return {
    host: 'example.test',
    user: 'daemon_user',
    port: 22,
    identityFile,
    knownHostsFile,
    knownHostsHash: hashBytes(await Bun.file(knownHostsFile).bytes()),
    remotePort: 12_345,
    token: 'transport-token-without-secrets',
    authorityId: 'remote-authority-1',
  }
}

function spec(key = 'remote-job'): JobSpec {
  const templateId = 'synthetic-summary-v1'
  return {
    version: 1,
    dispatchKey: key,
    campaignId: 'campaign-1',
    taskRevisionId: 'task-1',
    templateId,
    inputHash: fixedResearchTemplate(templateId).execute().inputHash,
    resource: { cpu: 1, memoryMb: 128 },
    lease: { ownerId: 'remote', token: 'lease-1', fence: 1, expiresAt: Date.now() + 60_000 },
  }
}

describe('SSH daemon client', () => {
  test('concurrent callers cannot send before the shared authority identity check finishes', async () => {
    const config = await freshConfig()
    let sent = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === '/health') {
          await Bun.sleep(20)
          return Response.json({ authorityId: 'wrong', trackingPolicyHash: null })
        }
        sent++
        return Response.json({ authorityId: config.authorityId, job: null })
      },
    })
    const client = createSshDaemonClientForTest(config, async () => ({
      endpoint: `http://127.0.0.1:${server.port}`,
      close() {},
    }))
    try {
      const results = await Promise.allSettled([
        client.submit(spec('first')),
        client.submit(spec('second')),
      ])
      expect(results.every((result) => result.status === 'rejected')).toBe(true)
      expect(sent).toBe(0)
    } finally {
      client.close()
      server.stop(true)
    }
  })
  test('uses an authenticated loopback transport and pins the authority, job binding, and receipt bytes', async () => {
    const config = await freshConfig()
    const submitted = spec()
    const receipt = new TextEncoder().encode('{"result":"verified"}\n')
    const completed = job(submitted, 'completed', receipt)
    const requests: { path: string; authorization: string | null }[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        requests.push({ path: url.pathname, authorization: request.headers.get('authorization') })
        if (request.headers.get('authorization') !== `Bearer ${config.token}`)
          return new Response('unauthorized', { status: 401 })
        if (url.pathname === '/health')
          return Response.json({ authorityId: config.authorityId, trackingPolicyHash: null })
        if (url.pathname === '/submit')
          return Response.json({ authorityId: config.authorityId, job: job(submitted) })
        if (url.pathname === `/status/${submitted.dispatchKey}`)
          return Response.json({ authorityId: config.authorityId, job: completed })
        if (url.pathname === `/cancel/${submitted.dispatchKey}`)
          return Response.json({ authorityId: config.authorityId, job: completed })
        if (url.pathname === `/receipt/${submitted.dispatchKey}`)
          return new Response(receipt, {
            headers: {
              'content-type': 'application/octet-stream',
              'x-oph-authority-id': config.authorityId,
            },
          })
        return new Response('not found', { status: 404 })
      },
    })
    let closed = false
    const client = createSshDaemonClientForTest(config, async () => ({
      endpoint: `http://127.0.0.1:${server.port}`,
      close: () => {
        closed = true
        server.stop(true)
      },
    }))
    try {
      expect((await client.submit(submitted)).specHash).toBe(hash(submitted))
      expect((await client.query(submitted.dispatchKey))?.status).toBe('completed')
      expect(await client.receipt(submitted.dispatchKey)).toEqual(receipt)
      expect(await client.cancel(submitted.dispatchKey)).toMatchObject({ status: 'completed' })
      expect(requests.map((request) => request.path)).toEqual([
        '/health',
        '/submit',
        '/status/remote-job',
        '/status/remote-job',
        '/receipt/remote-job',
        '/cancel/remote-job',
      ])
      expect(requests.every((request) => request.authorization === `Bearer ${config.token}`)).toBe(
        true,
      )
      expect(client.hasAvailableSlot()).toBe(false)
      expect(() => client.launchWorker()).toThrow('remote authority')
      expect(await client.reconcileInterrupted()).toEqual([])
    } finally {
      client.close()
      if (!closed) server.stop(true)
    }
    expect(closed).toBe(true)
  })

  test('binds v3 submit, query, and cancel to the expected daemon epoch', async () => {
    const config = await freshConfig()
    const epoch = 'e'.repeat(32)
    const submitted = { ...spec('epoch-bound'), version: 3 } as unknown as JobSpec
    const requests: unknown[] = []
    const headers = { 'x-oph-authority-epoch': epoch }
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/health')
          return Response.json({ authorityId: config.authorityId, trackingPolicyHash: null })
        if (path === '/submit' || path === `/cancel/${submitted.dispatchKey}`) {
          requests.push(await request.json())
          return Response.json(
            { authorityId: config.authorityId, job: job(submitted) },
            { headers },
          )
        }
        if (path === `/status/${submitted.dispatchKey}`)
          return Response.json(
            { authorityId: config.authorityId, job: job(submitted) },
            { headers },
          )
        return new Response('not found', { status: 404 })
      },
    })
    const client = createSshDaemonClientForTest(config, async () => ({
      endpoint: `http://127.0.0.1:${server.port}`,
      close: () => server.stop(true),
    }))
    try {
      await expect(client.submit(submitted)).rejects.toThrow('requires an authority epoch')
      await client.submit(submitted, epoch)
      await client.query(submitted.dispatchKey, epoch)
      await client.cancel(submitted.dispatchKey, epoch)
      expect(requests).toEqual([
        { expectedEpoch: epoch, spec: submitted },
        { expectedEpoch: epoch },
      ])
    } finally {
      client.close()
    }
  })

  test('validates authority headers and exact identity and closure proof bindings', async () => {
    const config = await freshConfig()
    const epoch = 'e'.repeat(32)
    const request = {
      expectedEpoch: epoch,
      dispatchKey: 'closure-key',
      specHash: `sha256:${'c'.repeat(64)}`,
    }
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(httpRequest) {
        const path = new URL(httpRequest.url).pathname
        if (path === '/health')
          return Response.json({ authorityId: config.authorityId, trackingPolicyHash: null })
        if (path === '/identity')
          return Response.json(
            { authorityId: config.authorityId, identity: { schema: 'wrong', epoch } },
            { headers: { 'x-oph-authority-id': config.authorityId } },
          )
        if (path === '/close-unstarted')
          return Response.json(
            {
              authorityId: config.authorityId,
              proof: {
                schema: 'research-authority-closure-v1',
                ...request,
                specHash: `sha256:${'d'.repeat(64)}`,
                outcome: 'not_started',
                recordedAt: 1,
              },
            },
            { headers: { 'x-oph-authority-id': config.authorityId } },
          )
        return new Response('not found', { status: 404 })
      },
    })
    const client = createSshDaemonClientForTest(config, async () => ({
      endpoint: `http://127.0.0.1:${server.port}`,
      close: () => server.stop(true),
    }))
    try {
      await expect(client.identity()).rejects.toThrow('identity does not match')
      await expect(client.closeUnstarted(request)).rejects.toThrow('closure proof does not match')
    } finally {
      client.close()
    }
  })

  test('rejects a mismatched authority and does not retry a failed submission', async () => {
    const config = await freshConfig()
    const submitted = spec('failed-submit')
    let submitCount = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/health')
          return Response.json({ authorityId: config.authorityId, trackingPolicyHash: null })
        if (path === '/submit') {
          submitCount++
          return Response.json({ authorityId: 'other-authority', job: job(submitted) })
        }
        return new Response('not found', { status: 404 })
      },
    })
    const client = createSshDaemonClientForTest(config, async () => ({
      endpoint: `http://127.0.0.1:${server.port}`,
      close: () => server.stop(true),
    }))
    try {
      await expect(client.submit(submitted)).rejects.toThrow('identity does not match')
      expect(submitCount).toBe(1)
    } finally {
      client.close()
    }
  })

  test('rejects a response whose exact durable job binding differs from the submission', async () => {
    const config = await freshConfig()
    const submitted = spec('bound-submit')
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/health')
          return Response.json({ authorityId: config.authorityId, trackingPolicyHash: null })
        if (path === '/submit')
          return Response.json({ authorityId: config.authorityId, job: job(spec('other-job')) })
        return new Response('not found', { status: 404 })
      },
    })
    const client = createSshDaemonClientForTest(config, async () => ({
      endpoint: `http://127.0.0.1:${server.port}`,
      close: () => server.stop(true),
    }))
    try {
      await expect(client.submit(submitted)).rejects.toThrow('does not match the submitted binding')
    } finally {
      client.close()
    }
  })

  test('requires pinned regular credential files and a matching known-hosts digest before any tunnel starts', async () => {
    const config = await freshConfig()
    expect(createSshDaemonClient(config).backendPolicyHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(() =>
      createSshDaemonClient({ ...config, knownHostsHash: `sha256:${'0'.repeat(64)}` }),
    ).toThrow('invalid SSH daemon configuration')
    expect(() => createSshDaemonClient({ ...config, host: 'remote;command' })).toThrow(
      'invalid SSH daemon configuration',
    )
  })
})
