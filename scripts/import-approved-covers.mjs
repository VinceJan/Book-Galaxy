#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  COVER_BLOCKLIST,
  COVER_GUIDANCE_URL,
  COVER_POLICY_VERSION,
  COVER_REMOVAL_CONTACT_URL,
  COVER_REVIEW_VERSION,
  COVER_TERMS_URL,
  GALLERY_COVERS_SCHEMA,
  GALLERY_SOURCE_BLOB_OID,
  GALLERY_SOURCE_PATH,
  GALLERY_SOURCE_PAYLOAD_SHA256,
  GALLERY_SOURCE_REPO,
  GALLERY_SOURCE_REVISION,
  assertValidApprovedCovers,
  sha256,
  sixMonthRecheckAfter,
  withApprovedCoversContentHash,
} from './lib/cover-policy.mjs'
import {
  isOpenLibraryCoverUrl,
  isOpenLibraryEditionUrl,
  isOpenLibraryWorkUrl,
} from './lib/source-urls.mjs'
import { loadGalleryProvenanceFixture } from './lib/git-object-provenance.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CATALOG = resolve(ROOT, 'public/data/catalog.json')
const DEFAULT_MANIFEST = resolve(ROOT, 'public/data/manifest.json')
const DEFAULT_OUTPUT = resolve(ROOT, 'data/covers/approved-v1.json')
export const DEFAULT_GALLERY_PROVENANCE_FIXTURE = resolve(ROOT, 'data/covers/provenance/gallery-5de3eff-v1.json')
const ALLOWED_GIT_REPO = resolve('D:/Projects/Book-Gallery')
const execFileAsync = promisify(execFile)
const ATTESTED_OBJECTS = new WeakMap()
const SHA256 = /^[a-f0-9]{64}$/u
const REVISION = /^[a-f0-9]{40}$/u
const SOURCE_TOP_FIELDS = ['schemaVersion', 'import', 'works']
const SOURCE_IMPORT_FIELDS = ['sourceKind', 'sourceRevision', 'sourceCatalogSha256', 'importedAt']
const SOURCE_WORK_FIELDS = ['workId', 'assets']
const SOURCE_ASSET_FIELDS = [
  'id', 'edition', 'editionTitle', 'publisher', 'publishedAt', 'isbn13', 'language',
  'imageUrl', 'sourcePageUrl', 'provider', 'providerWorkId', 'providerAssetId',
  'width', 'height', 'matchBasis', 'reviewStatus', 'audit', 'rights',
]
const SOURCE_AUDIT_FIELDS = ['checkedAt', 'imageSha256', 'byteLength', 'contentType', 'corsOrigin']
const SOURCE_RIGHTS_FIELDS = ['usageBasis', 'termsUrl', 'rightsStatement', 'attribution']

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const [key, inline] = arg.slice(2).split('=', 2)
    if (inline !== undefined) options[key] = inline
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) options[key] = argv[++index]
    else options[key] = true
  }
  return options
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactFields(value, fields) {
  return isObject(value)
    && Object.keys(value).sort().join('\u0000') === [...fields].sort().join('\u0000')
}

