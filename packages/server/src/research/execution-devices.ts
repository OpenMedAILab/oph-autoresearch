import {
  createSshDaemonClient,
  type SshDaemonAuthority,
  type SshDaemonConfig,
} from './ssh-daemon-client.ts'

export interface ResearchDevice {
  id: string
  authority: SshDaemonAuthority
}
/** Fixed administrator catalog; selection does not migrate or resubmit an existing dispatch. */
export function createResearchDevices(
  configs: readonly { id: string; config: SshDaemonConfig }[],
): ResearchDevice[] {
  if (
    !Array.isArray(configs) ||
    configs.length < 1 ||
    configs.length > 8 ||
    new Set(configs.map((c) => c.id)).size !== configs.length ||
    new Set(configs.map((c) => c.config.authorityId)).size !== configs.length ||
    configs.some((c) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(c.id))
  )
    throw new Error('Invalid fixed execution device catalog')
  return configs
    .map((c) => ({ id: c.id, authority: createSshDaemonClient(c.config) }))
    .sort((a, b) => a.id.localeCompare(b.id))
}
export async function quoteResearchDevice(devices: readonly ResearchDevice[]) {
  const observations = await Promise.all(
    devices.map(async (device) => {
      let availableSlots = 0
      try {
        availableSlots = await device.authority.availability()
      } catch {
        /* unavailable is not an execution failure */
      }
      return {
        id: device.id,
        backend: 'ssh-daemon' as const,
        backendPolicyHash: device.authority.backendPolicyHash,
        trackingPolicyHash: device.authority.trackingPolicyHash ?? null,
        availableSlots,
      }
    }),
  )
  return {
    observations,
    selected: observations.find((o) => o.availableSlots === 1) ?? null,
    selectionBasis: 'fixed-catalog-first-available',
    reservation: false,
    requiresExactHumanApproval: true,
  }
}
