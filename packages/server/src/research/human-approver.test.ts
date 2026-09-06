import { expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { createHumanApprover } from './human-approver.ts'
import { createHumanAuthVerifier } from './human-auth.ts'

test('independent console requires its own session, rejects cross-origin signing and binds exact body', async () => {
  const pair = generateKeyPairSync('ed25519')
  const service = createHumanApprover({
    issuer: 'test',
    reviewerId: 'human',
    privateKey: pair.privateKey,
  })
  try {
    const token = new URLSearchParams(new URL(service.sessionUrl).hash.slice(1)).get('session')!
    const body = { expectedVersion: 2, bundleHash: 'frozen' }
    const input = {
      workspaceId: 'workspace-1',
      campaignId: 'campaign-1',
      action: 'approve' as const,
      body,
    }
    const request = (headers: Record<string, string>) =>
      fetch(`${service.origin}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: service.origin, ...headers },
        body: JSON.stringify(input),
      })
    expect((await request({ authorization: 'Bearer application-token' })).status).toBe(403)
    expect((await request({ authorization: `Bearer ${token}` })).status).toBe(403)
    const session = await fetch(`${service.origin}/session`, {
      method: 'POST',
      headers: { origin: service.origin, authorization: `Bearer ${token}` },
    })
    expect(session.status).toBe(204)
    expect(session.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict')
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!
    expect((await request({ cookie, origin: 'https://unrelated.example' })).status).toBe(403)
    const response = await request({ cookie })
    expect(response.ok).toBe(true)
    const { proof } = (await response.json()) as { proof: string }
    const verify = createHumanAuthVerifier({
      issuers: { test: { publicKey: pair.publicKey, reviewerIds: ['human'] } },
    })
    expect(verify({ ...input, header: proof })?.reviewerId).toBe('human')
    expect(verify({ ...input, header: proof, body: { expectedVersion: 3 } })).toBeNull()
  } finally {
    service.close()
  }
})