function sourceErrors(source) {
  const errors = []
  if (!exactFields(source, SOURCE_TOP_FIELDS)) errors.push('Gallery payload top-level fields are not exact')
  if (source?.schemaVersion !== GALLERY_COVERS_SCHEMA) errors.push(`Gallery schemaVersion must be ${GALLERY_COVERS_SCHEMA}`)
  if (!exactFields(source?.import, SOURCE_IMPORT_FIELDS)) errors.push('Gallery import fields are not exact')
  if (source?.import?.sourceKind !== 'book-galaxy') errors.push('Gallery import.sourceKind must be book-galaxy')
  if (!REVISION.test(String(source?.import?.sourceRevision || ''))) errors.push('Gallery import.sourceRevision must be a full git revision')
  if (!SHA256.test(String(source?.import?.sourceCatalogSha256 || ''))) errors.push('Gallery import.sourceCatalogSha256 must be SHA-256')
  const importedAt = new Date(source?.import?.importedAt)
  if (!Number.isFinite(importedAt.getTime()) || importedAt.toISOString() !== source?.import?.importedAt) errors.push('Gallery import.importedAt must be canonical ISO')
  if (!Array.isArray(source?.works) || source.works.length === 0) errors.push('Gallery works must be non-empty')
  const workIds = new Set()
  const assetIds = new Set()
  const providerAssets = new Set()
  for (const [workIndex, work] of (Array.isArray(source?.works) ? source.works : []).entries()) {
    const label = `works[${workIndex}]`
    if (!exactFields(work, SOURCE_WORK_FIELDS)) errors.push(`${label} fields are not exact`)
    if (!/^Q\d+$/u.test(String(work?.workId || ''))) errors.push(`${label}.workId must be a QID`)
    if (workIds.has(work?.workId)) errors.push(`${label}.workId is duplicated`)
    if (COVER_BLOCKLIST.has(work?.workId)) errors.push(`${label}.workId is cover-blocked`)
    workIds.add(work?.workId)
    if (!Array.isArray(work?.assets) || work.assets.length !== 1) errors.push(`${label}.assets must contain exactly one asset`)
    for (const [assetIndex, asset] of (Array.isArray(work?.assets) ? work.assets : []).entries()) {
      const assetLabel = `${label}.assets[${assetIndex}]`
      if (!exactFields(asset, SOURCE_ASSET_FIELDS)) errors.push(`${assetLabel} fields are not exact`)
      if (!exactFields(asset?.audit, SOURCE_AUDIT_FIELDS)) errors.push(`${assetLabel}.audit fields are not exact`)
      if (!exactFields(asset?.rights, SOURCE_RIGHTS_FIELDS)) errors.push(`${assetLabel}.rights fields are not exact`)
      if (asset?.reviewStatus !== 'approved') errors.push(`${assetLabel}.reviewStatus must be approved; candidates are never imported`)
      if (asset?.provider !== 'open-library') errors.push(`${assetLabel}.provider is unsupported by the Gallery input adapter`)
      const editionId = asset?.edition?.value
      if (asset?.edition?.scheme !== 'open-library-edition' || !/^OL\d+M$/u.test(String(editionId || ''))) errors.push(`${assetLabel}.edition is invalid`)
      if (!/^OL\d+W$/u.test(String(asset?.providerWorkId || '')) || !isOpenLibraryWorkUrl(`https://openlibrary.org/works/${asset?.providerWorkId}`, asset?.providerWorkId)) errors.push(`${assetLabel}.providerWorkId is invalid`)
      if (!/^\d+$/u.test(String(asset?.providerAssetId || ''))) errors.push(`${assetLabel}.providerAssetId is invalid`)
      if (asset?.id !== `open-library-cover-${asset?.providerAssetId}`) errors.push(`${assetLabel}.id does not bind the provider asset`)
      if (!isOpenLibraryEditionUrl(asset?.sourcePageUrl, editionId)) errors.push(`${assetLabel}.sourcePageUrl does not bind the edition`)
      if (asset?.imageUrl !== `https://covers.openlibrary.org/b/id/${asset?.providerAssetId}-L.jpg?default=false` || !isOpenLibraryCoverUrl(asset?.imageUrl)) errors.push(`${assetLabel}.imageUrl does not bind the audited L asset`)
      if (!Number.isInteger(asset?.width) || asset.width < 1 || !Number.isInteger(asset?.height) || asset.height < 1) errors.push(`${assetLabel} dimensions must be positive integers`)
      if (!Number.isInteger(asset?.audit?.byteLength) || asset.audit.byteLength < 1) errors.push(`${assetLabel}.audit.byteLength must be positive`)
      if (!SHA256.test(String(asset?.audit?.imageSha256 || ''))) errors.push(`${assetLabel}.audit.imageSha256 must be SHA-256`)
      if (asset?.audit?.contentType !== 'image/jpeg') errors.push(`${assetLabel}.audit.contentType is unsupported by the Gallery Open Library adapter`)
      if (asset?.audit?.corsOrigin !== '*') errors.push(`${assetLabel}.audit.corsOrigin is not approved browser evidence`)
      for (const field of ['editionTitle', 'publisher', 'publishedAt', 'isbn13', 'language', 'matchBasis']) {
        if (typeof asset?.[field] !== 'string' || !asset[field].trim()) errors.push(`${assetLabel}.${field} is required`)
      }
      for (const field of SOURCE_RIGHTS_FIELDS) {
        if (typeof asset?.rights?.[field] !== 'string' || !asset.rights[field].trim()) errors.push(`${assetLabel}.rights.${field} is required`)
      }
      const providerIdentity = `${asset?.provider}\u0000${asset?.providerAssetId}`
      if (assetIds.has(asset?.id)) errors.push(`${assetLabel}.id is duplicated`)
      if (providerAssets.has(providerIdentity)) errors.push(`${assetLabel} duplicates a provider asset`)
      assetIds.add(asset?.id)
      providerAssets.add(providerIdentity)
    }
  }
  return errors
}

