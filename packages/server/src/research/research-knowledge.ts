/** Knowledge records use the existing immutable document and campaign artifact store. */
export const KNOWLEDGE_KINDS = ['evidence', 'venue', 'reviewcase', 'handoff', 'peerreview'] as const
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number]
export const isKnowledgeKind = (kind: string): kind is KnowledgeKind =>
  KNOWLEDGE_KINDS.includes(kind as KnowledgeKind)

export const KNOWLEDGE_GUIDE = {
  evidence: {
    key: 'stable-paper-key',
    title: 'Paper title',
    url: 'https://...',
    retrievedAt: 'ISO date',
    readingDepth: 'metadata | abstract | partial-full-text | full-text',
    license: 'unknown or stated reuse terms',
    segments: [
      { locator: 'section / paragraph / page', text: 'Located content, not a search snippet' },
    ],
    previousVersion: null,
  },
  venue: {
    key: 'stable-venue-edition-track-key',
    name: 'Journal or conference',
    venueType: 'journal | conference',
    year: null,
    track: null,
    officialUrl: 'https://...',
    fit: 'Reasons and limitations',
    rules: [
      {
        text: 'Requirement',
        url: 'https://official-source',
        retrievedAt: 'ISO date',
        publishedAt: null,
      },
    ],
    exemplars: [
      {
        evidenceKey: 'paper-key',
        reason: 'Relevance / high citation / recent',
        citationCount: null,
        citationSource: null,
        citationCheckedAt: null,
      },
    ],
    writingInferences: [
      {
        text: 'Observed writing practice, not an official requirement',
        evidenceKeys: ['paper-key'],
      },
    ],
    unknowns: ['Unverified requirement'],
    previousVersion: null,
  },
  reviewcase: {
    key: 'stable-review-case-key',
    paperGroup: 'same-paper-all-versions',
    manuscriptVersion: 'version under review',
    venue: 'Venue',
    round: 1,
    manuscript: 'Text',
    review: 'Review text',
    source: 'https://public-source or user provided reference',
    sourceKind: 'public-real | user-declared | synthetic',
    usage: 'local-only | model-context',
    split: 'train | validation | test',
    deidentified: true,
    license: 'Permission scope',
    previousVersion: null,
  },
  handoff: {
    key: 'experiment-preparation',
    studyHash: 'Confirmed study content hash',
    summary: 'Preparation actually performed',
    tasks: ['Experiment tasks'],
    expectedOutputs: ['Required outputs'],
    blockers: ['Missing executor or requirements'],
    previousVersion: null,
  },
  peerreview: {
    key: 'manuscript-review',
    manuscriptHash: 'Current manuscript content hash',
    reviews: [
      {
        role: 'contribution | methods | evidence',
        locator: 'Section / claim',
        priority: 'major | minor',
        comment: 'Finding',
        suggestion: 'Actionable revision',
      },
    ],
    revisionRound: 1,
    previousVersion: null,
  },
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function requireText(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100_000)
    throw new Error(`Missing or invalid ${label}`)
}
function date(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error('Source date is required')
}
function url(value: unknown) {
  requireText(value, 'source URL')
  const parsed = new URL(value as string)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error('Invalid source URL')
}
function rows(value: unknown, label: string, nonempty = false): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    (nonempty && !value.length) ||
    !value.every(record)
  )
    throw new Error(`Invalid ${label}`)
  return value
}
function texts(value: unknown, label: string, nonempty = false): string[] {
  if (!Array.isArray(value) || value.length > 256 || (nonempty && !value.length))
    throw new Error(`Invalid ${label}`)
  value.forEach((entry) => {
    requireText(entry, label)
  })
  return value as string[]
}
export function knowledgeKey(document: Record<string, unknown>): string {
  if (typeof document.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(document.key))
    throw new Error('A stable document key is required')
  return document.key
}
export function validateKnowledge(kind: KnowledgeKind, document: Record<string, unknown>) {
  knowledgeKey(document)
  const expected = Object.keys(KNOWLEDGE_GUIDE[kind]).sort().join(',')
  if (Object.keys(document).sort().join(',') !== expected)
    throw new Error(`Invalid ${kind} fields; read context documentSchemas`)
  if (kind === 'evidence') {
    requireText(document.title, 'title')
    url(document.url)
    date(document.retrievedAt)
    requireText(document.license, 'license or unknown')
    if (
      !['metadata', 'abstract', 'partial-full-text', 'full-text'].includes(
        String(document.readingDepth),
      )
    )
      throw new Error('Invalid reading depth')
    const segments = rows(
      document.segments,
      'evidence segments',
      document.readingDepth !== 'metadata',
    )
    for (const segment of segments) {
      requireText(segment.locator, 'locator')
      requireText(segment.text, 'segment text')
    }
  } else if (kind === 'venue') {
    requireText(document.name, 'venue name')
    url(document.officialUrl)
    requireText(document.fit, 'fit')
    if (!['journal', 'conference'].includes(String(document.venueType)))
      throw new Error('Invalid venue type')
    if (
      document.venueType === 'conference' &&
      (!Number.isSafeInteger(document.year) || !document.track)
    )
      throw new Error('Conference edition and track are required')
    for (const rule of rows(document.rules, 'official rules')) {
      requireText(rule.text, 'rule')
      url(rule.url)
      date(rule.retrievedAt)
      if (rule.publishedAt !== null) date(rule.publishedAt)
    }
    for (const exemplar of rows(document.exemplars, 'exemplars')) {
      requireText(exemplar.evidenceKey, 'evidence key')
      requireText(exemplar.reason, 'selection reason')
      if (exemplar.citationCount !== null) {
        if (!Number.isSafeInteger(exemplar.citationCount) || Number(exemplar.citationCount) < 0)
          throw new Error('Invalid citation count')
        requireText(exemplar.citationSource, 'citation provider')
        date(exemplar.citationCheckedAt)
      } else if (exemplar.citationSource !== null || exemplar.citationCheckedAt !== null)
        throw new Error('Unknown citation count must stay null')
    }
    for (const inference of rows(document.writingInferences, 'writing inferences')) {
      requireText(inference.text, 'inference')
      texts(inference.evidenceKeys, 'inference evidence', true)
    }
    texts(document.unknowns, 'unknowns')
  } else if (kind === 'reviewcase') {
    for (const key of [
      'paperGroup',
      'manuscriptVersion',
      'venue',
      'manuscript',
      'review',
      'source',
      'license',
    ])
      requireText(document[key], key)
    if (
      !Number.isSafeInteger(document.round) ||
      Number(document.round) < 1 ||
      document.deidentified !== true ||
      !['public-real', 'user-declared', 'synthetic'].includes(String(document.sourceKind)) ||
      !['local-only', 'model-context'].includes(String(document.usage)) ||
      !['train', 'validation', 'test'].includes(String(document.split))
    )
      throw new Error('Invalid review case provenance or use scope')
  } else if (kind === 'handoff') {
    requireText(document.studyHash, 'study hash')
    requireText(document.summary, 'preparation summary')
    texts(document.tasks, 'tasks', true)
    texts(document.expectedOutputs, 'outputs', true)
    texts(document.blockers, 'blockers')
  } else {
    requireText(document.manuscriptHash, 'manuscript hash')
    if (document.revisionRound !== 1)
      throw new Error('The default review preset allows one revision round')
    for (const review of rows(document.reviews, 'reviews', true)) {
      for (const key of ['role', 'locator', 'comment', 'suggestion']) requireText(review[key], key)
      if (!['major', 'minor'].includes(String(review.priority)))
        throw new Error('Invalid review priority')
    }
  }
}
