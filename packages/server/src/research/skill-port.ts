import type { ToolContextBase } from '@oph-autoresearch/agent'
import { type SkillLock, verifySkillLock } from './skill-lock.ts'

/** Captures only code-selected locks. Every read rechecks observed metadata and bytes. */
export function lockedResearchSkillPort(
  entries: ReadonlyArray<{
    lock: Readonly<SkillLock>
    observe(): Promise<{ snapshot: unknown; content: string }>
  }>,
): NonNullable<ToolContextBase['researchSkills']> {
  const captured = entries.map((entry) => ({
    lock: structuredClone(entry.lock),
    observe: entry.observe,
  }))
  return {
    async read(name) {
      const entry = captured.find((item) => item.lock.id === name)
      if (!entry) throw new Error('研究技能未准入')
      const observed = await entry.observe()
      const checked = verifySkillLock(entry.lock, observed.snapshot, observed.content)
      if (!checked.ok) throw new Error(checked.message)
      return observed.content
    },
  }
}
