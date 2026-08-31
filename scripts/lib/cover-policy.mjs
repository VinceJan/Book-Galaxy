import { createHash } from 'node:crypto'

import {
  isOpenLibraryCoverUrl,
  isOpenLibraryEditionUrl,
  isTrustedHttpsUrl,
} from './source-urls.mjs'

export const APPROVED_COVERS_SCHEMA = 'book-galaxy/approved-covers-v1'
export const GALLERY_COVERS_SCHEMA = 'book-gallery/covers-v1'
export const GALLERY_SOURCE_REPO = 'https://github.com/VinceJan/Book-Gallery'
export const GALLERY_SOURCE_REVISION = '5de3efff5b88c2739ea51e44fbf8fb36541ca8d1'
export const GALLERY_SOURCE_PATH = 'public/data/covers-v1.json'
export const GALLERY_SOURCE_PAYLOAD_SHA256 = 'f2af207ccf0734a84cd880833970e211a13ca4af022d81773832d8ebe1a804f5'
export const GALLERY_SOURCE_BLOB_OID = 'c4f0f50b74f11e496bf3676c935494dca62e05a2'
export const COVER_REMOVAL_CONTACT_URL = 'https://github.com/VinceJan/Book-Galaxy/issues/new?template=cover-removal.yml'
export const COVER_GUIDANCE_URL = 'https://openlibrary.org/dev/docs/api/covers'
export const COVER_TERMS_URL = 'https://archive.org/about/terms.php'
export const COVER_POLICY_VERSION = 'open-library-cover-policy-v1'
export const COVER_REVIEW_VERSION = 'book-galaxy-cover-review-v1'
export const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'])
export const LIFECYCLE_STATUSES = new Set(['active', 'quarantined', 'removed'])

// Blocklist precedence is absolute: network builds, imports, overlays and
// offline checks all consume this one policy object.
export const COVER_BLOCKLIST = new Map([
  ['Q172723', 'Known P648 → Open Library cover_i mismatch; suppress the cover rather than imply edition identity.'],
  ['Q589197', 'Known P648 → Open Library cover_i mismatch; suppress the cover rather than imply edition identity.'],
  ['Q127149', 'Known P648 → Open Library cover_i mismatch; suppress the cover rather than imply edition identity.'],
  ['Q41064', 'Known P648 → Open Library cover_i mismatch; suppress the cover rather than imply edition identity.'],
  ['Q9184', 'Known P648 → Open Library cover_i mismatch; suppress the cover rather than imply edition identity.'],
  ['Q921522', 'Known P648 → Open Library cover_i mismatch; suppress the cover rather than imply edition identity.'],
])

const SHA256 = /^[a-f0-9]{64}$/u
const REVISION = /^[a-f0-9]{40}$/u
const QID = /^Q\d+$/u
const OPEN_LIBRARY_EDITION = /^OL\d+M$/u
const OPEN_LIBRARY_WORK = /^OL\d+W$/u
const POSITIVE_INTEGER = (value) => Number.isInteger(value) && value > 0

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function sortApprovedCoverWorks(works) {
  return [...works]
    .map((work) => ({ ...work, assets: [...work.assets].sort((left, right) => String(left.id).localeCompare(String(right.id), 'en')) }))
    .sort((left, right) => String(left.workId).localeCompare(String(right.workId), 'en'))
}

export function approvedCoversContentSha256(snapshot) {
  const { contentSha256: _ignored, ...withoutHash } = snapshot
  return sha256(canonicalJson({ ...withoutHash, works: sortApprovedCoverWorks(withoutHash.works || []) }))
}

export function withApprovedCoversContentHash(snapshot) {
  const normalized = { ...snapshot, works: sortApprovedCoverWorks(snapshot.works || []) }
  return { ...normalized, contentSha256: approvedCoversContentSha256(normalized) }
}

export function approvedCoversSourceDerivedView(snapshot) {
  const { contentSha256: _contentSha256, ...withoutHash } = snapshot
  return {
    ...withoutHash,
    works: sortApprovedCoverWorks(withoutHash.works || []).map((work) => ({
      ...work,
      assets: work.assets.map((asset) => ({
        ...asset,
        lifecycle: { purgeKey: asset.lifecycle?.purgeKey },
      })),
    })),
  }
}

