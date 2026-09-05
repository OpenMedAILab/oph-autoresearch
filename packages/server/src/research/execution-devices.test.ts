import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quoteResearchDevice } from './execution-devices.ts'
import { createRemoteDaemonService } from './remote-daemon-service.ts'
import { sha256 } from './skill-lock.ts'
import { createSshDaemonClientForTest } from './ssh-daemon-client.ts'
import { fixedResearchTemplate } from './template-registry.ts'

test('two actual authorities expose slot state and select an available pinned device without submitting work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-devices-'))
  const token = 'b'.repeat(48)
  const services = ['first', 'second'].map((id) =>
    createRemoteDaemonService({
      authorityId: id,
      token,
      port: 0,
      dbPath: join(root, `${id}.sqlite`),
      outputRoot: join(root, id),
    }),
  )
  const identityFile = join(root, 'identity'),
    knownHostsFile = join(root, 'known_hosts')
  await writeFile(identityFile, 'fixture only')
  await writeFile(knownHostsFile, 'pinned fixture')
  const devices = services.map((service, index) => ({
    id: index ? 'second' : 'first',
    authority: createSshDaemonClientForTest(
      {
        host: 'fixture.example',
        user: 'runner',
        port: 22,
        identityFile,
        knownHostsFile,
        knownHostsHash: sha256('pinned fixture'),
        remotePort: service.port,
        authorityId: index ? 'second' : 'first',
        token,
      },
      async () => ({ endpoint: `http://127.0.0.1:${service.port}`, close() {} }),
    ),
  }))
  let worker: Bun.Subprocess | undefined
  try {
    const first = services[0]!.daemon
    const spec = {
      version: 1 as const,
      dispatchKey: 'occupied',
      campaignId: 'campaign',
      taskRevisionId: 'task',
      templateId: 'synthetic-summary-v1' as const,
      inputHash: fixedResearchTemplate().execute().inputHash,
      resource: { cpu: 1 as const, memoryMb: 256 },
      lease: { ownerId: 'test', token: 'lease', fence: 1, expiresAt: Date.now() + 60_000 },
    }
    first.submit(spec)
    worker = await first.launchWorker('occupied', { waitAfterClaim: true })
    for (let i = 0; i < 100 && first.query('occupied')?.status !== 'running'; i++)
      await Bun.sleep(10)
    const quote = await quoteResearchDevice(devices)
    expect(quote.selected?.id).toBe('second')
    expect(quote.selected?.backendPolicyHash).toBe(devices[1]!.authority.backendPolicyHash)
    expect(quote.observations.map((o) => o.availableSlots)).toEqual([0, 1])
    expect(quote.reservation).toBe(false)
    expect(services[1]!.daemon.pendingJobs()).toHaveLength(0)
  } finally {
    if (worker) {
      worker.kill()
      await worker.exited
    }
    for (const device of devices) device.authority.close()
    for (const service of services) service.close()
    await rm(root, { recursive: true, force: true })
  }
})
