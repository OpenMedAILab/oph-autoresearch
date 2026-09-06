/** Watches the active project's Git directory, including linked worktrees. */
import { type FSWatcher, watch } from 'node:fs'
import { mostRecentWorkspace, type Store } from '@oph-autoresearch/store'
import type { EventBus } from './bus.ts'
import { currentBranch, gitDirectory } from './git.ts'

const SETTLE_MS = 120

export interface GitWatch {
  retarget(): void
  announce(): void
  stop(): void
}

export function createGitWatch(store: Store, bus: EventBus): GitWatch {
  let root = ''
  let workspaceId = ''
  let generation = 0
  let lastBranch: string | null = null
  let forceAnnouncement = false
  let stopped = false
  let inner: FSWatcher | null = null
  let outer: FSWatcher | null = null
  let settle: ReturnType<typeof setTimeout> | null = null

  const announce = (force = true) => {
    if (stopped) return
    forceAnnouncement ||= force
    if (settle) clearTimeout(settle)
    const observedGeneration = generation
    const observedRoot = root
    const observedWorkspace = workspaceId
    settle = setTimeout(() => {
      settle = null
      const force = forceAnnouncement
      forceAnnouncement = false
      if (!observedRoot) return
      void currentBranch(observedRoot)
        .then((branch) => {
          // Retarget/stop can happen while Git is still answering.
          if (
            !stopped &&
            generation === observedGeneration &&
            branch &&
            (force || branch !== lastBranch)
          ) {
            lastBranch = branch
            bus.publish({ type: 'git.state', workspaceId: observedWorkspace, branch })
          }
        })
        .catch(() => {})
    }, SETTLE_MS)
  }

  const hold = (path: string, onName: (name: string | null) => void): FSWatcher | null => {
    try {
      const watcher = watch(path, (_kind, name) => onName(name ? String(name) : null))
      watcher.on('error', () => {
        watcher.close()
        if (inner === watcher) inner = null
      })
      return watcher
    } catch {
      return null
    }
  }

  const attachInner = async () => {
    const observedGeneration = generation
    const path = await gitDirectory(root)
    if (stopped || generation !== observedGeneration || inner || !path) return
    // Directory events can coalesce to index.lock or another intermediate name.
    // Read the authoritative branch once after the batch; only changes publish.
    inner = hold(path, () => announce(false))
    announce()
  }

  const retarget = () => {
    if (stopped) return
    const recent = mostRecentWorkspace(store)
    if (recent?.rootPath === root && recent?.id === workspaceId) return
    generation++
    lastBranch = null
    forceAnnouncement = false
    root = recent?.rootPath ?? ''
    workspaceId = recent?.id ?? ''
    if (settle) clearTimeout(settle)
    settle = null
    inner?.close()
    inner = null
    outer?.close()
    outer = null
    if (!root) return
    outer = hold(root, (name) => {
      if (name === null || name === '.git') {
        inner?.close()
        inner = null
        void attachInner().catch(() => {})
      }
    })
    void attachInner().catch(() => {})
    announce()
  }

  return {
    retarget,
    announce,
    stop() {
      stopped = true
      generation++
      if (settle) clearTimeout(settle)
      settle = null
      inner?.close()
      inner = null
      outer?.close()
      outer = null
    },
  }
}
