/** Contracts at the producer boundary; reference provenance remains with document registration. */
import { parseTerminalJson, type WorkflowAgentNode } from '@oph-autoresearch/core'
import { validateStudyStructure } from './research-documents.ts'
import { validateKnowledge } from './research-knowledge.ts'

export const ANALYSIS_GUIDE = {
  decision: 'accept | iterate | stop',
  summary: 'Evidence and reason for recommendation',
  findings: [
    {
      metric: 'Endpoint',
      expected: 'Frozen expectation',
      observed: 'Measured or unknown',
      interpretation: 'Evidence-constrained interpretation',
      confidence: 'Uncertainty or unknown',
    },
  ],
  next_experiment: {
    changes: ['Minimal changes; object required only for iterate, otherwise null'],
    rationale: 'Supporting evidence',
    estimated_cost: 'Resource/time estimate with currency; unknown if unavailable',
  },
  pitfalls_added: ['Registered pitfall IDs'],
  limitations: ['Missing evidence / usage not reported'],
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function fields(value: Record<string, unknown>, keys: string[]) {
  const missing = keys.filter((key) => !Object.hasOwn(value, key))
  const extra = Object.keys(value).filter((key) => !keys.includes(key))
  if (missing.length || extra.length)
    throw new Error(
      `Invalid fields: missing [${missing.join(', ')}]; unexpected [${extra.join(', ')}]`,
    )
}
function text(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${field} must be nonempty text (or unknown)`)
}
function texts(value: unknown, field: string, nonempty = false) {
  if (!Array.isArray(value) || (nonempty && !value.length))
    throw new Error(`${field} must be an array`)
  for (const item of value) text(item, field)
}
export function validateAnalysis(document: Record<string, unknown>) {
  fields(document, Object.keys(ANALYSIS_GUIDE))
  if (!['accept', 'iterate', 'stop'].includes(String(document.decision)))
    throw new Error('Invalid decision: accept | iterate | stop')
  text(document.summary, 'summary')
  if (!Array.isArray(document.findings)) throw new Error('findings must be an array')
  for (const finding of document.findings) {
    if (!object(finding)) throw new Error('Invalid finding')
    const keys = Object.keys(ANALYSIS_GUIDE.findings[0]!)
    fields(finding, keys)
    for (const key of keys) text(finding[key], `findings.${key}`)
  }
  if (document.decision === 'iterate') {
    const next = document.next_experiment
    if (!object(next)) throw new Error('iterate requires next_experiment')
    fields(next, ['changes', 'rationale', 'estimated_cost'])
    texts(next.changes, 'next_experiment.changes', true)
    text(next.rationale, 'next_experiment.rationale')
    text(next.estimated_cost, 'next_experiment.estimated_cost')
  } else if (document.next_experiment !== null)
    throw new Error('accept / stop requires next_experiment: null')
  texts(document.pitfalls_added, 'pitfalls_added')
  texts(document.limitations, 'limitations')
}

export function validateWorkflowOutput(node: WorkflowAgentNode, output: string) {
  const document = parseTerminalJson(output)
  if (node.outputKind === 'study') validateStudyStructure(document)
  else if (node.outputKind === 'analysis') validateAnalysis(document)
  else if (node.outputKind) validateKnowledge(node.outputKind, document)
  return document
}
