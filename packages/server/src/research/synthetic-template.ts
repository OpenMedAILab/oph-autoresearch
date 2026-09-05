import { canonicalJson, sha256 } from './skill-lock.ts'

/** This descriptor drives the fixed interpreter, rather than describing separate executable code. */
export const SYNTHETIC_TEMPLATE = Object.freeze({
  id: 'synthetic-summary-v1',
  interpreter: 'finite-reductions-v1',
  operations: Object.freeze({
    count: 'length',
    mean: 'arithmetic-mean',
    min: 'minimum',
    max: 'maximum',
  }),
})
export const SYNTHETIC_TEMPLATE_HASH =
  'sha256:f22d82a6f1fae9a03072a5e6a8abf403e73cc7f07b2648132f62fbd862bec5f4'

export function executeSyntheticTemplate(
  values: readonly number[],
  descriptor: unknown = SYNTHETIC_TEMPLATE,
): { count: number; mean: number; min: number; max: number } {
  if (sha256(canonicalJson(descriptor)) !== SYNTHETIC_TEMPLATE_HASH)
    throw new Error('固定执行模板发生漂移')
  if (!values.length || !values.every(Number.isFinite)) throw new Error('合成输入必须为有限数值')
  const output: Record<string, number> = {}
  for (const [field, operation] of Object.entries(
    (descriptor as typeof SYNTHETIC_TEMPLATE).operations,
  )) {
    switch (operation) {
      case 'length':
        output[field] = values.length
        break
      case 'arithmetic-mean':
        output[field] = values.reduce((sum, value) => sum + value, 0) / values.length
        break
      case 'minimum':
        output[field] = Math.min(...values)
        break
      case 'maximum':
        output[field] = Math.max(...values)
        break
      default:
        throw new Error('不支持的合成运算')
    }
  }
  if (!Object.values(output).every(Number.isFinite)) throw new Error('合成结果非有限')
  return { count: output.count!, mean: output.mean!, min: output.min!, max: output.max! }
}
