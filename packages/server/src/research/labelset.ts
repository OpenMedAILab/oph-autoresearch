import { canonicalLabelSetReference, type LabelSetReference } from '@oph-autoresearch/core'
import { sha256 } from './skill-lock.ts'

export {
  changeImpact,
  type DependencyEdge,
  type LabelSetReference,
  validateLabelSetReference,
  validateLabelSetSuccessor,
} from '@oph-autoresearch/core'
export function canonicalLabelSetHash(reference: LabelSetReference): string {
  return sha256(canonicalLabelSetReference(reference))
}