export function assertApprovedCoversSourceDerived(snapshot, pinnedSourceSnapshot) {
  if (canonicalJson(approvedCoversSourceDerivedView(snapshot)) !== canonicalJson(approvedCoversSourceDerivedView(pinnedSourceSnapshot))) {
    throw new Error('approved cover immutable source-derived fields differ from the pinned Git object')
  }
  return true
}

export function sixMonthRecheckAfter(value) {
  const checked = new Date(value)
  if (!Number.isFinite(checked.getTime())) return null
  const year = checked.getUTCFullYear()
  const targetMonth = checked.getUTCMonth() + 6
  const targetYear = year + Math.floor(targetMonth / 12)
  const month = targetMonth % 12
  const lastDay = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate()
  const day = Math.min(checked.getUTCDate(), lastDay)
  return new Date(Date.UTC(
    targetYear,
    month,
    day,
    checked.getUTCHours(),
    checked.getUTCMinutes(),
    checked.getUTCSeconds(),
    checked.getUTCMilliseconds(),
  )).toISOString()
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function timestamp(value) {
  return isCanonicalTimestamp(value) ? new Date(value).getTime() : Number.NaN
}

function openLibraryReportUrl(value, editionId) {
  if (!isTrustedHttpsUrl(value)) return false
  const url = new URL(value)
  return url.hostname === 'openlibrary.org'
    && url.pathname === '/contact'
    && !url.hash
    && url.search === `?path=/books/${editionId}`
}

function openLibraryAssetBinding(asset) {
  const editionId = asset?.edition?.value
  if (asset?.edition?.scheme !== 'open-library-edition' || !OPEN_LIBRARY_EDITION.test(String(editionId || ''))) return false
  if (!OPEN_LIBRARY_WORK.test(String(asset.providerWorkId || '')) || !/^\d+$/u.test(String(asset.providerAssetId || ''))) return false
  if (asset.id !== `open-library-cover-${asset.providerAssetId}`) return false
  if (!isOpenLibraryEditionUrl(asset.sourcePageUrl, editionId)) return false
  const expectedImage = `https://covers.openlibrary.org/b/id/${asset.providerAssetId}-L.jpg?default=false`
  return asset.imageUrl === expectedImage
    && isOpenLibraryCoverUrl(asset.imageUrl)
    && openLibraryReportUrl(asset.rights?.providerReportUrl, editionId)
}

function openLibraryDisplayUrl(asset) {
  return `https://covers.openlibrary.org/b/id/${asset.providerAssetId}-M.jpg?default=false`
}

export const COVER_PROVIDER_ADAPTERS = new Map([
  ['open-library', {
    validatePolicy(policy) {
      return policy?.version === COVER_POLICY_VERSION
        && policy?.guidanceUrl === COVER_GUIDANCE_URL
        && policy?.termsUrl === COVER_TERMS_URL
    },
    validateAsset(asset, catalogBook) {
      return openLibraryAssetBinding(asset)
        && (!catalogBook || catalogBook.openLibraryId === asset.providerWorkId)
    },
    displayUrl: openLibraryDisplayUrl,
    sourceUrl: (asset) => asset.sourcePageUrl,
    runtimeFieldNames: ['openLibraryId'],
    allowNonSidecarRuntimeFields: ['openLibraryId'],
    runtimeFields: (asset) => ({ openLibraryId: asset.providerWorkId }),
  }],
])

function corsEvidenceIsValid(audit, imageUrl) {
  const evidence = audit?.corsEvidence
  if (!isObject(evidence)) return false
  if (evidence.state === 'server-only' || evidence.state === 'not-applicable') {
    return Object.keys(evidence).length === 1
  }
  if (evidence.state !== 'allowed-origin' || typeof evidence.origin !== 'string') return false
  if (evidence.origin === '*') return true
  if (!isTrustedHttpsUrl(evidence.origin)) return false
  const origin = new URL(evidence.origin)
  return origin.origin === evidence.origin && origin.origin === new URL(imageUrl).origin
}

function push(errors, condition, message) {
  if (!condition) errors.push(message)
}

function sortedIdentity(works) {
  return JSON.stringify(works.map((work) => ({ workId: work.workId, assets: work.assets.map((asset) => asset.id) })))
}

/** Validate the generic normalized schema. Provider-specific identity checks live in the registry above. */
export function validateApprovedCovers(snapshot, {
  catalogBooks,
  now = new Date(),
  checkContentHash = true,
  providerAdapters = COVER_PROVIDER_ADAPTERS,
} = {}) {
  const errors = []
  if (!isObject(snapshot)) return { errors: ['approved cover snapshot must be an object'], assets: [] }
  push(errors, snapshot.schemaVersion === APPROVED_COVERS_SCHEMA, `schemaVersion must be ${APPROVED_COVERS_SCHEMA}`)
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime()
  push(errors, Number.isFinite(nowTime), 'validation time is invalid')
  push(errors, isCanonicalTimestamp(snapshot.importedAt), 'importedAt must be a canonical ISO timestamp')
  push(errors, !Number.isFinite(nowTime) || timestamp(snapshot.importedAt) <= nowTime, 'importedAt cannot be in the future')
  push(errors, isObject(snapshot.source), 'source must be an object')
  if (isObject(snapshot.source)) {
    push(errors, snapshot.source.schemaVersion === GALLERY_COVERS_SCHEMA, `source.schemaVersion must be ${GALLERY_COVERS_SCHEMA}`)
    push(errors, snapshot.source.repo === GALLERY_SOURCE_REPO, 'source.repo is not the approved repository')
    push(errors, snapshot.source.revision === GALLERY_SOURCE_REVISION, 'source.revision is not the attested Gallery revision')
    push(errors, snapshot.source.path === GALLERY_SOURCE_PATH, 'source.path is not the attested Gallery path')
    push(errors, snapshot.source.payloadSha256 === GALLERY_SOURCE_PAYLOAD_SHA256, 'source.payloadSha256 is not the attested Git-object payload')
    push(errors, isObject(snapshot.source.gitObject), 'source.gitObject attestation is required')
    if (isObject(snapshot.source.gitObject)) {
      push(errors, snapshot.source.gitObject.kind === 'git-object', 'source.gitObject.kind must be git-object')
      push(errors, snapshot.source.gitObject.commit === GALLERY_SOURCE_REVISION, 'source.gitObject.commit is invalid')
      push(errors, snapshot.source.gitObject.path === GALLERY_SOURCE_PATH, 'source.gitObject.path is invalid')
      push(errors, snapshot.source.gitObject.blobOid === GALLERY_SOURCE_BLOB_OID, 'source.gitObject.blobOid is invalid')
    }
    push(errors, REVISION.test(String(snapshot.source.upstreamCatalogRevision || '')), 'source.upstreamCatalogRevision must be a full git revision')
    push(errors, SHA256.test(String(snapshot.source.upstreamCatalogSha256 || '')), 'source.upstreamCatalogSha256 must be SHA-256')
  }
  push(errors, isObject(snapshot.providerPolicies) && Object.keys(snapshot.providerPolicies).length > 0, 'providerPolicies must be a non-empty object')
  for (const [provider, policy] of Object.entries(isObject(snapshot.providerPolicies) ? snapshot.providerPolicies : {})) {
    push(errors, provider.trim().length > 0 && isObject(policy), `providerPolicies.${provider} is invalid`)
    if (!isObject(policy)) continue
    push(errors, typeof policy.version === 'string' && policy.version.trim().length > 0, `providerPolicies.${provider}.version is required`)
    push(errors, isTrustedHttpsUrl(policy.guidanceUrl), `providerPolicies.${provider}.guidanceUrl is invalid`)
    push(errors, isTrustedHttpsUrl(policy.termsUrl) && new URL(policy.termsUrl).pathname !== '/about', `providerPolicies.${provider}.termsUrl must be a provider terms page, not generic /about`)
  }
  push(errors, snapshot.removalContactUrl === COVER_REMOVAL_CONTACT_URL, 'project cover removal contact is invalid')
  push(errors, Array.isArray(snapshot.works) && snapshot.works.length > 0, 'works must be a non-empty array')
  if (!Array.isArray(snapshot.works)) return { errors, assets: [] }
  const sorted = sortApprovedCoverWorks(snapshot.works)
  push(errors, sortedIdentity(snapshot.works) === sortedIdentity(sorted), 'works/assets are not in stable order')
  if (checkContentHash) {
    push(errors, SHA256.test(String(snapshot.contentSha256 || '')), 'contentSha256 must be SHA-256')
    push(errors, snapshot.contentSha256 === approvedCoversContentSha256(snapshot), 'contentSha256 does not match canonical snapshot content')
  }

  const catalogById = catalogBooks ? new Map(catalogBooks.map((book) => [book.id, book])) : null
  const seenWorks = new Set()
  const seenAssetIds = new Set()
  const seenProviderAssets = new Set()
  const seenEditions = new Set()
  const seenImages = new Set()
  const seenSources = new Set()
  const seenPurgeKeys = new Set()
  const seenImageHashes = new Set()
  const assets = []

  for (const [workIndex, work] of snapshot.works.entries()) {
    const workLabel = `works[${workIndex}]`
    push(errors, isObject(work), `${workLabel} must be an object`)
    if (!isObject(work)) continue
    const workId = String(work.workId || '')
    push(errors, QID.test(workId), `${workLabel}.workId must be a QID`)
    push(errors, !seenWorks.has(workId), `${workLabel}.workId is duplicated`)
    push(errors, !COVER_BLOCKLIST.has(workId), `${workLabel}.workId is cover-blocked`)
    seenWorks.add(workId)
    push(errors, Array.isArray(work.assets) && work.assets.length === 1, `${workLabel}.assets must contain exactly one reviewed asset`)
    if (catalogById) push(errors, catalogById.has(workId), `${workLabel}.workId is absent from the current catalog`)
    for (const [assetIndex, asset] of (Array.isArray(work.assets) ? work.assets : []).entries()) {
      const label = `${workLabel}.assets[${assetIndex}]`
      if (!isObject(asset)) {
        errors.push(`${label} must be an object`)
        continue
      }
      assets.push({ workId, asset })
      push(errors, typeof asset.id === 'string' && asset.id.length > 0, `${label}.id is required`)
      push(errors, !seenAssetIds.has(asset.id), `${label}.id is duplicated`)
      seenAssetIds.add(asset.id)
      push(errors, isObject(asset.edition) && typeof asset.edition.scheme === 'string' && typeof asset.edition.value === 'string', `${label}.edition is invalid`)
      for (const field of ['editionTitle', 'publisher', 'publishedAt', 'isbn13', 'language', 'matchBasis']) {
        push(errors, typeof asset[field] === 'string' && asset[field].trim().length > 0, `${label}.${field} is required`)
      }
      push(errors, typeof asset.provider === 'string' && asset.provider.length > 0, `${label}.provider is required`)
      push(errors, typeof asset.providerWorkId === 'string' && asset.providerWorkId.length > 0, `${label}.providerWorkId is required`)
      push(errors, typeof asset.providerAssetId === 'string' && asset.providerAssetId.length > 0, `${label}.providerAssetId is required`)
      push(errors, isTrustedHttpsUrl(asset.imageUrl), `${label}.imageUrl is not trusted HTTPS`)
      push(errors, isTrustedHttpsUrl(asset.sourcePageUrl), `${label}.sourcePageUrl is not trusted HTTPS`)
      push(errors, POSITIVE_INTEGER(asset.width) && POSITIVE_INTEGER(asset.height), `${label} image dimensions must be positive integers`)
      push(errors, asset.reviewStatus === 'approved', `${label}.reviewStatus must be approved`)
      push(errors, isObject(asset.audit), `${label}.audit is required`)
      if (isObject(asset.audit)) {
        push(errors, isCanonicalTimestamp(asset.audit.checkedAt), `${label}.audit.checkedAt is invalid`)
        push(errors, !Number.isFinite(nowTime) || timestamp(asset.audit.checkedAt) <= nowTime, `${label}.audit.checkedAt cannot be in the future`)
        push(errors, SHA256.test(String(asset.audit.imageSha256 || '')), `${label}.audit.imageSha256 must be SHA-256`)
        push(errors, !seenImageHashes.has(asset.audit.imageSha256), `${label}.audit.imageSha256 is duplicated`)
        seenImageHashes.add(asset.audit.imageSha256)
        push(errors, POSITIVE_INTEGER(asset.audit.byteLength), `${label}.audit.byteLength must be positive`)
        push(errors, IMAGE_MIME_TYPES.has(asset.audit.contentType), `${label}.audit.contentType is unsupported`)
        push(errors, corsEvidenceIsValid(asset.audit, asset.imageUrl), `${label}.audit.corsEvidence is invalid`)
      }
      const providerPolicy = snapshot.providerPolicies?.[asset.provider]
      push(errors, isObject(providerPolicy), `${label} has no provider policy`)
      push(errors, isObject(asset.rights), `${label}.rights is required`)
      if (isObject(asset.rights)) {
        for (const field of ['usageBasis', 'rightsStatement', 'attribution']) {
          push(errors, typeof asset.rights[field] === 'string' && asset.rights[field].trim().length > 0, `${label}.rights.${field} is required`)
        }
        push(errors, isTrustedHttpsUrl(asset.rights.termsUrl), `${label}.rights.termsUrl is invalid`)
        push(errors, isTrustedHttpsUrl(asset.rights.providerTermsUrl) && new URL(asset.rights.providerTermsUrl).pathname !== '/about', `${label}.rights.providerTermsUrl must be the provider terms, not a generic /about page`)
        push(errors, isObject(providerPolicy) && asset.rights.providerTermsUrl === providerPolicy.termsUrl, `${label}.rights.providerTermsUrl does not match the provider policy`)
        push(errors, isObject(providerPolicy) && asset.rights.guidanceUrl === providerPolicy.guidanceUrl, `${label}.rights.guidanceUrl does not match the provider policy`)
        push(errors, isObject(providerPolicy) && asset.rights.policyVersion === providerPolicy.version, `${label}.rights.policyVersion is missing or stale`)
        push(errors, asset.rights.reviewVersion === COVER_REVIEW_VERSION, `${label}.rights.reviewVersion is missing or stale`)
        push(errors, asset.rights.removalContactUrl === COVER_REMOVAL_CONTACT_URL, `${label}.rights.removalContactUrl is invalid`)
        push(errors, isTrustedHttpsUrl(asset.rights.providerReportUrl), `${label}.rights.providerReportUrl is invalid`)
        push(errors, isCanonicalTimestamp(asset.rights.reviewedAt), `${label}.rights.reviewedAt is invalid`)
        push(errors, !Number.isFinite(nowTime) || timestamp(asset.rights.reviewedAt) <= nowTime, `${label}.rights.reviewedAt cannot be in the future`)
        push(errors, isCanonicalTimestamp(asset.rights.recheckAfter), `${label}.rights.recheckAfter is invalid`)
        push(errors, timestamp(asset.rights.reviewedAt) >= timestamp(asset.audit?.checkedAt), `${label}.rights.reviewedAt cannot precede the image audit`)
        push(errors, timestamp(asset.rights.recheckAfter) > timestamp(asset.rights.reviewedAt), `${label}.rights.recheckAfter must follow review`)
        push(errors, asset.rights.recheckAfter === sixMonthRecheckAfter(asset.rights.reviewedAt), `${label}.rights.recheckAfter must be the deterministic six-month date`)
        if (asset.lifecycle?.status === 'active' && isCanonicalTimestamp(asset.rights.recheckAfter) && Number.isFinite(nowTime)) {
          push(errors, timestamp(asset.rights.recheckAfter) > nowTime, `${label}.rights policy review has expired`)
        }
      }
      push(errors, isObject(asset.lifecycle), `${label}.lifecycle is required`)
      if (isObject(asset.lifecycle)) {
        push(errors, LIFECYCLE_STATUSES.has(asset.lifecycle.status), `${label}.lifecycle.status is invalid`)
        push(errors, typeof asset.lifecycle.purgeKey === 'string' && asset.lifecycle.purgeKey.trim().length > 0, `${label}.lifecycle.purgeKey is required`)
        push(errors, !seenPurgeKeys.has(asset.lifecycle.purgeKey), `${label}.lifecycle.purgeKey is duplicated`)
        seenPurgeKeys.add(asset.lifecycle.purgeKey)
        const lifecycleKeys = Object.keys(asset.lifecycle).sort().join('\u0000')
        if (asset.lifecycle.status === 'active') {
          push(errors, lifecycleKeys === ['purgeKey', 'status'].join('\u0000'), `${label}.lifecycle active fields are invalid`)
        } else if (LIFECYCLE_STATUSES.has(asset.lifecycle.status)) {
          push(errors, lifecycleKeys === ['purgeKey', 'status', 'transition'].join('\u0000'), `${label}.lifecycle inactive transition is required`)
          const transition = asset.lifecycle.transition
          push(errors, isObject(transition), `${label}.lifecycle.transition is required`)
          if (isObject(transition)) {
            const allowedTransitionKeys = new Set(['from', 'changedAt', 'reason', 'reviewVersion', 'requestUrl'])
            push(errors, Object.keys(transition).every((key) => allowedTransitionKeys.has(key)), `${label}.lifecycle.transition has unknown fields`)
            push(errors, transition.from === 'active', `${label}.lifecycle.transition.from must be active`)
            push(errors, isCanonicalTimestamp(transition.changedAt), `${label}.lifecycle.transition.changedAt is invalid`)
            push(errors, !Number.isFinite(nowTime) || timestamp(transition.changedAt) <= nowTime, `${label}.lifecycle.transition.changedAt cannot be in the future`)
            push(errors, timestamp(transition.changedAt) >= timestamp(asset.rights?.reviewedAt), `${label}.lifecycle.transition.changedAt cannot precede review`)
            push(errors, typeof transition.reason === 'string' && transition.reason.trim().length > 0, `${label}.lifecycle.transition.reason is required`)
            push(errors, transition.reviewVersion === COVER_REVIEW_VERSION, `${label}.lifecycle.transition.reviewVersion is invalid`)
            if (transition.requestUrl !== undefined) {
              const request = isTrustedHttpsUrl(transition.requestUrl) ? new URL(transition.requestUrl) : null
              push(errors, Boolean(request && request.hostname === 'github.com' && request.pathname.startsWith('/VinceJan/Book-Galaxy/issues/')), `${label}.lifecycle.transition.requestUrl is invalid`)
            }
          }
        }
      }

      const providerIdentity = `${asset.provider}\u0000${asset.providerAssetId}`
      const editionIdentity = `${asset.edition?.scheme}\u0000${asset.edition?.value}`
      push(errors, !seenProviderAssets.has(providerIdentity), `${label} duplicates a provider asset`)
      push(errors, !seenEditions.has(editionIdentity), `${label} duplicates an edition`)
      push(errors, !seenImages.has(asset.imageUrl), `${label}.imageUrl is duplicated`)
      push(errors, !seenSources.has(asset.sourcePageUrl), `${label}.sourcePageUrl is duplicated`)
      seenProviderAssets.add(providerIdentity)
      seenEditions.add(editionIdentity)
      seenImages.add(asset.imageUrl)
      seenSources.add(asset.sourcePageUrl)

      const adapter = providerAdapters.get(asset.provider)
      const catalogBook = catalogById?.get(workId)
      if (adapter) {
        push(errors, adapter.validatePolicy(providerPolicy), `${label} provider policy is unsupported or stale`)
        push(errors, adapter.validateAsset(asset, catalogBook), `${label} provider asset binding is invalid`)
        const runtimeFieldNames = adapter.runtimeFieldNames
        const runtimeProjection = adapter.runtimeFields(asset)
        const protectedFields = new Set(['id', 'coverUrl', 'coverSourceUrl', 'coverAsset', 'provenance'])
        push(errors, Array.isArray(runtimeFieldNames) && runtimeFieldNames.length > 0, `${label} provider runtimeFieldNames are required`)
        push(errors, Array.isArray(runtimeFieldNames)
          && new Set(runtimeFieldNames).size === runtimeFieldNames.length
          && runtimeFieldNames.every((field) => /^[A-Za-z][A-Za-z0-9]*$/u.test(field) && !protectedFields.has(field)), `${label} provider runtimeFieldNames are invalid`)
        push(errors, isObject(runtimeProjection), `${label} provider runtime projection must be an object`)
        if (Array.isArray(runtimeFieldNames) && isObject(runtimeProjection)) {
          push(errors, Object.keys(runtimeProjection).sort().join('\u0000') === [...runtimeFieldNames].sort().join('\u0000'), `${label} provider runtime projection does not match declared fields`)
        }
      }
      if (asset.lifecycle?.status === 'active') {
        push(errors, Boolean(adapter), `${label} uses an unsupported active provider`)
        if (adapter) {
          push(errors, isTrustedHttpsUrl(adapter.displayUrl(asset)), `${label} provider display URL is invalid`)
          push(errors, isTrustedHttpsUrl(adapter.sourceUrl(asset)), `${label} provider source URL is invalid`)
        }
      }
    }
  }
  return { errors, assets }
}

export function assertValidApprovedCovers(snapshot, options) {
  const result = validateApprovedCovers(snapshot, options)
  if (result.errors.length) {
    throw new Error(`approved cover validation failed (${result.errors.length}):\n${result.errors.slice(0, 80).map((error) => `- ${error}`).join('\n')}`)
  }
  return result
}

function blockedBook(book, reason) {
  return {
    ...book,
    coverUrl: null,
    coverSourceUrl: null,
    coverAsset: undefined,
    provenance: {
      ...book.provenance,
      coverStatus: 'blocked-known-mismatch',
      coverBlockReason: reason,
      coverAssetId: null,
      coverAssetImageSha256: null,
      coverSidecarContentSha256: null,
      coverPurgeKey: null,
    },
  }
}

/** Apply the committed sidecar without network access. Non-active records remain auditable but never render. */
export function applyApprovedCoversToBooks(books, snapshot, {
  now = new Date(),
  providerAdapters = COVER_PROVIDER_ADAPTERS,
} = {}) {
  assertValidApprovedCovers(snapshot, { catalogBooks: books, now, providerAdapters })
  const byWork = new Map(snapshot.works.map((work) => [work.workId, work.assets[0]]))
  return books.map((book) => {
    const blockReason = COVER_BLOCKLIST.get(book.id)
    if (blockReason) return blockedBook(book, blockReason)
    const asset = byWork.get(book.id)
    if (!asset) return book
    const active = asset.reviewStatus === 'approved' && asset.lifecycle.status === 'active'
    const adapter = providerAdapters.get(asset.provider)
    const base = { ...book }
    if (!active && adapter) {
      const retained = new Set(adapter.allowNonSidecarRuntimeFields || [])
      for (const field of adapter.runtimeFieldNames || []) if (!retained.has(field)) delete base[field]
    }
    return {
      ...base,
      ...(active ? adapter.runtimeFields(asset) : {}),
      coverUrl: active ? adapter.displayUrl(asset) : null,
      coverSourceUrl: active ? adapter.sourceUrl(asset) : null,
      imageKind: '书籍封面',
      coverAsset: structuredClone(asset),
      provenance: {
        ...book.provenance,
        coverStatus: active ? 'approved-exact-edition' : `approved-cover-${asset.lifecycle.status}`,
        coverBlockReason: null,
        coverAssetId: asset.id,
        coverAssetImageSha256: asset.audit.imageSha256,
        coverSidecarContentSha256: snapshot.contentSha256,
        coverPurgeKey: asset.lifecycle.purgeKey,
      },
    }
  })
}

export function applyApprovedCoversToSnapshot(catalog, snapshot, {
  now = new Date(),
  providerAdapters = COVER_PROVIDER_ADAPTERS,
} = {}) {
  const books = applyApprovedCoversToBooks(catalog.books, snapshot, { now, providerAdapters })
  const withCovers = books.filter((book) => book.coverUrl).length
  return {
    ...catalog,
    provenance: {
      ...catalog.provenance,
      approvedCoverSidecar: {
        schemaVersion: snapshot.schemaVersion,
        contentSha256: snapshot.contentSha256,
        importedAt: snapshot.importedAt,
        source: structuredClone(snapshot.source),
        providerPolicies: structuredClone(snapshot.providerPolicies),
        removalContactUrl: snapshot.removalContactUrl,
        activeAssetCount: snapshot.works.reduce((count, work) => count + work.assets.filter((asset) => asset.reviewStatus === 'approved' && asset.lifecycle.status === 'active').length, 0),
      },
    },
    ...(catalog.quality
      ? { quality: { ...catalog.quality, coverCoverage: Number((withCovers / Math.max(books.length, 1)).toFixed(3)) } }
      : {}),
    books,
  }
}

export function assertApprovedCoverOverlay(books, snapshot, {
  now = new Date(),
  providerAdapters = COVER_PROVIDER_ADAPTERS,
} = {}) {
  const expected = applyApprovedCoversToBooks(books, snapshot, { now, providerAdapters })
  const sidecarIds = new Set(snapshot.works.map((work) => work.workId))
  const runtimeFieldNames = new Set()
  const exclusiveRuntimeFields = new Set()
  for (const work of snapshot.works) {
    for (const asset of work.assets) {
      const adapter = providerAdapters.get(asset.provider)
      const retained = new Set(adapter?.allowNonSidecarRuntimeFields || [])
      for (const field of adapter?.runtimeFieldNames || []) {
        runtimeFieldNames.add(field)
        if (!retained.has(field)) exclusiveRuntimeFields.add(field)
      }
    }
  }
  const fields = (book) => ({
    coverUrl: book.coverUrl ?? null,
    coverSourceUrl: book.coverSourceUrl ?? null,
    providerRuntimeFields: Object.fromEntries([...runtimeFieldNames].sort().map((field) => [field, book[field] ?? null])),
    coverAsset: book.coverAsset ?? null,
    coverStatus: book.provenance?.coverStatus ?? null,
    coverBlockReason: book.provenance?.coverBlockReason ?? null,
    coverAssetId: book.provenance?.coverAssetId ?? null,
    coverAssetImageSha256: book.provenance?.coverAssetImageSha256 ?? null,
    coverSidecarContentSha256: book.provenance?.coverSidecarContentSha256 ?? null,
    coverPurgeKey: book.provenance?.coverPurgeKey ?? null,
  })
  const errors = []
  for (let index = 0; index < books.length; index += 1) {
    const book = books[index]
    if (!sidecarIds.has(book.id) && !COVER_BLOCKLIST.has(book.id)) {
      const status = String(book.provenance?.coverStatus || '')
      const forged = Object.hasOwn(book, 'coverAsset')
        || status === 'approved-exact-edition'
        || status.startsWith('approved-cover-')
        || [...exclusiveRuntimeFields].some((field) => Object.hasOwn(book, field))
        || ['coverAssetId', 'coverAssetImageSha256', 'coverSidecarContentSha256', 'coverPurgeKey']
          .some((field) => Object.hasOwn(book.provenance || {}, field))
      if (forged) errors.push(`${book.id || index} has approved overlay fields but is absent from the sidecar`)
    }
    if (JSON.stringify(fields(book)) !== JSON.stringify(fields(expected[index]))) {
      errors.push(`${books[index]?.id || index} does not match the approved cover overlay`)
    }
  }
  if (errors.length) throw new Error(errors.join('\n'))
  return true
}
