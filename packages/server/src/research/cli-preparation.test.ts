import { expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareCliDraft } from './cli-preparation.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

test('runs an admitted local CLI in empty staging and returns immutable review-only code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-cli-prep-'))
  try {
    const bin = join(root, 'fake-cli')
    await writeFile(bin, `#!/bin/sh
cat <<'EOF'
{"type":"item.completed","item":{"type":"agent_message","text":"{\\"code\\":\\"export const candidate = 1\\",\\"patch\\":\\"diff --git a/a b/a\\"}"}}
EOF
`)
    await chmod(bin, 0o755)
    const draft = await prepareCliDraft({
      workspaceRoot: root, workspaceScope: '.', instructions: 'propose only', maxRuntimeMs: 1000,
      credentialHome: join(root, 'credentials'), adapter: { kind: 'codex-exec', executable: bin, id: 'codex', model: 'fixture' },
      capability: { taskRevisionId: 'task_1', specHash: sha256(canonicalJson({ taskRevisionId: 'task_1', workspaceScope: '.', instructions: 'propose only', maxRuntimeMs: 1000, config: { kind: 'codex-exec', id: 'codex', model: 'fixture', executable: bin } })), verify: () => true },
    })
    expect(draft).toMatchObject({ taskRevisionId: 'task_1', usage: null, humanApprovalRequired: true, code: 'export const candidate = 1' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('requires a verified capability and realpath-contained scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-cli-prep-'))
  try {
    const input = { workspaceRoot: root, workspaceScope: '../bad', instructions: '', maxRuntimeMs: 1, credentialHome: root, adapter: { kind: 'claude-print' as const, executable: 'x', id: 'claude', model: 'x' }, capability: { taskRevisionId: 'task_1', specHash: `sha256:${'a'.repeat(64)}`, verify: () => true } }
    await expect(prepareCliDraft(input)).rejects.toThrow('workspace scope escapes root')
    await expect(prepareCliDraft({ ...input, workspaceScope: '.', capability: { ...input.capability, verify: () => false } })).rejects.toThrow('invalid approved CLI preparation capability')
  } finally { await rm(root, { recursive: true, force: true }) }
})
