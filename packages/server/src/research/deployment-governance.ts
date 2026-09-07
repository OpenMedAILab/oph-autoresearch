import { createPublicKey, KeyObject } from 'node:crypto'
import type { ResearchExecutionBoundary } from '@oph-autoresearch/core'
import type { HumanAuthVerifierConfig } from './human-auth.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

/** Administrator-supplied startup contract. It is never loaded from a research workspace or HTTP body. */
export interface ResearchDeploymentManifest {
  schema: 'research-deployment-v1'
  organizationId: string
  boundary: ResearchExecutionBoundary
  bindHost: '127.0.0.1' | '::1'
  reviewerKeyHashes: Record<string, string>
  allowDaemon: boolean
  allowPublicMetadata: boolean
}
export function captureResearchDeployment(
  raw: unknown,
  launch: {
    host: string
    boundary: ResearchExecutionBoundary
    humanAuth?: HumanAuthVerifierConfig | undefined
    requireApproval: boolean
    daemonConfigured: boolean
  },
) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid deployment manifest')
  const manifest = structuredClone(raw) as ResearchDeploymentManifest
  if (
    Object.keys(manifest).sort().join(',') !==
      [
        'schema',
        'organizationId',
        'boundary',
        'bindHost',
        'reviewerKeyHashes',
        'allowDaemon',
        'allowPublicMetadata',
      ]
        .sort()
        .join(',') ||
    manifest.schema !== 'research-deployment-v1' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(manifest.organizationId) ||
    !['standard', 'restricted-clinical'].includes(manifest.boundary) ||
    !['127.0.0.1', '::1'].includes(manifest.bindHost) ||
    typeof manifest.allowDaemon !== 'boolean' ||
    typeof manifest.allowPublicMetadata !== 'boolean' ||
    !manifest.reviewerKeyHashes ||
    typeof manifest.reviewerKeyHashes !== 'object' ||
    Array.isArray(manifest.reviewerKeyHashes)
  )
    throw new Error('Invalid deployment manifest schema')
  if (
    launch.host !== manifest.bindHost ||
    launch.boundary !== manifest.boundary ||
    !launch.requireApproval ||
    (launch.daemonConfigured && !manifest.allowDaemon) ||
    (manifest.boundary === 'restricted-clinical' &&
      (manifest.allowDaemon || manifest.allowPublicMetadata))
  )
    throw new Error('Deployment launch does not match the administrator contract')
  const configured: Record<string, string> = {}
  for (const [issuer, source] of Object.entries(launch.humanAuth?.issuers ?? {})) {
    const key =
      source.publicKey instanceof KeyObject ? source.publicKey : createPublicKey(source.publicKey)
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519')
      throw new Error('Deployment requires Ed25519 reviewer public keys')
    configured[issuer] = sha256(key.export({ type: 'spki', format: 'der' }))
  }
  if (
    Object.keys(configured).length === 0 ||
    canonicalJson(configured) !== canonicalJson(manifest.reviewerKeyHashes)
  )
    throw new Error('Deployment reviewer keys do not match the administrator contract')
  return Object.freeze({
    contractHash: sha256(canonicalJson(manifest)),
    organizationId: manifest.organizationId,
    boundary: manifest.boundary,
    bindHost: manifest.bindHost,
    allowDaemon: manifest.allowDaemon,
    allowPublicMetadata: manifest.allowPublicMetadata,
    immutable: true as const,
    clinicalAcceptance: false as const,
    infrastructureAcceptance: 'external-evidence-required' as const,
    researchApprovalRequired: true as const,
    maxModelRequests: 2,
    maxOutputTokens: 1024,
  })
}
