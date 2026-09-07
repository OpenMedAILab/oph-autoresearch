import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DetectedCli } from './cli-detect.ts'
import { cachedCliProbe, parseGrokModels, probeCli } from './cli-probe.ts'

async function fixture(id: string, source: string, check: (cli: DetectedCli) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'oph-probe-test-'))
  const path = join(dir, id)
  try {
    await writeFile(join(dir, 'package.json'), '{"type":"commonjs"}')
    await writeFile(path, `#!/usr/bin/env node\n${source}`, { mode: 0o755 })
    await check({ id, path, command: path, vendor: id, args: [], output: 'text', connected: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('Codex: account probe, paginated visible models, cache and failed refresh clear old models', async () => {
  await fixture(
    'codex',
    `
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); let result={};
 if(m.method==='initialized')return;
 if(m.method==='account/read') result={account:{type:'chatgpt',email:'secret@example.org'},requiresOpenaiAuth:true};
 else if(m.method==='model/list')result=m.params.cursor ? {data:[{model:'second',displayName:'第二个'}]} : {data:[{model:'first',displayName:'第一个'},{model:'hidden',hidden:true}],nextCursor:'next'};
 else if(m.method!=='initialize') process.exit(2);
 console.log(JSON.stringify({id:m.id,result}));
});`,
    async (cli) => {
      const result = await probeCli(cli)
      expect(result.status).toBe('authenticated')
      expect(result.models.map((m) => m.id)).toEqual(['first', 'second'])
      expect(JSON.stringify(result)).not.toContain('secret')
      expect(await probeCli(cli)).toBe(result)
      await writeFile(cli.path, '#!/usr/bin/env node\nconsole.log("invalid response")')
      const failed = await probeCli(cli, { force: true })
      expect(failed.status).toBe('error')
      expect(failed.models).toEqual([])
      expect(cachedCliProbe(cli)).toBe(failed)
    },
  )
})

test('Claude: logged out never initializes model session, even when credential heuristic is true', async () => {
  await fixture(
    'claude',
    `if(process.argv[2]!=='auth')process.exit(3); console.log(JSON.stringify({loggedIn:false}));process.exit(1)`,
    async (cli) => {
      expect(await probeCli(cli)).toMatchObject({ status: 'unauthenticated', models: [] })
    },
  )
})

test('Claude: reads model menu through control initialization without a user prompt', async () => {
  await fixture(
    'claude',
    `
if(process.argv[2]==='auth') {console.log(JSON.stringify({loggedIn:true}));process.exit(0)}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.type!=='control_request'||m.request.subtype!=='initialize')process.exit(3);
 console.log(JSON.stringify({type:'control_response',response:{request_id:m.request_id,subtype:'success',response:{models:[{value:'sonnet',displayName:'Sonnet'}]}}}));
});`,
    async (cli) => {
      expect(await probeCli(cli)).toMatchObject({
        status: 'authenticated',
        models: [{ id: 'sonnet', label: 'Sonnet' }],
      })
    },
  )
})

test('Grok: exit success and a default model do not imply authentication', () => {
  expect(
    parseGrokModels('You are not authenticated.\nAvailable models:\n * grok-4.6 (default)'),
  ).toMatchObject({ status: 'unauthenticated', models: [] })
  expect(parseGrokModels('Available models:\n * grok-4.6 (default)')).toMatchObject({
    status: 'unknown',
    models: [{ id: 'grok-4.6' }],
  })
})

test('Probe timeout is bounded and reported without a model list', async () => {
  await fixture('codex', 'setInterval(()=>{},1000)', async (cli) => {
    const start = Date.now()
    expect(await probeCli(cli, { timeoutMs: 100 })).toMatchObject({
      status: 'error',
      models: [],
      message: expect.stringContaining('超时'),
    })
    expect(Date.now() - start).toBeLessThan(3000)
  })
})

test('Grok: authentication warning on stderr excludes stdout default models', async () => {
  await fixture(
    'grok',
    `console.log('Available models:\\n * grok-4.6 (default)');console.error('You are not authenticated.')`,
    async (cli) => {
      expect(await probeCli(cli)).toMatchObject({ status: 'unauthenticated', models: [] })
    },
  )
})

test('Grok: explicit login response confirms authentication', () => {
  expect(
    parseGrokModels('You are logged in with grok.com.\nAvailable models:\n * grok-4.6 (default)'),
  ).toMatchObject({ status: 'authenticated', models: [{ id: 'grok-4.6' }] })
})
