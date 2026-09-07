/** Covers signed human proof verification and startup validation for JSON and native public keys. */
import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createHumanAuthVerifier, type HumanAuthClaims } from './human-auth.ts'

const now = 1_700_000_000_000
const pair = generateKeyPairSync('ed25519')
const body = { approval: 'bundle-sha256', reviewerNote: 'confirmed' }

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
  return `sha256:${new Bun.CryptoHasher('sha256').update(canonical(value)).digest('hex')}`
}

function claims(overrides: Partial<HumanAuthClaims> = {}): HumanAuthClaims {
  return {
    issuer: 'clinical-identity',
    reviewerId: 'reviewer-01',
    proofId: 'proof-01',
    issuedAt: now - 1_000,
    expiresAt: now + 60_000,
    workspaceId: 'ws_01',
    campaignId: 'rc_01',
    action: 'approve',
    bodyHash: hash(body),
    ...overrides,
  }
}

function header(value = claims()): string {
  const encoded = Buffer.from(canonical(value)).toString('base64url')
  const signature = sign(null, Buffer.from(encoded, 'utf8'), pair.privateKey).toString('base64url')
  return `v1.${encoded}.${signature}`
}

function verifier() {
  return createHumanAuthVerifier({
    issuers: {
      'clinical-identity': {
        publicKey: pair.publicKey,
        reviewerIds: ['reviewer-01'],
      },
    },
    now: () => now,
  })
}

function request(value = header()) {
  return {
    header: value,
    workspaceId: 'ws_01',
    campaignId: 'rc_01',
    action: 'approve' as const,
    body,
  }
}

describe('trusted human proof verifier', () => {
  test('verifies a configured issuer and reviewer with exact body/scope binding', () => {
    expect(verifier()(request())).toEqual({
      reviewerId: 'reviewer-01',
      proofId: 'proof-01',
      issuer: 'clinical-identity',
      verifiedAt: now,
    })
  })

  test.each([
    [
      'tampered signature',
      () => {
        const value = header()
        const [version, payload, signature] = value.split('.')
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
        const first = signature![0]!
        const replacement = alphabet[(alphabet.indexOf(first) + 1) % alphabet.length]!
        return {
          ...request(),
          header: `${version}.${payload}.${replacement}${signature!.slice(1)}`,
        }
      },
    ],
    ['wrong workspace', () => ({ ...request(), workspaceId: 'ws_other' })],
    ['wrong campaign', () => ({ ...request(), campaignId: 'rc_other' })],
    ['wrong action', () => ({ ...request(), action: 'revoke' as const })],
    ['body mismatch', () => ({ ...request(), body: { ...body, reviewerNote: 'altered' } })],
    ['expired', () => request(header(claims({ expiresAt: now - 1 })))],
    [
      'future issued',
      () => request(header(claims({ issuedAt: now + 30_001, expiresAt: now + 60_001 }))),
    ],
    ['unknown issuer', () => request(header(claims({ issuer: 'unknown' })))],
    ['unknown reviewer', () => request(header(claims({ reviewerId: 'not-allowed' })))],
  ])('rejects %s', (_name, make) => {
    expect(verifier()(make())).toBeNull()
  })

  test('rejects bearer-shaped and noncanonical payloads rather than treating them as app authentication', () => {
    expect(verifier()({ ...request(), header: `Bearer ${header()}` })).toBeNull()
    const encoded = Buffer.from(JSON.stringify(claims())).toString('base64url')
    const signature = sign(null, Buffer.from(encoded), pair.privateKey).toString('base64url')
    expect(verifier()({ ...request(), header: `v1.${encoded}.${signature}` })).toBeNull()
    const valid = header().split('.')
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const last = valid[2]!.at(-1)!
    const index = alphabet.indexOf(last)
    const alternate = alphabet[Math.floor(index / 16) * 16 + ((index + 1) % 16)]!
    expect(
      verifier()({
        ...request(),
        header: `${valid[0]}.${valid[1]}.${valid[2]!.slice(0, -1)}${alternate}`,
      }),
    ).toBeNull()
  })

  test('configuration errors throw once while proof replay remains a ledger concern', () => {
    expect(() =>
      createHumanAuthVerifier({ issuers: { bad: { publicKey: 'not-a-key', reviewerIds: [] } } }),
    ).toThrow()
    const proof = verifier()(request())
    expect(proof?.proofId).toBe('proof-01')
    // This stateless verifier intentionally accepts the same signed proof again; store consumes it atomically.
    expect(verifier()(request())).toEqual(proof)
  })

  test('JSON objects cannot impersonate a native public KeyObject at startup', () => {
    const config = JSON.parse(
      '{"issuers":{"clinical-identity":{"publicKey":{"type":"public"},"reviewerIds":["reviewer-01"]}}}',
    )
    expect(() => createHumanAuthVerifier(config)).toThrow('issuer public key')
    expect(() =>
      createHumanAuthVerifier({
        issuers: {
          'clinical-identity': { publicKey: pair.privateKey, reviewerIds: ['reviewer-01'] },
        },
      }),
    ).toThrow('issuer public key')
    const serialized = createHumanAuthVerifier({
      issuers: {
        'clinical-identity': {
          publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          reviewerIds: ['reviewer-01'],
        },
      },
      now: () => now,
    })
    expect(serialized(request())).toEqual(verifier()(request()))
  })
})