export function validateGalleryCandidatePayload(payloadBuffer) {
  if (!Buffer.isBuffer(payloadBuffer)) throw new Error('candidate payload must be a Buffer')
  let source
  try {
    source = JSON.parse(payloadBuffer.toString('utf8'))
  } catch (error) {
    throw new Error(`Gallery candidate is not JSON: ${error instanceof Error ? error.message : error}`)
  }
  const errors = sourceErrors(source)
  if (errors.length) throw new Error(`Gallery candidate rejected (${errors.length}):\n${errors.map((error) => `- ${error}`).join('\n')}`)
  return source
}

async function gitOutput(repo, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
      encoding: 'buffer',
      maxBuffer: 10 * 1024 * 1024,
    })
    return Buffer.from(stdout)
  } catch (error) {
    throw new Error(`Git object attestation failed: ${error instanceof Error ? error.message : error}`)
  }
}

function attestVerifiedDescriptor(descriptor) {
  const attested = Object.freeze({
    payloadBuffer: Buffer.from(descriptor.payloadBuffer),
    repo: GALLERY_SOURCE_REPO,
    commit: descriptor.commit,
    path: descriptor.path,
    blobOid: descriptor.blobOid,
    payloadSha256: descriptor.payloadSha256,
  })
  ATTESTED_OBJECTS.set(attested, {
    payloadBuffer: Buffer.from(descriptor.payloadBuffer),
    commit: descriptor.commit,
    path: descriptor.path,
    blobOid: descriptor.blobOid,
    payloadSha256: descriptor.payloadSha256,
  })
  return attested
}

/** Resolve the pinned object chain from the committed, self-contained CI fixture. */
export async function readAllowedGalleryProvenanceFixture({ fixturePath = DEFAULT_GALLERY_PROVENANCE_FIXTURE } = {}) {
  const descriptor = await loadGalleryProvenanceFixture(resolve(fixturePath))
  validateGalleryCandidatePayload(descriptor.payloadBuffer)
  return attestVerifiedDescriptor(descriptor)
}

/** Read only the one locally allowed committed Gallery object and attest its bytes. */
export async function readAllowedGalleryGitObject({ gitRepo, sourceRevision, sourcePath }) {
  const resolvedRepo = resolve(String(gitRepo || ''))
  if (resolvedRepo.toLocaleLowerCase('en-US') !== ALLOWED_GIT_REPO.toLocaleLowerCase('en-US')) {
    throw new Error(`Git repository is not allowed: ${resolvedRepo}`)
  }
  if (sourceRevision !== GALLERY_SOURCE_REVISION) throw new Error('Git revision is not the allowed Gallery revision')
  if (sourcePath !== GALLERY_SOURCE_PATH) throw new Error('Git object path is not the allowed Gallery path')

  const repositoryRoot = resolve((await gitOutput(resolvedRepo, ['rev-parse', '--show-toplevel'])).toString('utf8').trim())
  if (repositoryRoot.toLocaleLowerCase('en-US') !== ALLOWED_GIT_REPO.toLocaleLowerCase('en-US')) {
    throw new Error(`Git repository root is not allowed: ${repositoryRoot}`)
  }
  const commit = (await gitOutput(resolvedRepo, ['rev-parse', '--verify', `${sourceRevision}^{commit}`])).toString('utf8').trim()
  if (commit !== GALLERY_SOURCE_REVISION) throw new Error(`Git revision resolved to unexpected commit: ${commit}`)
  const blobOid = (await gitOutput(resolvedRepo, ['rev-parse', `${commit}:${sourcePath}`])).toString('utf8').trim()
  if (blobOid !== GALLERY_SOURCE_BLOB_OID) throw new Error(`Git object resolved to unexpected blob: ${blobOid}`)
  const payloadBuffer = await gitOutput(resolvedRepo, ['show', `${commit}:${sourcePath}`])
  const payloadSha256 = sha256(payloadBuffer)
  if (payloadSha256 !== GALLERY_SOURCE_PAYLOAD_SHA256) throw new Error(`Git object payload SHA mismatch: ${payloadSha256}`)
  validateGalleryCandidatePayload(payloadBuffer)

  return attestVerifiedDescriptor({ payloadBuffer, commit, path: sourcePath, blobOid, payloadSha256 })
}

