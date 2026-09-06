/** Client used by a native CLI only when its parent injected a scoped bridge. */
const OPERATIONS = new Set([
  'prepare',
  'propose',
  'submit',
  'status',
  'events',
  'cancel',
  'reconcile',
  'receipt',
  'request_review',
  'documents/read',
  'record_document/write',
  'cli_preparation/propose',
  'cli_preparation/submit',
  'cli_preparation/status',
  'cli_preparation/cancel',
  'cli_preparation/reconcile',
  'cli_preparation/catalog',
])

export async function runResearchControl(args: string[]): Promise<number> {
  const operation = args[0]
  const campaignAt = args.indexOf('--campaign')
  const bodyAt = args.indexOf('--body')
  const endpoint = process.env.OPH_RESEARCH_CONTROL_ENDPOINT
  const token = process.env.OPH_RESEARCH_CONTROL_TOKEN
  const allowed = new Set(
    (process.env.OPH_RESEARCH_CONTROL_CAMPAIGNS ?? '').split(',').filter(Boolean),
  )
  const campaignId = campaignAt >= 0 ? args[campaignAt + 1] : undefined
  if (!operation || !OPERATIONS.has(operation) || !endpoint || !token) {
    process.stderr.write('此命令只能由受控原生 CLI 会话调用。\n')
    return 2
  }
  if (campaignId && !allowed.has(campaignId)) {
    process.stderr.write('campaign 不在本轮受控范围内。\n')
    return 2
  }
  let body: unknown
  if (bodyAt >= 0) {
    try {
      body = JSON.parse(args[bodyAt + 1] ?? '')
    } catch {
      process.stderr.write('--body 必须是 JSON。\n')
      return 2
    }
  }
  const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/research/control`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      operation,
      ...(campaignId ? { campaignId } : {}),
      ...(body === undefined ? {} : { body }),
    }),
  })
  process.stdout.write(`${await response.text()}\n`)
  return response.ok ? 0 : 1
}
