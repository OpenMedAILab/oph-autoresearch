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
    await writeFile(
      bin,
      `#!/bin/sh
cat <<'EOF'
{"type":"item.completed","item":{"type":"agent_message","text":"{\\"code\\":\\"export const candidate = 1\\",\\"patch\\":\\"diff --git a/a b/a\\"}"}}
EOF
`,
    )
    await chmod(bin, 0o755)
    const draft = await prepareCliDraft({
      workspaceRoot: root,
      workspaceScope: '.',
      instructions: 'propose only',
      maxRuntimeMs: 1000,
      credentialHome: join(root, 'credentials'),
      adapter: { kind: 'codex-exec', executable: bin, id: 'codex', model: 'fixture' },
      capability: {
        taskRevisionId: 'task_1',
        specHash: sha256(
          canonicalJson({
            taskRevisionId: 'task_1',
            workspaceScope: '.',
            instructions: 'propose only',
            maxRuntimeMs: 1000,
            config: { kind: 'codex-exec', id: 'codex', model: 'fixture', executable: bin },
          }),
        ),
        verify: () => true,
      },
    })
    expect(draft).toMatchObject({
      taskRevisionId: 'task_1',
      usage: null,
      humanApprovalRequired: true,
      code: 'export const candidate = 1',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('requires a verified capability and realpath-contained scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-cli-prep-'))
  try {
    const input = {
      workspaceRoot: root,
      workspaceScope: '../bad',
      instructions: 'propose',
      maxRuntimeMs: 1,
      credentialHome: root,
      adapter: { kind: 'claude-print' as const, executable: 'x', id: 'claude', model: 'x' },
      capability: {
        taskRevisionId: 'task_1',
        specHash: `sha256:${'a'.repeat(64)}`,
        verify: () => true,
      },
    }
    await expect(prepareCliDraft(input)).rejects.toThrow('workspace scope escapes root')
    await expect(
      prepareCliDraft({
        ...input,
        workspaceScope: '.',
        capability: { ...input.capability, verify: () => false },
      }),
    ).rejects.toThrow('invalid approved CLI preparation capability')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects timeout even when a CLI exits successfully on TERM and cleans oversized output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-cli-prep-fault-'))
  try {
    const bin = join(root, 'fault-cli')
    const adapter = {
      kind: 'claude-print' as const,
      executable: bin,
      id: 'claude',
      model: 'fixture',
    }
    const spec = {
      taskRevisionId: 'task_1',
      workspaceScope: '.',
      instructions: 'propose',
      maxRuntimeMs: 150,
      config: adapter,
    }
    const input = {
      workspaceRoot: root,
      workspaceScope: '.',
      instructions: spec.instructions,
      maxRuntimeMs: spec.maxRuntimeMs,
      credentialHome: root,
      adapter,
      capability: {
        taskRevisionId: spec.taskRevisionId,
        specHash: sha256(canonicalJson(spec)),
        verify: () => true,
      },
    }
    await writeFile(
      bin,
      `#!${process.execPath}\nprocess.on('SIGTERM',()=>{console.log(JSON.stringify({result:JSON.stringify({code:'candidate'})}));process.exit(0)});setInterval(()=>{},1000);`,
      { mode: 0o755 },
    )
    await expect(prepareCliDraft(input)).rejects.toThrow('exceeded approved runtime')
    await writeFile(
      bin,
      `#!${process.execPath}\nconsole.log('x'.repeat(300000));setInterval(()=>{},1000);`,
      { mode: 0o755 },
    )
    await expect(
      prepareCliDraft({
        ...input,
        maxRuntimeMs: 2_000,
        capability: {
          ...input.capability,
          specHash: sha256(canonicalJson({ ...spec, maxRuntimeMs: 2_000 })),
        },
      }),
    ).rejects.toThrow('output exceeds limit')
    await expect(
      prepareCliDraft({
        ...input,
        capability: { ...input.capability, specHash: `sha256:${'b'.repeat(64)}` },
      }),
    ).rejects.toThrow('does not bind approved specification')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
