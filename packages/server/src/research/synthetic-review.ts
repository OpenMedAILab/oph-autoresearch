import fixture from '../../../../fixtures/synthetic-summary.json'

/** A fresh machine verifier receives bytes only; no executor claims or chat context. */
export function reviewSyntheticEvidence(bytes: Uint8Array): {
  inputHash: string
  contentHash: string
  byteLength: number
  verifiedAt: number
} {
  if (bytes.byteLength > 16_384) throw new Error('合成证据超过固定大小合同')
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('合成证据必须为对象')
  const data = parsed as Record<string, unknown>
  if (
    Object.keys(data).sort().join(',') !== 'inputHash,schema,statistics' ||
    data.schema !== 'synthetic-summary-v1' ||
    data.inputHash !== fixture.inputHash
  )
    throw new Error('合成证据schema或输入版本不一致')
  const statistics = data.statistics
  if (!statistics || typeof statistics !== 'object' || Array.isArray(statistics))
    throw new Error('合成证据统计字段无效')
  const row = statistics as Record<string, unknown>
  if (
    Object.keys(row).sort().join(',') !== 'count,max,mean,min' ||
    !Object.values(row).every((value) => typeof value === 'number' && Number.isFinite(value))
  )
    throw new Error('合成证据统计字段无效')
  const values = [...fixture.input.values].sort((a, b) => a - b)
  let sum = 0
  for (const value of values) sum += value
  if (
    row.count !== values.length ||
    row.min !== values[0] ||
    row.max !== values.at(-1) ||
    row.mean !== sum / values.length
  )
    throw new Error('独立重算与合成证据不一致')
  const contentHash = `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`
  return {
    inputHash: fixture.inputHash,
    contentHash,
    byteLength: bytes.byteLength,
    verifiedAt: Date.now(),
  }
}
