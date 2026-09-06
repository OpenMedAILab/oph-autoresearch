import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHumanApprover } from '../packages/server/src/research/human-approver.ts'

const root = resolve(Bun.argv[2] ?? '.tmp/research-approver')
mkdirSync(root, { recursive: true, mode: 0o700 })
const keyPath = `${root}/private-key.pem`
if (!(await Bun.file(keyPath).exists())) {
  const pair = generateKeyPairSync('ed25519')
  writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
    flag: 'wx',
  })
}
chmodSync(keyPath, 0o600)
const privateKey = createPrivateKey(await Bun.file(keyPath).text())
const service = createHumanApprover({
  issuer: 'local-developer',
  reviewerId: 'local-human',
  privateKey,
  port: 7728,
})
const { createPublicKey } = await import('node:crypto')
writeFileSync(
  `${root}/public-config.json`,
  `${JSON.stringify({ approvalUrl: service.origin, issuers: { 'local-developer': { publicKey: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }), reviewerIds: ['local-human'] } } }, null, 2)}\n`,
  { mode: 0o600 },
)
console.log(`独立审批会话（请勿转发）：${service.sessionUrl}`)
console.log(`应用启动增加 --research-human-auth ${root}/public-config.json`)
process.once('SIGINT', () => {
  service.close()
  process.exit(0)
})
