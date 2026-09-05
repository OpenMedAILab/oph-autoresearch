import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RESTRICTED_RESEARCH_CAPABILITY_DENIED } from '@oph-autoresearch/core'
import { type OphConfig, Session } from '@oph-autoresearch/runtime'
import { Store } from '@oph-autoresearch/store'
import { type ServeOptions, serve } from './server.ts'

test('restricted launch denies actual HTTP/WS and Session before provider, extension or canary persistence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'oph-boundary-'))
  const previousHome = process.env.OPH_AUTORESEARCH_HOME
  process.env.OPH_AUTORESEARCH_HOME = join(directory, 'home')
  const workspace = join(directory, 'workspace')
  mkdirSync(join(workspace, '.agents'), { recursive: true })
  mkdirSync(join(workspace, '.oph'))
  const canary = `clinical-canary-${crypto.randomUUID()}`
  for (const name of ['image.png', 'scan.dcm', 'ocr.txt', 'patients.csv']) {
    writeFileSync(join(workspace, name), canary)
  }
  const marker = join(directory, 'extension-started')
  const script = join(directory, 'probe.mjs')
  writeFileSync(
    script,
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'started')`,
  )
  writeFileSync(
    join(workspace, '.agents', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        canary: { command: process.execPath, args: [script] },
      },
    }),
  )
  writeFileSync(
    join(workspace, '.oph', 'policy.json'),
    JSON.stringify({ mode: 'full', researchBoundary: 'standard' }),
  )
  let providerCalls = 0
  const provider = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      providerCalls++
      return new Response('unexpected', { status: 500 })
    },
  })
  const store = new Store({ path: join(directory, 'ledger.sqlite') })
  const config: OphConfig = {
    active: { provider: 'fake', model: 'fake' },
    mode: 'full',
    providers: {
      fake: {
        kind: 'openai_responses',
        models: { fake: {} },
        apiKey: 'fake',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      },
    },
  }
  const options: ServeOptions = {
    staticDir: workspace,
    store,
    config,
    workspaceRoot: workspace,
    host: '127.0.0.1',
    port: 0,
    researchBoundary: 'restricted-clinical',
    token: crypto.randomUUID(),
  }
  const app = serve(options)
  const base = `http://127.0.0.1:${app.port}`
  const headers = { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }
  try {
    const staticResponse = await fetch(`${base}/patients.csv`)
    expect(staticResponse.status).toBe(403)
    expect(await staticResponse.text()).not.toContain(canary)
    options.researchBoundary = 'standard'
    expect((await fetch(`${base}/api/research/security`)).status).toBe(401)
    expect(await (await fetch(`${base}/api/research/security`, { headers })).json()).toEqual({
      researchBoundary: 'restricted-clinical',
      clinicalBackend: 'unavailable',
      mutableViaApi: false,
    })
    for (const path of [
      '/api/files',
      '/api/ssh/preview',
      '/api/config',
      '/api/conversations',
      '/api/research/campaigns',
      '/api/plugins',
      '/api/mcp',
      '/api/attachments',
      '/api/unknown',
    ]) {
      for (const method of ['GET', 'POST', 'PUT']) {
        const response = await fetch(
          `${base}${path}?path=${encodeURIComponent(join(workspace, 'scan.dcm'))}`,
          {
            headers,
            method,
            ...(method === 'GET'
              ? {}
              : {
                  body: JSON.stringify({
                    prompt: canary,
                    mode: 'full',
                    researchBoundary: 'standard',
                  }),
                }),
          },
        )
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: RESTRICTED_RESEARCH_CAPABILITY_DENIED })
      }
    }
    const socket = await fetch(`${base}/stream`, {
      headers: {
        ...headers,
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })
    expect(socket.status).toBe(403)
    expect(
      () =>
        new Session({
          store,
          config,
          workspaceRoot: workspace,
          signal: new AbortController().signal,
          researchBoundary: 'restricted-clinical',
        }),
    ).toThrow(RESTRICTED_RESEARCH_CAPABILITY_DENIED)
    expect(providerCalls).toBe(0)
    expect(existsSync(marker)).toBe(false)
    for (const table of ['messages', 'research_events', 'provider_requests']) {
      const rows = store.db.query(`SELECT * FROM ${table}`).all()
      expect(rows).toHaveLength(0)
      expect(JSON.stringify(rows)).not.toContain(canary)
    }
  } finally {
    app.stop()
    provider.stop(true)
    store.close()
    if (previousHome === undefined) delete process.env.OPH_AUTORESEARCH_HOME
    else process.env.OPH_AUTORESEARCH_HOME = previousHome
  }
})
