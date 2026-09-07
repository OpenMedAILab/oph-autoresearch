import { canonicalJson, sha256 } from './skill-lock.ts'

export interface EvidenceSource {
  id: string
  doi?: string
  pmid?: string
  url: string
  title: string
  publishedAt: string | null
  sourceKind: 'public-metadata'
  retrievedAt: number
  contentHash: string
  locator: { schema: 'crossref-work-v1' | 'pubmed-summary-v1'; pointer: string; endpoint: string }
}
export interface EvidenceCitation extends EvidenceSource {
  projectionHash: string
  verification: 'retrieved-public-metadata'
  fullText: false
}
const verified = new WeakMap<EvidenceSource, string>()
const CROSSREF = 'https://api.crossref.org/'
const PUBMED = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/'
const MAX_BYTES = 1_000_000

function endpoint(configured: string | undefined, official: string): string {
  const url = new URL(configured ?? official)
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Literature endpoint has unsupported routing data')
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (url.href !== official && !(loopback && ['http:', 'https:'].includes(url.protocol)))
    throw new Error('Literature endpoint must be official or a loopback fixture')
  return url.href.endsWith('/') ? url.href : `${url.href}/`
}
function doi(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 200 ||
    !/^10\.\d{4,9}\/[-a-zA-Z0-9._;()/:]+$/.test(value)
  )
    throw new Error('A normalized DOI identifier is required')
  return value.toLowerCase()
}
function pmid(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value))
    throw new Error('A numeric PMID identifier is required')
  return value
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid literature metadata object')
  return value as Record<string, unknown>
}
function title(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 2_000 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 && ![9, 10, 13].includes(code)
    })
  )
    throw new Error('Invalid literature title')
  return value.trim()
}
function crossrefDate(value: unknown): string | null {
  if (value === undefined) return null
  const parts = record(value)['date-parts']
  if (!Array.isArray(parts) || parts.length !== 1 || !Array.isArray(parts[0]))
    throw new Error('Invalid publication date')
  const date = parts[0] as unknown[]
  if (date.length < 1 || date.length > 3 || date.some((part) => !Number.isSafeInteger(part)))
    throw new Error('Invalid publication date')
  const [year, month = 1, day = 1] = date as number[]
  if (!year || year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31)
    throw new Error('Invalid publication date')
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day)
    throw new Error('Invalid publication date')
  return date.map((part, index) => String(part).padStart(index ? 2 : 4, '0')).join('-')
}
async function readBounded(response: Response): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error('Public metadata service did not return data')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_BYTES) throw new Error('Public metadata exceeds size limit')
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Public metadata only. Model supplied strings are identifiers, never URLs or search queries.
 * Endpoint overrides are startup configuration for loopback integration tests only.
 */
export function createLiteratureCollector(
  options: { crossrefBaseUrl?: string; pubmedBaseUrl?: string } = {},
) {
  const crossref = endpoint(options.crossrefBaseUrl, CROSSREF)
  const pubmed = endpoint(options.pubmedBaseUrl, PUBMED)
  return async (identifier: { doi: string } | { pmid: string }): Promise<EvidenceSource> => {
    const input = record(identifier)
    if (Object.keys(input).length !== 1) throw new Error('Exactly one DOI or PMID is required')
    const isDoi = Object.hasOwn(input, 'doi')
    const id = isDoi ? doi(input.doi) : pmid(input.pmid)
    const url = isDoi
      ? new URL(`works/${encodeURIComponent(id)}`, crossref)
      : new URL('esummary.fcgi', pubmed)
    if (!isDoi) {
      url.searchParams.set('db', 'pubmed')
      url.searchParams.set('retmode', 'json')
      url.searchParams.set('id', id)
    }
    let bytes: Uint8Array
    let body: Record<string, unknown>
    try {
      const response = await fetch(url, {
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      bytes = await readBounded(response)
      body = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    } catch {
      throw new Error('Public literature metadata retrieval failed')
    }
    let source: EvidenceSource
    if (isDoi) {
      const work = record(body.message)
      if (body.status !== 'ok' || doi(work.DOI) !== id)
        throw new Error('Public metadata identifier mismatch')
      if (!Array.isArray(work.title) || work.title.length < 1 || work.title.length > 8)
        throw new Error('Invalid literature title list')
      source = {
        id: crypto.randomUUID(),
        doi: id,
        url: `https://doi.org/${encodeURIComponent(id)}`,
        title: title(work.title[0]),
        publishedAt: crossrefDate(work.published),
        sourceKind: 'public-metadata',
        retrievedAt: Date.now(),
        contentHash: sha256(bytes),
        locator: { schema: 'crossref-work-v1', pointer: '/message', endpoint: url.href },
      }
    } else {
      const result = record(body.result)
      if (!Array.isArray(result.uids) || result.uids.length !== 1 || result.uids[0] !== id)
        throw new Error('Public metadata identifier mismatch')
      const article = record(result[id])
      if (article.uid !== id) throw new Error('Public metadata identifier mismatch')
      const date = article.pubdate
      if (date !== undefined && (typeof date !== 'string' || !/^[A-Za-z0-9 .,-]{1,80}$/.test(date)))
        throw new Error('Invalid publication date')
      source = {
        id: crypto.randomUUID(),
        pmid: id,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        title: title(article.title),
        publishedAt: typeof date === 'string' ? date : null,
        sourceKind: 'public-metadata',
        retrievedAt: Date.now(),
        contentHash: sha256(bytes),
        locator: { schema: 'pubmed-summary-v1', pointer: `/result/${id}`, endpoint: url.href },
      }
    }
    Object.freeze(source.locator)
    Object.freeze(source)
    verified.set(source, canonicalJson(source))
    return source
  }
}

/** Only sources returned by a verified collector in this process can enter a new pack.
 * Persist the returned citation in the campaign authority; do not recreate admission
 * from arbitrary request JSON. Metadata text remains untrusted quoted evidence.
 */
export function prepareEvidenceCitations(sources: readonly EvidenceSource[]): EvidenceCitation[] {
  if (sources.length < 1 || sources.length > 32) throw new Error('Expected 1–32 literature sources')
  const seen = new Set<string>()
  return sources.map((source) => {
    const captured = verified.get(source)
    if (!captured || canonicalJson(source) !== captured)
      throw new Error('Literature source was not verified by a trusted collector')
    const key = source.doi ? `doi:${source.doi}` : `pmid:${source.pmid}`
    if (seen.has(key)) throw new Error('Duplicate literature identifier')
    seen.add(key)
    return {
      ...source,
      locator: { ...source.locator },
      projectionHash: sha256(captured),
      verification: 'retrieved-public-metadata',
      fullText: false,
    }
  })
}
