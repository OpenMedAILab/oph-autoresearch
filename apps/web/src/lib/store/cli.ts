import { createSignal } from 'solid-js'
import { client } from './connection.ts'
import { reloadModelCatalog } from './settings.ts'
export interface CliAgentInfo {
  id: string
  profileId?: string
  provider: string
  path: string
  location: string
  canRun: boolean
  probe: {
    status: 'authenticated' | 'unauthenticated' | 'unknown' | 'error'
    models: { id: string; label: string }[]
    checkedAt: number
    message: string
  } | null
}
interface Snapshot {
  agents: CliAgentInfo[]
  hosts: { id: string; label: string; status: string; message: string }[]
  probing: boolean
  checkedAt: number
}
export const [cliDiscovery, setCliDiscovery] = createSignal<Snapshot>({
  agents: [],
  hosts: [],
  probing: false,
  checkedAt: 0,
})
export const [cliDiscoveryError, setCliDiscoveryError] = createSignal('')
let active: Promise<void> | undefined
export function discoverCliModels(force = false): Promise<void> {
  if (active) return active
  active = (async () => {
    setCliDiscoveryError('')
    setCliDiscovery((s) => ({ ...s, probing: true }))
    try {
      let snapshot = await client.api<Snapshot>('/api/team/cli/probe', {
        method: 'POST',
        body: JSON.stringify({ automatic: !force }),
      })
      for (;;) {
        setCliDiscovery(snapshot)
        await reloadModelCatalog()
        if (!snapshot.probing) break
        await new Promise((resolve) => setTimeout(resolve, 1500))
        snapshot = await client.api<Snapshot>('/api/team/cli')
      }
    } catch {
      setCliDiscoveryError('CLI 自动探测连接失败，可点击重新探测。')
      setCliDiscovery((s) => ({ ...s, probing: false }))
    }
  })().finally(() => {
    active = undefined
  })
  return active
}
