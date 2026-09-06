import { expect, test } from 'bun:test'
import type { ConversationId } from '@oph-autoresearch/core'
import type { CommandDeps } from './deps.ts'
import { resumeGoal, setGoal } from './run-control.ts'

test('controller-only mode refuses starting or resuming an unbounded goal before any ledger or runner access', () => {
  let touched = false
  const dependencies = new Proxy(
    { researchControllerOnly: true },
    {
      get(target, key) {
        if (key === 'researchControllerOnly') return target.researchControllerOnly
        touched = true
        throw new Error('goal must be refused before touching runner or ledger')
      },
    },
  ) as Omit<CommandDeps, 'ws'>
  const id = 'fixture-conversation' as ConversationId
  expect(setGoal(id, 'keep researching', dependencies)).toMatchObject({ ok: false })
  expect(resumeGoal(id, dependencies)).toMatchObject({ ok: false })
  expect(touched).toBe(false)
})
