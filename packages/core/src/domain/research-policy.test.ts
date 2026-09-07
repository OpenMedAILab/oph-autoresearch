/** Coverage: research-policy.ts restricted clinical capability boundary. */

import { describe, expect, test } from 'bun:test'
import {
  decideResearchCapability,
  RESTRICTED_RESEARCH_CAPABILITY_DENIED,
} from './research-policy.ts'

describe('research execution boundary', () => {
  test('standard preserves every existing capability', () => {
    expect(decideResearchCapability('standard', 'shell')).toEqual({ allowed: true })
    expect(decideResearchCapability('standard', 'unknown-future-capability')).toEqual({
      allowed: true,
    })
  })

  test('restricted clinical mode allows only the non-data policy surface', () => {
    expect(decideResearchCapability('restricted-clinical', 'policy-status')).toEqual({
      allowed: true,
    })
    for (const capability of [
      'model-execution',
      'raw-file',
      'ssh',
      'shell',
      'cli',
      'network',
      'plugin',
      'mcp',
      'skill-load',
      'unknown-future-capability',
    ]) {
      expect(decideResearchCapability('restricted-clinical', capability)).toEqual({
        allowed: false,
        message: RESTRICTED_RESEARCH_CAPABILITY_DENIED,
      })
    }
  })
})
