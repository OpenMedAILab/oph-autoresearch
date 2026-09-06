import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '@oph-autoresearch/store'
import { serve } from './server.ts'

test('controller-only startup and HTTP catalogs cannot launch configured extensions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oph-controller-http-'))
  const previousHome = process.env.OPH_AUTORESEARCH_HOME
  process.env.OPH_AUTORESEARCH_HOME = join(root, 'home')
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, '.agents'), { recursive: true })
  const marker = join(root, 'extension-started')
  const script = join(root, 'probe.mjs')
  writeFileSync(
    script,
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'started')`,
  )
  writeFileSync(
    join(workspace, '.agents', 'mcp.json'),
    JSON.stringify({
      mcpServers: { canary: { command: process.execPath, args: [script] } },
    }),
  )
  const store = new Store({ path: ':memory:' })
  const app = serve({
    store,
    workspaceRoot: workspace,
    host: '127.0.0.1',
    port: 0,
    token: crypto.randomUUID(),
    researchControllerOnly: true,
    config: {
      active: { provider: 'fixture', model: 'fixture' },
      mode: 'full',
      providers: { fixture: { kind: 'openai_responses', models: { fixture: {} } } },
    },
  })
  const base = `http://127.0.0.1:${app.port}`
  const headers = { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }
  try {
    const tools = await fetch(`${base}/api/tools`, { headers })
    expect(tools.status).toBe(200)
    const catalog = (await tools.json()) as { tools: { name: string }[] }
    expect(catalog.tools.map((tool) => tool.name)).toEqual(['research_control'])
    for (const path of ['/api/mcp', '/api/mcp/import', '/api/plugins', '/api/plugins/install']) {
      for (const method of ['GET', 'POST']) {
        expect(
          (
            await fetch(`${base}${path}`, {
              method,
              headers,
              ...(method === 'POST' ? { body: '{}' } : {}),
            })
          ).status,
        ).toBe(403)
      }
    }
    const extraPath = `${base}/api/conversations/canary/extras`
    expect(await (await fetch(extraPath, { headers })).json()).toEqual({ extras: [] })
    expect((await fetch(extraPath, { method: 'PUT', headers, body: '{}' })).status).toBe(403)
    expect(existsSync(marker)).toBe(false)
  } finally {
    app.stop()
    store.close()
    if (previousHome === undefined) delete process.env.OPH_AUTORESEARCH_HOME
    else process.env.OPH_AUTORESEARCH_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
})
