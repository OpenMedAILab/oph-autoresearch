import { canonicalJson as canonical, sha256 } from './skill-lock.ts'
/** Hash only stable binding facts. The local root, SSH profile, and credentials never enter a plan. */
export function formalWorkspaceBindingHash(
  workspaceId: string,
  binding: { connectionHash: string; remoteRoot: string },
): string {
  return sha256(
    canonical({
      schema: 'research-formal-workspace-binding-v1',
      localWorkspaceId: workspaceId,
      profileConnectionHash: binding.connectionHash,
      remoteRoot: binding.remoteRoot,
    }),
  )
}
