import { expect, test } from 'bun:test'
import { createLiteratureCollector, prepareEvidenceCitations } from './literature-evidence.ts'
import { sha256 } from './skill-lock.ts'

test('Crossref metadata enters citations with exact byte provenance and no raw abstract or external URL', async () => {
  const body = JSON.stringify({
    status: 'ok',
    message: {
      DOI: '10.1234/Retinal.Test',
      title: ['Retinal assessment'],
      published: { 'date-parts': [[2024, 2, 29]] },
      URL: 'file:///private/clinical.csv',
      abstract: 'abstract-canary-not-authorized',
      debug: { patient: 'private-debug-canary' },
    },
  })
  const requests: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname)
      return new Response(body, { headers: { 'content-type': 'application/json' } })
    },
  })
  try {
    const collect = createLiteratureCollector({ crossrefBaseUrl: server.url.href })
    const source = await collect({ doi: '10.1234/retinal.test' })
    const [citation] = prepareEvidenceCitations([source])
    expect(requests).toEqual(['/works/10.1234%2Fretinal.test'])
    expect(citation?.contentHash).toBe(sha256(body))
    expect(citation?.publishedAt).toBe('2024-02-29')
    expect(citation?.url).toBe('https://doi.org/10.1234%2Fretinal.test')
    expect(citation?.fullText).toBe(false)
    expect(citation?.locator.pointer).toBe('/message')
    expect(JSON.stringify(citation)).not.toContain('canary')
    expect(JSON.stringify(citation)).not.toContain('file:')
    expect(() => prepareEvidenceCitations([structuredClone(source)])).toThrow('not verified')
    expect(() => prepareEvidenceCitations([source, source])).toThrow('Duplicate')
  } finally {
    server.stop(true)
  }
})

test('PubMed uses numeric identifiers and preserves missing publication dates as unknown', async () => {
  let requestUrl = ''
  let calls = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      calls++
      requestUrl = request.url
      return Response.json({
        result: {
          uids: ['12345'],
          '12345': {
            uid: '12345',
            title: 'Public study',
            articleids: [{ idtype: 'uri', value: 'javascript:bad' }],
            abstract: 'raw-abstract-canary',
          },
        },
      })
    },
  })
  try {
    const collect = createLiteratureCollector({ pubmedBaseUrl: server.url.href })
    const [citation] = prepareEvidenceCitations([await collect({ pmid: '12345' })])
    const url = new URL(requestUrl)
    expect(url.pathname).toBe('/esummary.fcgi')
    expect(url.searchParams.get('db')).toBe('pubmed')
    expect(url.searchParams.get('id')).toBe('12345')
    expect(citation?.publishedAt).toBeNull()
    expect(citation?.url).toBe('https://pubmed.ncbi.nlm.nih.gov/12345/')
    expect(JSON.stringify(citation)).not.toContain('canary')
    for (const input of [
      { pmid: 'patient name and diagnosis' },
      { pmid: '12345&db=other' },
      { doi: 'https://doi.org/10.1234/a' },
      { doi: '10.1234/a', url: 'https://evil.test' },
    ])
      await expect(collect(input)).rejects.toThrow()
    expect(calls).toBe(1)
  } finally {
    server.stop(true)
  }
})

test('redirect, mismatched identity, malformed publication dates and oversized responses fail closed', async () => {
  let mode = 'redirect'
  let redirected = false
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/sink') redirected = true
      if (mode === 'redirect')
        return new Response(null, { status: 302, headers: { location: '/sink' } })
      if (mode === 'oversized') return new Response('x'.repeat(1_000_001))
      return Response.json({
        status: 'ok',
        message: {
          DOI: mode === 'mismatch' ? '10.1234/different' : '10.1234/test',
          title: ['Study'],
          published: { 'date-parts': [[2023, 2, 29]] },
        },
      })
    },
  })
  try {
    const collect = createLiteratureCollector({ crossrefBaseUrl: server.url.href })
    for (const next of ['redirect', 'oversized', 'mismatch', 'date']) {
      mode = next
      await expect(collect({ doi: '10.1234/test' })).rejects.toThrow()
    }
    expect(redirected).toBe(false)
    for (const endpoint of [
      'https://evil.test/',
      'https://api.crossref.org.evil.test/',
      'https://key@api.crossref.org/',
      'https://api.crossref.org/?key=secret',
    ])
      expect(() => createLiteratureCollector({ crossrefBaseUrl: endpoint })).toThrow()
  } finally {
    server.stop(true)
  }
})