function normalizeOpenLibraryAsset(workId, asset) {
  const reviewedAt = asset.audit.checkedAt
  const editionId = asset.edition.value
  return {
    ...structuredClone(asset),
    audit: {
      ...structuredClone(asset.audit),
      corsEvidence: { state: 'allowed-origin', origin: asset.audit.corsOrigin },
    },
    rights: {
      ...structuredClone(asset.rights),
      providerTermsUrl: COVER_TERMS_URL,
      guidanceUrl: COVER_GUIDANCE_URL,
      policyVersion: COVER_POLICY_VERSION,
      providerReportUrl: `https://openlibrary.org/contact?path=/books/${editionId}`,
      removalContactUrl: COVER_REMOVAL_CONTACT_URL,
      reviewedAt,
      reviewVersion: COVER_REVIEW_VERSION,
      recheckAfter: sixMonthRecheckAfter(reviewedAt),
    },
    lifecycle: {
      status: 'active',
      purgeKey: `cover:${asset.provider}:${asset.providerAssetId}:${workId}:${editionId}`,
    },
  }
}

/** Produce an approved snapshot only from a descriptor created by the strict Git-object reader. */
export function importGalleryApprovedCovers({
  attestedObject,
  catalogBuffer,
  manifest,
  now = new Date(),
}) {
  const attestation = ATTESTED_OBJECTS.get(attestedObject)
  if (!attestation) throw new Error('approved import requires an attested Git object; stdin/file input is untrusted candidate data')
  const payloadBuffer = attestation.payloadBuffer
  const actualPayloadSha = sha256(payloadBuffer)
  if (actualPayloadSha !== attestation.payloadSha256 || actualPayloadSha !== GALLERY_SOURCE_PAYLOAD_SHA256) {
    throw new Error(`Attested Gallery payload SHA mismatch: ${actualPayloadSha}`)
  }
  const source = validateGalleryCandidatePayload(payloadBuffer)
  if (!Buffer.isBuffer(catalogBuffer)) throw new Error('catalogBuffer is required')
  const catalogSha = sha256(catalogBuffer)
  let catalog
  try {
    catalog = JSON.parse(catalogBuffer.toString('utf8'))
  } catch (error) {
    throw new Error(`catalog is not JSON: ${error instanceof Error ? error.message : error}`)
  }
  if (catalog?.schemaVersion !== 'bookshelf-galaxy/catalog-v2' || !Array.isArray(catalog.books)) throw new Error('current catalog must be catalog-v2')
  if (manifest?.catalogSha256 !== catalogSha) throw new Error('current manifest catalog SHA does not match the catalog bytes')
  const manifestUpstreamSha = manifest?.sources?.covers?.approvedSidecar?.source?.upstreamCatalogSha256
  if (source.import.sourceCatalogSha256 !== catalogSha && source.import.sourceCatalogSha256 !== manifestUpstreamSha) {
    throw new Error('Gallery upstream catalog SHA drifted from the current manifest')
  }
  const catalogById = new Map(catalog.books.map((book) => [book.id, book]))
  for (const work of source.works) {
    const book = catalogById.get(work.workId)
    if (!book) throw new Error(`${work.workId} is absent from the current catalog`)
    if (book.openLibraryId !== work.assets[0].providerWorkId) throw new Error(`${work.workId} provider Work does not match the current catalog`)
  }

  const normalized = withApprovedCoversContentHash({
    schemaVersion: 'book-galaxy/approved-covers-v1',
    importedAt: source.import.importedAt,
    source: {
      schemaVersion: source.schemaVersion,
      repo: GALLERY_SOURCE_REPO,
      revision: attestation.commit,
      path: attestation.path,
      upstreamCatalogRevision: source.import.sourceRevision,
      upstreamCatalogSha256: source.import.sourceCatalogSha256,
      payloadSha256: actualPayloadSha,
      gitObject: {
        kind: 'git-object',
        commit: attestation.commit,
        path: attestation.path,
        blobOid: attestation.blobOid,
      },
    },
    providerPolicies: {
      'open-library': {
        version: COVER_POLICY_VERSION,
        guidanceUrl: COVER_GUIDANCE_URL,
        termsUrl: COVER_TERMS_URL,
      },
    },
    removalContactUrl: COVER_REMOVAL_CONTACT_URL,
    works: source.works.map((work) => ({
      workId: work.workId,
      assets: work.assets.map((asset) => normalizeOpenLibraryAsset(work.workId, asset)),
    })),
  })
  assertValidApprovedCovers(normalized, { catalogBooks: catalog.books, now })
  return normalized
}

