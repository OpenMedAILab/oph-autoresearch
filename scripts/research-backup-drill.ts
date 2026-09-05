import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getResearchCampaign, listResearchEvents, Store } from '@oph-autoresearch/store'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const FORBIDDEN_ARTIFACT_NAME =
  /(?:^|[._-])(?:key|token|secret|credential|private)(?:[._-]|$)|\.pem$|\.p12$|\.pfx$/i

export interface ResearchBackupDrillInput {
  /** Must be a temporary or fixture SQLite database, never the user ledger. */
  sourceDbPath: string
  /** Explicit fixture artifact root. Files are copied only from artifactFiles. */
  sourceArtifactRoot: string
  artifactFiles: readonly string[]
  campaignIds: readonly string[]
  /** Both output roots must be new paths. The drill refuses existing directories. */
  backupRoot: string
  restoreRoot: string
}

export interface ResearchBackupDrillResult {
  backupDbHash: string
  artifactHashes: Record<string, string>
  campaignHashes: Record<string, string>
  manifestHash: string
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function isFixturePath(path: string): boolean {
  return resolve(path)
    .split(/[\\/]+/)
    .some((part) => part === '.tmp' || part === 'fixtures')
}

async function rejectLinkedAncestors(path: string, name: string): Promise<void> {
  let current = resolve(path)
  while (true) {
    const stat = await lstat(current).catch(() => null)
    if (!stat) throw new Error(`${name} ancestor does not exist`)
    if (stat.isSymbolicLink())
      throw new Error(`${name} contains a symbolic link or junction ancestor`)
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

async function regularFixtureFile(path: string, name: string): Promise<string> {
  if (!isFixturePath(path)) throw new Error(`${name} must be under a fixture or .tmp directory`)
  await rejectLinkedAncestors(path, name)
  const stat = await lstat(path).catch(() => null)
  if (!stat?.isFile() || stat.isSymbolicLink())
    throw new Error(`${name} must be a regular fixture file`)
  const physical = await realpath(path)
  if (!isFixturePath(physical)) throw new Error(`${name} must be under a fixture or .tmp directory`)
  return physical
}

async function fixtureDirectory(path: string, name: string): Promise<string> {
  if (!isFixturePath(path)) throw new Error(`${name} must be under a fixture or .tmp directory`)
  await rejectLinkedAncestors(path, name)
  const stat = await lstat(path).catch(() => null)
  if (!stat?.isDirectory() || stat.isSymbolicLink())
    throw new Error(`${name} must be a non-symlink fixture directory`)
  const physical = await realpath(path)
  if (!isFixturePath(physical)) throw new Error(`${name} must be under a fixture or .tmp directory`)
  return physical
}

async function newFixtureDirectory(path: string, name: string): Promise<string> {
  const requested = resolve(path)
  if (await lstat(requested).catch(() => null))
    throw new Error(`${name} must not already exist; the drill never deletes output`)
  const parent = await fixtureDirectory(dirname(requested), `${name} parent`)
  const output = join(parent, basename(requested))
  if (!isFixturePath(output)) throw new Error(`${name} must be under a fixture or .tmp directory`)
  await mkdir(output)
  return output
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`)
}

function safeArtifactPath(root: string, entry: string): string {
  if (
    !entry ||
    isAbsolute(entry) ||
    entry.split(/[\\/]+/).some((part) => part === '..' || !part) ||
    FORBIDDEN_ARTIFACT_NAME.test(entry)
  )
    throw new Error('artifact allowlist contains an unsafe or credential-like path')
  const target = resolve(root, entry)
  if (relative(root, target).startsWith('..') || target === root)
    throw new Error('artifact allowlist escapes its fixture root')
  return target
}

function campaignHash(store: Store, campaignId: string): string {
  if (!ID.test(campaignId)) throw new Error('invalid fixture campaign ID')
  const campaign = getResearchCampaign(store, campaignId)
  if (!campaign) throw new Error('fixture campaign does not exist')
  const artifactIds = new Set(campaign.artifactVersions.map((artifact) => artifact.id))
  if (
    campaign.attempts.some(
      (attempt) =>
        attempt.artifactVersionId !== null && !artifactIds.has(attempt.artifactVersionId),
    ) ||
    (campaign.modelReviews ?? []).some((review) =>
      review.artifactVersionIds.some((artifactId) => !artifactIds.has(artifactId)),
    )
  )
    throw new Error('fixture campaign contains an unbound artifact reference')
  const events = listResearchEvents(store, campaignId)
  if (events.length === 0 || canonical(events.at(-1)!.campaign) !== canonical(campaign))
    throw new Error('fixture campaign event projection is inconsistent')
  return hash(
    canonical({
      approvals: campaign.approvals,
      artifactVersions: campaign.artifactVersions,
      attempts: campaign.attempts,
      campaign,
      events,
      modelReviews: campaign.modelReviews ?? [],
    }),
  )
}

function requiredArtifactHashes(
  store: Store,
  campaignIds: readonly string[],
  artifactRoot: string,
  artifactFiles: readonly string[],
): Record<string, string> {
  const expected: Record<string, string> = {}
  for (const campaignId of campaignIds) {
    const campaign = getResearchCampaign(store, campaignId)
    if (!campaign) throw new Error('fixture campaign does not exist')
    for (const artifact of campaign.artifactVersions) {
      if (!artifact.uri.startsWith('file:'))
        throw new Error('backup drill requires file: artifact URIs under its fixture root')
      let source: string
      try {
        source = resolve(fileURLToPath(artifact.uri))
      } catch {
        throw new Error('backup drill requires valid file: artifact URIs')
      }
      const entry = relative(artifactRoot, source)
      if (safeArtifactPath(artifactRoot, entry) !== source || !artifactFiles.includes(entry))
        throw new Error('artifact allowlist does not exactly bind the ledger artifact URI')
      if (expected[entry] && expected[entry] !== artifact.contentHash)
        throw new Error('two ledger artifacts bind the same fixture file with different hashes')
      expected[entry] = artifact.contentHash
    }
  }
  if (canonical(Object.keys(expected).sort()) !== canonical([...new Set(artifactFiles)].sort()))
    throw new Error('artifact allowlist contains files not bound by the selected campaigns')
  return expected
}

async function copyArtifacts(
  sourceRoot: string,
  destinationRoot: string,
  expectedHashes: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  for (const entry of Object.keys(expectedHashes).sort()) {
    const source = safeArtifactPath(sourceRoot, entry)
    let sourceDirectory = sourceRoot
    for (const segment of entry.split(/[\\/]+/).slice(0, -1)) {
      sourceDirectory = join(sourceDirectory, segment)
      const directory = await lstat(sourceDirectory).catch(() => null)
      if (!directory?.isDirectory() || directory.isSymbolicLink())
        throw new Error('artifact source contains a linked or unsafe directory')
    }
    const stat = await lstat(source).catch(() => null)
    if (!stat?.isFile() || stat.isSymbolicLink())
      throw new Error('artifact allowlist entry is not a regular fixture file')
    let destinationDirectory = destinationRoot
    const rootDirectory = await lstat(destinationDirectory).catch(() => null)
    if (!rootDirectory) await mkdir(destinationDirectory)
    else if (!rootDirectory.isDirectory() || rootDirectory.isSymbolicLink())
      throw new Error('artifact destination contains a linked or unsafe directory')
    for (const segment of entry.split(/[\\/]+/).slice(0, -1)) {
      destinationDirectory = join(destinationDirectory, segment)
      const directory = await lstat(destinationDirectory).catch(() => null)
      if (!directory) await mkdir(destinationDirectory)
      else if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new Error('artifact destination contains a linked or unsafe directory')
    }
    const destination = safeArtifactPath(destinationRoot, entry)
    await copyFile(source, destination, 0)
    hashes[entry] = hash(await readFile(destination))
    if (hashes[entry] !== expectedHashes[entry])
      throw new Error('artifact bytes do not match the hash bound by the ledger')
  }
  return hashes
}

/**
 * Makes a consistent SQLite serialization, restores it to a new fixture directory, and compares
 * campaign/event/artifact/reference hashes. It never deletes or overwrites an existing path.
 * It verifies copied artifact bytes, but does not rewrite immutable file: URIs in the restored DB.
 */
export async function runResearchBackupDrill(
  input: ResearchBackupDrillInput,
): Promise<ResearchBackupDrillResult> {
  if (
    input.campaignIds.length === 0 ||
    new Set(input.campaignIds).size !== input.campaignIds.length
  )
    throw new Error('backup drill requires unique fixture campaign IDs')
  if (input.artifactFiles.length === 0)
    throw new Error('backup drill requires an explicit artifact allowlist')
  const sourceDbPath = await regularFixtureFile(resolve(input.sourceDbPath), 'sourceDbPath')
  const sourceArtifactRoot = await fixtureDirectory(
    resolve(input.sourceArtifactRoot),
    'sourceArtifactRoot',
  )
  for (const entry of input.artifactFiles) safeArtifactPath(sourceArtifactRoot, entry)
  const backupRequested = resolve(input.backupRoot)
  const restoreRequested = resolve(input.restoreRoot)
  const backupParent = await fixtureDirectory(dirname(backupRequested), 'backupRoot parent')
  const restoreParent = await fixtureDirectory(dirname(restoreRequested), 'restoreRoot parent')
  const backupRoot = join(backupParent, basename(backupRequested))
  const restoreRoot = join(restoreParent, basename(restoreRequested))
  if (
    overlaps(backupRoot, restoreRoot) ||
    [backupRoot, restoreRoot].some((output) =>
      [sourceDbPath, sourceArtifactRoot].some((source) => overlaps(output, source)),
    )
  )
    throw new Error('source, backup, and restore paths must not overlap')

  await newFixtureDirectory(backupRoot, 'backupRoot')
  await newFixtureDirectory(restoreRoot, 'restoreRoot')
  const source = new Store({ path: sourceDbPath })
  let snapshot: Uint8Array
  let sourceHashes: Record<string, string>
  let expectedArtifactHashes: Record<string, string>
  try {
    const captured = source.tx(() => ({
      campaignHashes: Object.fromEntries(
        [...input.campaignIds]
          .sort()
          .map((campaignId) => [campaignId, campaignHash(source, campaignId)]),
      ),
      expectedArtifactHashes: requiredArtifactHashes(
        source,
        input.campaignIds,
        sourceArtifactRoot,
        input.artifactFiles,
      ),
      snapshot: new Uint8Array(source.db.serialize()),
    }))
    snapshot = captured.snapshot
    sourceHashes = captured.campaignHashes
    expectedArtifactHashes = captured.expectedArtifactHashes
  } finally {
    source.close()
  }
  const backupDbPath = join(backupRoot, 'ledger.sqlite')
  await writeFile(backupDbPath, snapshot, { flag: 'wx' })
  const artifactHashes = await copyArtifacts(
    sourceArtifactRoot,
    join(backupRoot, 'artifacts'),
    expectedArtifactHashes,
  )
  const restoredDbPath = join(restoreRoot, 'ledger.sqlite')
  await copyFile(backupDbPath, restoredDbPath, 0)
  const restoredArtifactHashes = await copyArtifacts(
    join(backupRoot, 'artifacts'),
    join(restoreRoot, 'artifacts'),
    expectedArtifactHashes,
  )
  const restored = new Store({ path: restoredDbPath })
  try {
    const integrity = restored.db
      .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
      .all()
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
      throw new Error('restored SQLite integrity check failed')
    if (restored.db.query('PRAGMA foreign_key_check').all().length !== 0)
      throw new Error('restored SQLite foreign key check failed')
    const restoredHashes = Object.fromEntries(
      [...input.campaignIds]
        .sort()
        .map((campaignId) => [campaignId, campaignHash(restored, campaignId)]),
    )
    if (canonical(restoredHashes) !== canonical(sourceHashes))
      throw new Error('restored campaign projection does not match the consistent snapshot')
    if (canonical(restoredArtifactHashes) !== canonical(artifactHashes))
      throw new Error('restored artifact files do not match the backup')
  } finally {
    restored.close()
  }
  const backupDbHash = hash(await readFile(backupDbPath))
  const manifestHash = hash(
    canonical({ artifactHashes, backupDbHash, campaignHashes: sourceHashes }),
  )
  return { backupDbHash, artifactHashes, campaignHashes: sourceHashes, manifestHash }
}

if (import.meta.main) {
  const [inputPath] = Bun.argv.slice(2)
  if (!inputPath)
    throw new Error('usage: bun scripts/research-backup-drill.ts <fixture-input.json>')
  const input = (await Bun.file(inputPath).json()) as ResearchBackupDrillInput
  process.stdout.write(`${JSON.stringify(await runResearchBackupDrill(input))}\n`)
}
