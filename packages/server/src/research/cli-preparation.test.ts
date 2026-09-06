import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareCliDraft } from './cli-preparation.ts'

test('CLI preparation captures a bounded immutable draft but never applies it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-cli-prep-'))
  try {
    const draft = await prepareCliDraft({
      workspaceRoot: root, workspaceScope: '.', taskRevisionId: 'task_1', instructions: 'propose code', maxRuntimeMs: 1000,
      budget: { maxRequests: 0, maxCostUsd: 0 }, adapter: { id: 'native-cli', model: 'fixture', argv: ['fixture'] },
      transport: { run: async ({ stdin }) => ({ exitCode: 0, identity: 'fixture-cli@1', stdout: JSON.stringify({ code: `export const approved = ${JSON.parse(stdin).approved.taskRevisionId!=='x'}\n`, patch: 'diff --git a/a b/a' }) }) },
    })
    expect(draft).toMatchObject({ taskRevisionId: 'task_1', humanApprovalRequired: true, adapter: { identity: 'fixture-cli@1' }, patch: 'diff --git a/a b/a' })
    expect(draft.contentHash).toMatch(/^sha256:/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('CLI preparation rejects escaping scope and nonzero budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-cli-prep-'))
  try {
    const input = { workspaceRoot: root, workspaceScope: '../escape', taskRevisionId: 'task_1', instructions: '', maxRuntimeMs: 1, budget: { maxRequests: 0, maxCostUsd: 0 }, adapter: { id: 'native-cli', model: 'fixture', argv: ['fixture'] }, transport: { run: async () => ({ exitCode: 0, stdout: '{"code":"x"}' }) } }
    await expect(prepareCliDraft(input)).rejects.toThrow('workspace scope escapes root')
    await expect(prepareCliDraft({ ...input, workspaceScope: '.', budget: { maxRequests: 1, maxCostUsd: 0 } })).rejects.toThrow('invalid approved CLI preparation specification')
  } finally { await rm(root, { recursive: true, force: true }) }
})