async function stdinBuffer() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, text, 'utf8')
  if (!existsSync(path)) return rename(temporary, path)
  const backup = `${path}.bak-${process.pid}`
  await rename(path, backup)
  try {
    await rename(temporary, path)
    await rm(backup, { force: true })
  } catch (error) {
    await rename(backup, path).catch(() => {})
    await rm(temporary, { force: true })
    throw error
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (typeof options.input === 'string') {
    if (options.output) throw new Error('untrusted --input candidate mode cannot write an approved snapshot')
    const payloadBuffer = options.input === '-' ? await stdinBuffer() : await readFile(resolve(ROOT, options.input))
    const source = validateGalleryCandidatePayload(payloadBuffer)
    console.log(JSON.stringify({
      ok: true,
      mode: 'untrusted-candidate',
      approvable: false,
      writes: 0,
      payloadSha256: sha256(payloadBuffer),
      works: source.works.length,
    }, null, 2))
    return
  }
  let attestedObject
  let provenanceMode
  if (typeof options['git-repo'] === 'string') {
    for (const option of ['source-revision', 'source-path']) {
      if (typeof options[option] !== 'string') throw new Error(`--${option} is required with --git-repo`)
    }
    attestedObject = await readAllowedGalleryGitObject({
      gitRepo: options['git-repo'],
      sourceRevision: options['source-revision'],
      sourcePath: options['source-path'],
    })
    provenanceMode = 'local-git-object'
  } else {
    attestedObject = await readAllowedGalleryProvenanceFixture({
      fixturePath: options['provenance-fixture'] || DEFAULT_GALLERY_PROVENANCE_FIXTURE,
    })
    provenanceMode = 'committed-object-chain-fixture'
  }
  const catalogPath = resolve(ROOT, String(options.catalog || DEFAULT_CATALOG))
  const manifestPath = resolve(ROOT, String(options.manifest || DEFAULT_MANIFEST))
  const outputPath = resolve(ROOT, String(options.output || DEFAULT_OUTPUT))
  const [catalogBuffer, manifestBuffer] = await Promise.all([readFile(catalogPath), readFile(manifestPath)])
  const normalized = importGalleryApprovedCovers({
    attestedObject,
    catalogBuffer,
    manifest: JSON.parse(manifestBuffer.toString('utf8')),
  })
  await writeAtomic(outputPath, `${JSON.stringify(normalized, null, 2)}\n`)
  console.log(JSON.stringify({
    ok: true,
    output: relative(ROOT, outputPath),
    provenanceMode,
    works: normalized.works.length,
    assets: normalized.works.reduce((sum, work) => sum + work.assets.length, 0),
    payloadSha256: normalized.source.payloadSha256,
    contentSha256: normalized.contentSha256,
  }, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
