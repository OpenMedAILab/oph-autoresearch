import { createHash, createPublicKey, KeyObject, verify } from 'node:crypto'
import type { TrustedHumanReviewerProof } from '@oph-autoresearch/core'

/** HTTP header carrying a signed human-approval proof; it is deliberately not an app bearer token. */
export const HUMAN_PROOF_HEADER = 'x-oph-human-proof'
const VERSION = 'v1'
const MAX_VALIDITY_MS = 5 * 60_000
const MAX_FUTURE_SKEW_MS = 30_000

export interface HumanAuthClaims {
  issuer: string
  reviewerId: string
  proofId: string
  issuedAt: number
  expiresAt: number
  workspaceId: string
  campaignId: string
  action: 'approve' | 'revoke' | 'labelset'
  bodyHash: string
}

export interface HumanAuthIssuer {
  publicKey: string | KeyObject
  reviewerIds: readonly string[]
}

export interface HumanAuthVerifierConfig {
  /** Public URL of an independent approval console; never contains its session credential. */
  approvalUrl?: string
  issuers: Readonly<Record<string, HumanAuthIssuer>>
  now?: () => number
}

export interface HumanAuthRequest {
  /** Raw value of `x-oph-human-proof`; no authorization scheme is accepted. */
  header: string | null | undefined
  workspaceId: string
  campaignId: string
  action: 'approve' | 'revoke' | 'labelset'
  /** Parsed request body, re-canonicalized before its SHA-256 binding is checked. */
  body: unknown
}

export type HumanAuthVerifier = (request: HumanAuthRequest) => TrustedHumanReviewerProof | null

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function claimsOf(value: unknown): HumanAuthClaims | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const expected = [
    'action',
    'bodyHash',
    'campaignId',
    'expiresAt',
    'issuedAt',
    'issuer',
    'proofId',
    'reviewerId',
    'workspaceId',
  ]
  const keys = Object.keys(source).sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    return null
  if (
    !text(source.issuer) ||
    !text(source.reviewerId) ||
    !text(source.proofId) ||
    !text(source.workspaceId) ||
    !text(source.campaignId) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(source.bodyHash)) ||
    !Number.isSafeInteger(source.issuedAt) ||
    !Number.isSafeInteger(source.expiresAt) ||
    (source.action !== 'approve' && source.action !== 'revoke' && source.action !== 'labelset')
  )
    return null
  return source as unknown as HumanAuthClaims
}

function payloadOf(
  header: string | null | undefined,
): { encoded: string; signature: Buffer } | null {
  if (typeof header !== 'string') return null
  const [version, encoded, signed, extra] = header.split('.')
  if (version !== VERSION || !encoded || !signed || extra !== undefined) return null
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signed)) return null
  try {
    const payload = Buffer.from(encoded, 'base64url')
    const signature = Buffer.from(signed, 'base64url')
    // Reject noncanonical low padding bits: two textual signatures must never decode to the same
    // byte sequence, otherwise a "tampered" header can still verify as the original signature.
    if (payload.toString('base64url') !== encoded || signature.toString('base64url') !== signed)
      return null
    return { encoded, signature }
  } catch {
    return null
  }
}

/**
 * Builds a verifier whose issuer keys and reviewer allowlists are captured once at startup.
 * Invalid proofs return null. Configuration errors throw during construction. This verifier does
 * not consume `proofId`; replay prevention belongs to the campaign ledger transaction.
 */
export function createHumanAuthVerifier(config: HumanAuthVerifierConfig): HumanAuthVerifier {
  const issuers = new Map<string, { publicKey: KeyObject; reviewers: ReadonlySet<string> }>()
  for (const [issuer, entry] of Object.entries(config.issuers)) {
    if (
      !text(issuer) ||
      !entry ||
      !Array.isArray(entry.reviewerIds) ||
      entry.reviewerIds.some((id) => !text(id))
    )
      throw new Error('invalid human authentication issuer configuration')
    try {
      if (
        typeof entry.publicKey !== 'string' &&
        (!(entry.publicKey instanceof KeyObject) || entry.publicKey.type !== 'public')
      )
        throw new Error('a native public key or serialized key is required')
      issuers.set(issuer, {
        publicKey:
          typeof entry.publicKey === 'string' ? createPublicKey(entry.publicKey) : entry.publicKey,
        reviewers: new Set(entry.reviewerIds),
      })
    } catch {
      throw new Error('invalid human authentication issuer public key')
    }
  }
  const now = config.now ?? Date.now
  return (request) => {
    const packed = payloadOf(request.header)
    if (!packed) return null
    let raw: string
    let decoded: unknown
    try {
      raw = Buffer.from(packed.encoded, 'base64url').toString('utf8')
      decoded = JSON.parse(raw)
    } catch {
      return null
    }
    // A canonical signed payload avoids duplicate-key and serialization ambiguity at this boundary.
    if (canonical(decoded) !== raw) return null
    const claims = claimsOf(decoded)
    if (!claims) return null
    const issuer = issuers.get(claims.issuer)
    if (!issuer || !issuer.reviewers.has(claims.reviewerId)) return null
    if (
      claims.workspaceId !== request.workspaceId ||
      claims.campaignId !== request.campaignId ||
      claims.action !== request.action ||
      claims.bodyHash !== hash(request.body)
    )
      return null
    const at = now()
    if (
      claims.issuedAt > at + MAX_FUTURE_SKEW_MS ||
      claims.expiresAt < at ||
      claims.expiresAt <= claims.issuedAt ||
      claims.expiresAt - claims.issuedAt > MAX_VALIDITY_MS
    )
      return null
    return verify(null, Buffer.from(packed.encoded, 'utf8'), issuer.publicKey, packed.signature)
      ? {
          issuer: claims.issuer,
          reviewerId: claims.reviewerId,
          proofId: claims.proofId,
          verifiedAt: at,
        }
      : null
  }
}
