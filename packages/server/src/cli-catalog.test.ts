import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type SshProfile, saveSshProfiles } from '@oph-autoresearch/tools'
import {
  cliSshTargets,
  parseRemoteCliProvider,
  probeRemoteHost,
  remoteCliProvider,
  shellQuote,
} from './cli-catalog.ts'

const profile: SshProfile = {
  id: 'gpu-test',
  name: '研究服务器',
  host: 'gpu.example.org',
  port: 22,
  root: '/data/research',
  readOnly: true,
  hostKeyPolicy: 'strict',
}

test('remote CLI probe uses SSH metadata protocols, isolates provider IDs and reports logged out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-remote-probe-test-'))
  const oldPath = process.env.PATH
  const oldHome = process.env.OPH_AUTORESEARCH_HOME
  try {
    const bin = join(root, 'bin')
    await mkdir(bin)
    const log = join(root, 'calls.jsonl')
    await writeFile(
      join(bin, 'ssh'),
      `#!${process.execPath}
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const command=process.argv.at(-1);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2)})+'\\n');
if(command.includes('for c in codex claude grok')) {console.log('codex\\t/mock/codex\\nclaude\\t/mock/claude\\ngrok\\t/mock/grok');process.exit(0)}
if(command.includes('/mock/grok')) {console.log('Available models:\\n * grok-4.6 (default)');console.error('You are not authenticated.');process.exit(0)}
if(command.includes('/mock/claude')) {console.log(JSON.stringify({loggedIn:false}));process.exit(1)}
createInterface({input:process.stdin}).on('line', line=>{
 const row=JSON.parse(line); appendFileSync(${JSON.stringify(log)}, JSON.stringify({method:row.method})+'\\n');
 if(row.method==='initialized')return;
 let result={};
 if(row.method==='account/read')result={account:{type:'chatgpt',email:'private@example.org'},requiresOpenaiAuth:true};
 else if(row.method==='model/list')result={data:[{model:'remote-model',displayName:'Remote Model'}]};
 else if(row.method!=='initialize')process.exit(3);
 console.log(JSON.stringify({id:row.id,result}));
});`,
      { mode: 0o755 },
    )
    process.env.PATH = `${bin}:${oldPath}`
    process.env.OPH_AUTORESEARCH_HOME = join(root, 'home')
    const rows = await probeRemoteHost(profile)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      provider: 'cli:ssh:gpu-test:codex',
      canRun: false,
      probe: { status: 'authenticated', models: [{ id: 'remote-model' }] },
    })
    expect(rows[1]!.probe).toMatchObject({ status: 'unauthenticated', models: [] })
    expect(rows[2]!.probe).toMatchObject({ status: 'unauthenticated', models: [] })
    expect(JSON.stringify(rows)).not.toContain('private@example.org')
    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(calls.filter((c) => c.method).map((c) => c.method)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'model/list',
    ])
    expect(calls.filter((c) => c.args).every((c) => c.args.includes('gpu.example.org'))).toBe(true)
    expect(calls.filter((c) => c.args).every((c) => c.args.at(-1).includes('cd /tmp'))).toBe(true)
    await saveSshProfiles([profile, { ...profile, id: 'writable', readOnly: false }])
    expect((await cliSshTargets()).map((p) => p.id)).toEqual(['writable'])
  } finally {
    process.env.PATH = oldPath
    if (oldHome === undefined) delete process.env.OPH_AUTORESEARCH_HOME
    else process.env.OPH_AUTORESEARCH_HOME = oldHome
    await rm(root, { recursive: true, force: true })
  }
})

test('remote identity and shell arguments cannot select a local CLI or execute substitutions', async () => {
  expect(parseRemoteCliProvider(remoteCliProvider('gpu-test', 'codex'))).toEqual({
    profileId: 'gpu-test',
    id: 'codex',
  })
  expect(parseRemoteCliProvider('cli:codex')).toBeUndefined()
  expect(parseRemoteCliProvider('cli:ssh:x;id:codex')).toBeUndefined()
  const input = "a 'quoted' $(echo injected) `echo injected`\n模型"
  const proc = Bun.spawn(['sh', '-c', `printf %s ${shellQuote(input)}`], { stdout: 'pipe' })
  expect(await new Response(proc.stdout).text()).toBe(input)
  expect(await proc.exited).toBe(0)
})
