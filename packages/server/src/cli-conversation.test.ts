import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@oph-autoresearch/core'
import type { OphConfig } from '@oph-autoresearch/runtime'
import {
  createConversation,
  listRuns,
  listSteps,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { type ApiDeps, handleApi } from './api/index.ts'
import { CliConversationSession } from './cli-conversation.ts'

// 假 CLI 只在测试临时目录内执行，验证完整 argv/进程/回执链而不使用模型额度。
test.skipIf(process.platform === 'win32')(
  '主对话 CLI：指定模型、多轮历史、失败与中断落账',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'oph-cli-conversation-'))
    const originalPath = process.env.PATH
    const store = new Store({ path: ':memory:' })
    try {
      const bin = join(root, 'bin')
      await mkdir(bin)
      await writeFile(
        join(bin, 'codex'),
        `#!${process.execPath}
await Bun.write('cli-input.json', JSON.stringify(process.argv.slice(2)));
const prompt = process.argv.at(-1);
if (prompt.includes('FAIL_NOW')) { console.error('CLI login failed'); process.exit(1); }
if (prompt.includes('WAIT_NOW')) await Bun.sleep(10000);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'CLI answer'}}));
`,
        { mode: 0o755 },
      )
      process.env.PATH = `${bin}:${originalPath}`
      const ws = upsertWorkspace(store, root, 'CLI test')
      const config: OphConfig = {
        active: { provider: 'api', model: 'no-key' },
        providers: {},
        mode: 'auto',
      }
      const conv = createConversation(store, {
        workspaceId: ws.id,
        provider: 'cli:codex',
        model: 'test-model',
      })
      const modelsUrl = new URL('http://localhost/api/models')
      const modelsResponse = await handleApi(modelsUrl, new Request(modelsUrl.href), {
        store,
        config,
      } as ApiDeps)
      const catalog = (await modelsResponse!.json()) as {
        providers: { name: string; source?: string; models: { id: string }[] }[]
      }
      expect(catalog.providers.find((provider) => provider.name === 'cli:codex')).toBeUndefined()
      const run = async (prompt: string, signal = new AbortController().signal, id = conv.id) => {
        const session = new CliConversationSession({ store, config, workspaceRoot: root, signal })
        const events: AgentEvent[] = []
        for await (const event of session.ask(prompt, id)) events.push(event)
        return events
      }
      expect((await run('first question')).at(-1)).toMatchObject({
        type: 'run.finished',
        status: 'done',
      })
      expect(await run('second question')).toContainEqual(
        expect.objectContaining({ type: 'text.delta', delta: 'CLI answer' }),
      )
      const argv = JSON.parse(await readFile(join(root, 'cli-input.json'), 'utf8')) as string[]
      expect(argv.slice(0, 3)).toEqual(['exec', '--model', 'test-model'])
      expect(argv.at(-1)).toContain('first question')
      expect(argv.at(-1)).toContain('assistant: CLI answer')
      expect(argv.at(-1)).toContain('second question')
      expect(listSteps(store, listRuns(store, conv.id)[0]!.id)[0]?.content).toBe('CLI answer')
      expect((await run('FAIL_NOW')).at(-1)).toMatchObject({
        status: 'failed',
        stopReason: 'provider_error',
      })
      const interrupted = createConversation(store, {
        workspaceId: ws.id,
        provider: 'cli:codex',
        model: 'default',
      })
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 150)
      try {
        expect((await run('WAIT_NOW', controller.signal, interrupted.id)).at(-1)).toMatchObject({
          status: 'interrupted',
          stopReason: 'user_interrupt',
        })
      } finally {
        clearTimeout(timer)
      }
      expect(listRuns(store, interrupted.id)[0]?.status).toBe('interrupted')
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  15000,
)
