import { expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OphConfig } from '@oph-autoresearch/runtime'
import { Store } from '@oph-autoresearch/store'
import { type ServeOptions, serve } from '../server.ts'
import {
  captureResearchDeployment,
  type ResearchDeploymentManifest,
} from './deployment-governance.ts'
import { sha256 } from './skill-lock.ts'

function fixture() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const humanAuth = { issuers: { institution: { publicKey, reviewerIds: ['reviewer'] } } }
  const manifest: ResearchDeploymentManifest = {
    schema: 'research-deployment-v1',
    organizationId: 'local-test-only',
    boundary: 'restricted-clinical',
    bindHost: '127.0.0.1',
    reviewerKeyHashes: { institution: sha256(publicKey.export({ type: 'spki', format: 'der' })) },
    allowDaemon: false,
    allowPublicMetadata: false,
  }
  const launch = {
    host: '127.0.0.1',
    boundary: 'restricted-clinical' as const,
    humanAuth,
    requireApproval: true,
    daemonConfigured: false,
  }
  return { humanAuth, manifest, launch }
}
test('administrator contract denies key drift, network widening, boundary downgrade and capability mismatch', () => {
  const { manifest, launch } = fixture()
  expect(captureResearchDeployment(manifest, launch)).toMatchObject({
    clinicalAcceptance: false,
    immutable: true,
    contractHash: expect.stringMatching(/^sha256:/),
  })
  for (const delta of [
    { host: '0.0.0.0' },
    { boundary: 'standard' as const },
    { requireApproval: false },
    { daemonConfigured: true },
    { humanAuth: fixture().humanAuth },
  ]) {
    expect(() => captureResearchDeployment(manifest, { ...launch, ...delta })).toThrow()
  }
  expect(() => captureResearchDeployment({ ...manifest, hiddenCapability: true }, launch)).toThrow()
})
test('actual server captures deployment contract, requires authentication and blocks runtime LAN widening', async () => {
  const { manifest, humanAuth } = fixture()
  const root = mkdtempSync(join(tmpdir(), 'oph-deployment-'))
  const store = new Store({ path: ':memory:' })
  const config: OphConfig = {
    active: { provider: 'test', model: 'test' },
    mode: 'auto',
    providers: {},
  }
  const app = serve({
    store,
    config,
    workspaceRoot: root,
    host: '127.0.0.1',
    port: 0,
    researchBoundary: 'restricted-clinical',
    researchHumanAuth: humanAuth,
    researchDeployment: manifest,
  })
  try {
    const url = `http://127.0.0.1:${app.port}/api/research/deployment`
    expect((await fetch(url)).status).toBe(401)
    manifest.organizationId = 'mutated-after-start'
    manifest.allowPublicMetadata = true
    const status = await (
      await fetch(url, { headers: { authorization: `Bearer ${app.token}` } })
    ).json()
    expect(status).toMatchObject({
      deployment: {
        organizationId: 'local-test-only',
        allowPublicMetadata: false,
        clinicalAcceptance: false,
        infrastructureAcceptance: 'external-evidence-required',
      },
    })
    expect(() => app.enableLan()).toThrow('forbids widening')
    expect(app.lanEnabled()).toBe(false)
    const denied = await fetch(`http://127.0.0.1:${app.port}/api/research/campaigns`, {
      method: 'POST',
      headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(denied.status).toBe(403)
  } finally {
    app.stop()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('daemon-disabled deployment rejects both CLI preparation authority injection and SSH configuration before constructing either', () => {
  const { manifest, humanAuth } = fixture()
  const store = new Store({ path: ':memory:' })
  let authorityAccessed = false
  const base = {
    store,
    config: { active: { provider: 'test', model: 'test' }, mode: 'auto', providers: {} },
    workspaceRoot: '.',
    host: '127.0.0.1',
    port: 0,
    researchBoundary: 'standard',
    researchHumanAuth: humanAuth,
    researchDeployment: { ...manifest, boundary: 'standard' },
  } satisfies ServeOptions
  const common = {
    id: 'fixture',
    label: 'Fixture',
    deviceId: 'fixture-device',
    adapterId: 'fixture-adapter',
    model: 'fixture',
    adapterConfigHash: `sha256:${'a'.repeat(64)}`,
  }
  const authority = {
    get backendPolicyHash(): string {
      authorityAccessed = true
      throw new Error('must not construct execution authority')
    },
    identity() {
      throw new Error('must not read authority identity')
    },
    closeUnstarted() {
      throw new Error('must not close authority job')
    },
    submit() {
      throw new Error('must not submit')
    },
    query() {
      throw new Error('must not query')
    },
    cancel() {
      throw new Error('must not cancel')
    },
    receipt() {
      throw new Error('must not read receipt')
    },
  }
  try {
    for (const route of [
      { ...common, authority },
      {
        ...common,
        config: {
          host: 'fixture.example.org',
          user: 'fixture',
          port: 22,
          identityFile: '/not-used/key',
          knownHostsFile: '/not-used/known-hosts',
          knownHostsHash: `sha256:${'b'.repeat(64)}`,
          remotePort: 12345,
          token: 'fixture-not-a-credential',
          authorityId: 'fixture-authority',
        },
      },
    ]) {
      expect(() =>
        serve({
          ...base,
          researchCliPreparation: [route],
        }),
      ).toThrow('Deployment launch does not match')
    }
    expect(() => serve({ ...base, researchFormalExecution: [{ authority } as never] })).toThrow(
      'Deployment launch does not match',
    )
    expect(authorityAccessed).toBe(false)
  } finally {
    store.close()
  }
})
