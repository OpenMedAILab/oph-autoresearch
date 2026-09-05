import { expect, test } from 'bun:test'
import { executeSyntheticTemplate, SYNTHETIC_TEMPLATE } from './synthetic-template.ts'

test('fixed descriptor drives reductions and drift fails before execution', () => {
  expect(executeSyntheticTemplate([1, 3])).toEqual({ count: 2, mean: 2, min: 1, max: 3 })
  expect(() =>
    executeSyntheticTemplate([1, 3], {
      ...SYNTHETIC_TEMPLATE,
      operations: { ...SYNTHETIC_TEMPLATE.operations, mean: 'maximum' },
    }),
  ).toThrow('固定执行模板发生漂移')
})
