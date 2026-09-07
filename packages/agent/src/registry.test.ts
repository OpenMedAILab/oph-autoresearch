/**
 * 工具名的 provider 约束。
 *
 * 这条是实测撞出来的，而且只在**真实产物 + 真实 provider**下才会出现：
 * 装一个 id 叫 `demo.lines` 的插件（反向域名风格，清单文档自己推荐的写法），
 * 工具名成了 `demo.lines__count`，然后每一轮 run 都被
 * `Invalid 'tools[0].function.name'` 400 打死——而错误信息不说是哪个插件。
 *
 * 单测、typecheck、本地跑 agent 全都是绿的：内置工具名里没有点。
 */

import { describe, expect, test } from 'bun:test'
import {
  decideResearchCapability,
  RESTRICTED_RESEARCH_CAPABILITY_DENIED,
} from '@oph-autoresearch/core'
import {
  resolveAction,
  sanitizeToolName,
  TOOL_NAME_PATTERN,
  type ToolContext,
  ToolRegistry,
  type ToolSpec,
} from './registry.ts'

const spec = (name: string): ToolSpec => ({
  name,
  description: 'd',
  parameters: { type: 'object' },
  actionKind: 'read',
  objectLabel: 'x',
  category: 'session',
  facet: '测试',
  summary: '测试夹具',
  permissionEffect: 'read',
  fn: async () => ({ status: 'success', message: 'ok' }),
})

describe('注册期就挡住 provider 不收的名字', () => {
  test('点被拒 —— 反向域名风格的插件 id 就会产生它', () => {
    expect(() => new ToolRegistry().register(spec('demo.lines__count'))).toThrow('provider')
  })

  for (const bad of ['a:b', 'a/b', 'a b', 'a.b', '工具', 'a+b']) {
    test(`拒绝 ${JSON.stringify(bad)}`, () => {
      expect(() => new ToolRegistry().register(spec(bad))).toThrow()
    })
  }

  test('超过 64 字符被拒', () => {
    expect(() => new ToolRegistry().register(spec('a'.repeat(65)))).toThrow()
  })

  test('合法的照常注册', () => {
    const r = new ToolRegistry()
    r.register(spec('read_file'))
    r.register(spec('mcp__github__create-issue'))
    expect(r.list()).toHaveLength(2)
  })
})

describe('执行入口 fail-closed', () => {
  test('注册表未命中返回未执行的结构化失败', async () => {
    const out = await new ToolRegistry().execute('missing_tool', {}, {} as unknown as ToolContext)
    expect(out).toEqual({
      status: 'failure',
      executed: false,
      message: '未注册调用：missing_tool',
      errorKind: 'unregistered_tool_call',
    })
  })

  test('restricted clinical boundary rejects before any tool-derived behavior', async () => {
    const registry = new ToolRegistry()
    let actionCalls = 0
    let permissionCalls = 0
    let toolCalls = 0
    registry.register({
      ...spec('mcp__alias__shell'),
      actionKind: () => {
        actionCalls++
        return 'run'
      },
      permissionEffect: () => {
        permissionCalls++
        return 'execute'
      },
      targetExtractor: () => {
        permissionCalls++
        return 'canary-target'
      },
      fn: async () => {
        toolCalls++
        return { status: 'success', message: 'canary-result' }
      },
    })
    const out = await registry.execute(
      'mcp__alias__shell',
      { command: 'canary-argument', mode: 'full' },
      {
        researchBoundary: 'restricted-clinical',
        requestPermission: async () => {
          permissionCalls++
          return true
        },
      } as unknown as ToolContext,
    )
    expect(out).toEqual({
      status: 'failure',
      executed: false,
      message: RESTRICTED_RESEARCH_CAPABILITY_DENIED,
      errorKind: 'research_boundary_denied',
    })
    expect(actionCalls).toBe(0)
    expect(permissionCalls).toBe(0)
    expect(toolCalls).toBe(0)
    expect(JSON.stringify(out)).not.toContain('canary')
    const unknown = await registry.execute(
      'plugin__canary__raw_file',
      { secret: 'canary-unknown-argument' },
      { researchBoundary: 'restricted-clinical' } as ToolContext,
    )
    expect(unknown).toEqual({
      status: 'failure',
      executed: false,
      message: RESTRICTED_RESEARCH_CAPABILITY_DENIED,
      errorKind: 'research_boundary_denied',
    })
    expect(JSON.stringify(unknown)).not.toContain('canary')
  })

  test('standard boundary leaves registered tools unchanged', async () => {
    const registry = new ToolRegistry()
    registry.register(spec('read_file'))
    const out = await registry.execute('read_file', {}, {
      researchBoundary: 'standard',
      requestPermission: async () => true,
    } as unknown as ToolContext)
    expect(out).toMatchObject({ status: 'success', executed: true, message: 'ok' })
    expect(decideResearchCapability('standard', 'tool-execution')).toEqual({ allowed: true })
  })
})

describe('消毒', () => {
  test('非法字符统一换成下划线', () => {
    expect(sanitizeToolName('demo.lines__count')).toBe('demo_lines__count')
    expect(sanitizeToolName('mcp__my.server__do:it')).toBe('mcp__my_server__do_it')
  })

  test('消毒结果一定能通过校验', () => {
    for (const raw of ['a.b', '中文工具', 'x/y z', '@scope/pkg__tool']) {
      expect(TOOL_NAME_PATTERN.test(sanitizeToolName(raw))).toBe(true)
    }
  })

  test('截到 64 —— provider 的上限也是硬的', () => {
    expect(sanitizeToolName('x'.repeat(100))).toHaveLength(64)
  })

  /**
   * 消毒**会**制造碰撞。这里钉住这个事实：产出方必须自己查重，
   * 不能假设消毒后还是唯一的。
   */
  test('a.b 与 a_b 消毒后同名 —— 调用方必须自己查重', () => {
    expect(sanitizeToolName('a.b')).toBe(sanitizeToolName('a_b'))
  })
})

/**
 * 动作语义的解析。
 *
 * 兜底那条是实打实的坑：给注册表里查不到的工具兜一个
 * `{ kind: 'read', objectLabel: 工具名 }`，就是让一个可能在写、在删、在跑的陌生
 * 工具在卡片上写着「读取 xxx」——不是把原词当动词，是**编了一个具体且错误的动词**。
 */
describe('动作语义按参数解析，不按工具名猜', () => {
  test('常量 kind 原样返回', () => {
    expect(resolveAction(spec('read_thing'), {}).kind).toBe('read')
  })

  test('函数 kind 拿得到 args', () => {
    const s: ToolSpec = {
      ...spec('facade'),
      actionKind: (a) => (a.mode === 'rm' ? 'delete' : 'read'),
    }
    expect(resolveAction(s, { mode: 'rm' }).kind).toBe('delete')
    expect(resolveAction(s, { mode: 'cat' }).kind).toBe('read')
  })

  /** 有些动作光看参数分不出创建还是编辑，差别在 ctx.state 里的既有状态。 */
  test('函数 kind 拿得到 ctx', () => {
    const s: ToolSpec = {
      ...spec('stateful'),
      actionKind: (_a, c) => (c?.state.get('has') ? 'edit' : 'write'),
    }
    const c = { state: new Map([['has', true]]) } as unknown as ToolContext
    expect(resolveAction(s, {}).kind).toBe('write')
    expect(resolveAction(s, {}, c).kind).toBe('edit')
  })
})
