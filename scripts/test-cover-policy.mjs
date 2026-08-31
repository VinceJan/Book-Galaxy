#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkApprovedCoverArtifacts,
  reconstructPinnedSourceSnapshot,
} from './check-approved-covers.mjs'
import {
  DEFAULT_GALLERY_PROVENANCE_FIXTURE,
  importGalleryApprovedCovers,
  readAllowedGalleryGitObject,
  readAllowedGalleryProvenanceFixture,
  validateGalleryCandidatePayload,
} from './import-approved-covers.mjs'
import {
  GALLERY_SOURCE_PATH,
  GALLERY_SOURCE_REVISION,
  COVER_REVIEW_VERSION,
  applyApprovedCoversToBooks,
  applyApprovedCoversToSnapshot,
  assertApprovedCoverOverlay,
  assertApprovedCoversSourceDerived,
  sixMonthRecheckAfter,
  validateApprovedCovers,
  withApprovedCoversContentHash,
} from './lib/cover-policy.mjs'
import {
  provenanceFixtureContentSha256,
  verifyGalleryProvenanceFixture,
} from './lib/git-object-provenance.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GALLERY_REPO = 'D:/Projects/Book-Gallery'
const VALIDATION_TIME = new Date('2026-09-01T00:00:00.000Z')

function stable(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function errors(snapshot, catalogBooks, now = VALIDATION_TIME, providerAdapters) {
  return validateApprovedCovers(snapshot, { catalogBooks, now, providerAdapters }).errors.join('\n')
}

function transitionSnapshot(snapshot, status, workIndex = 0) {
  const transitioned = structuredClone(snapshot)
  const works = workIndex === null ? transitioned.works : [transitioned.works[workIndex]]
  for (const work of works) {
    const asset = work.assets[0]
    asset.lifecycle = {
      status,
      purgeKey: asset.lifecycle.purgeKey,
      transition: {
        from: 'active',
        changedAt: VALIDATION_TIME.toISOString(),
        reason: `focused ${status} lifecycle test`,
        reviewVersion: COVER_REVIEW_VERSION,
      },
    }
  }
  return withApprovedCoversContentHash(transitioned)
}

function galleryCandidateFromSnapshot(snapshot) {
  const works = snapshot.works.map((work) => ({
    workId: work.workId,
    assets: work.assets.map((asset) => {
      const { corsEvidence: _corsEvidence, ...audit } = asset.audit
      const {
        providerTermsUrl: _providerTermsUrl,
        guidanceUrl: _guidanceUrl,
        policyVersion: _policyVersion,
        providerReportUrl: _providerReportUrl,
        removalContactUrl: _removalContactUrl,
        reviewedAt: _reviewedAt,
        reviewVersion: _reviewVersion,
        recheckAfter: _recheckAfter,
        ...rights
      } = asset.rights
      const { lifecycle: _lifecycle, ...sourceAsset } = asset
      return { ...sourceAsset, audit, rights }
    }),
  }))
  return {
    schemaVersion: 'book-gallery/covers-v1',
    import: {
      sourceKind: 'book-galaxy',
      sourceRevision: snapshot.source.upstreamCatalogRevision,
      sourceCatalogSha256: snapshot.source.upstreamCatalogSha256,
      importedAt: snapshot.importedAt,
    },
    works,
  }
}

const [catalogBuffer, manifestBuffer, committedBuffer, richBuffer, fixtureBuffer] = await Promise.all([
  readFile(resolve(ROOT, 'public/data/catalog.json')),
  readFile(resolve(ROOT, 'public/data/manifest.json')),
  readFile(resolve(ROOT, 'data/covers/approved-v1.json')),
  readFile(resolve(ROOT, 'data/rich/books.json')),
  readFile(DEFAULT_GALLERY_PROVENANCE_FIXTURE),
])
const catalog = JSON.parse(catalogBuffer.toString('utf8'))
const manifest = JSON.parse(manifestBuffer.toString('utf8'))
const rich = JSON.parse(richBuffer.toString('utf8'))
const committed = JSON.parse(committedBuffer.toString('utf8'))
const fixture = JSON.parse(fixtureBuffer.toString('utf8'))
const verifiedFixture = verifyGalleryProvenanceFixture(fixture)
assert.equal(verifiedFixture.payloadSha256, committed.source.payloadSha256)
{
  const tamperedFixture = structuredClone(fixture)
  const blob = tamperedFixture.objects.find((object) => object.type === 'blob')
  const bytes = Buffer.from(blob.contentBase64, 'base64')
  bytes[0] ^= 1
  blob.contentBase64 = bytes.toString('base64')
  tamperedFixture.contentSha256 = provenanceFixtureContentSha256(tamperedFixture)
  assert.throws(() => verifyGalleryProvenanceFixture(tamperedFixture), /Git OID mismatch/u)
}
await assert.rejects(readAllowedGalleryProvenanceFixture({
  fixturePath: resolve(ROOT, 'data/covers/provenance/missing.json'),
}), /cannot be read/u)

const fixtureAttestedObject = await readAllowedGalleryProvenanceFixture({
  fixturePath: DEFAULT_GALLERY_PROVENANCE_FIXTURE,
})
const imported = reconstructPinnedSourceSnapshot({
  attestedObject: fixtureAttestedObject,
  catalogBuffer,
  manifest,
})
assertApprovedCoversSourceDerived(committed, imported)
assert.equal(imported.works.length, 6)
assert.equal(imported.works.every((work) => work.assets[0].lifecycle.status === 'active'), true)
assert.equal(imported.works[0].assets[0].rights.recheckAfter, '2027-02-28T05:30:00.000Z')
{
  const quarantinedClone = transitionSnapshot(committed, 'quarantined')
  assert.equal(errors(quarantinedClone, catalog.books), '')
  assertApprovedCoversSourceDerived(quarantinedClone, imported)
  const immutableTamper = structuredClone(quarantinedClone)
  immutableTamper.works[0].assets[0].width += 1
  const rehashedTamper = withApprovedCoversContentHash(immutableTamper)
  assert.throws(() => assertApprovedCoversSourceDerived(rehashedTamper, imported), /immutable source-derived fields differ/u)
}

await assert.rejects(readAllowedGalleryGitObject({
  gitRepo: ROOT,
  sourceRevision: GALLERY_SOURCE_REVISION,
  sourcePath: GALLERY_SOURCE_PATH,
}), /repository is not allowed/u)
await assert.rejects(readAllowedGalleryGitObject({
  gitRepo: GALLERY_REPO,
  sourceRevision: '0'.repeat(40),
  sourcePath: GALLERY_SOURCE_PATH,
}), /revision is not the allowed/u)
await assert.rejects(readAllowedGalleryGitObject({
  gitRepo: GALLERY_REPO,
  sourceRevision: GALLERY_SOURCE_REVISION,
  sourcePath: 'public/data/wrong.json',
}), /path is not the allowed/u)
const candidateBuffer = stable(galleryCandidateFromSnapshot(committed))
assert.throws(() => importGalleryApprovedCovers({
  payloadBuffer: candidateBuffer,
  catalogBuffer,
  manifest,
  now: VALIDATION_TIME,
}), /requires an attested Git object/u)

const sourceCandidate = validateGalleryCandidatePayload(candidateBuffer)
{
  const candidate = structuredClone(sourceCandidate)
  candidate.works[0].assets[0].reviewStatus = 'candidate'
  assert.throws(() => validateGalleryCandidatePayload(stable(candidate)), /candidates are never imported/u)
}
{
  const blocked = structuredClone(sourceCandidate)
  blocked.works[0].workId = 'Q921522'
  assert.throws(() => validateGalleryCandidatePayload(stable(blocked)), /cover-blocked/u)
}
{
  const driftedManifest = structuredClone(manifest)
  driftedManifest.catalogSha256 = '1'.repeat(64)
  assert.throws(() => importGalleryApprovedCovers({
    attestedObject: fixtureAttestedObject,
    catalogBuffer,
    manifest: driftedManifest,
    now: VALIDATION_TIME,
  }), /manifest catalog SHA/u)
}

const firstWork = imported.works[0]
const single = withApprovedCoversContentHash({ ...structuredClone(imported), works: [structuredClone(firstWork)] })
const memberBook = structuredClone(catalog.books.find((book) => book.id === firstWork.workId))
const baseBooks = [memberBook]
assert.equal(applyApprovedCoversToBooks(baseBooks, single, { now: VALIDATION_TIME })[0].coverUrl.includes('-M.jpg?default=false'), true)

{
  const tampered = structuredClone(single)
  tampered.works[0].assets[0].width += 1
  assert.match(errors(tampered, baseBooks), /contentSha256 does not match/u)
}

{
  const duplicated = structuredClone(imported)
  duplicated.works[1].assets[0].audit.imageSha256 = duplicated.works[0].assets[0].audit.imageSha256
  const rehashed = withApprovedCoversContentHash(duplicated)
  assert.match(errors(rehashed, catalog.books), /audit.imageSha256 is duplicated/u)
}

{
  const duplicated = structuredClone(single)
  duplicated.works.push({ workId: 'Q2', assets: [structuredClone(duplicated.works[0].assets[0])] })
  duplicated.works[1].assets[0].id = 'second-id'
  duplicated.works[1].assets[0].audit.imageSha256 = '1'.repeat(64)
  const catalogBooks = [...baseBooks, { id: 'Q2', openLibraryId: duplicated.works[1].assets[0].providerWorkId }]
  const rehashed = withApprovedCoversContentHash(duplicated)
  assert.match(errors(rehashed, catalogBooks), /duplicates a provider asset/u)
  assert.match(errors(rehashed, catalogBooks), /purgeKey is duplicated/u)
}

for (const field of ['sourcePageUrl', 'imageUrl']) {
  const tampered = structuredClone(single)
  tampered.works[0].assets[0][field] = field === 'sourcePageUrl'
    ? 'https://openlibrary.org/books/OL999M'
    : 'https://covers.openlibrary.org/b/id/999-L.jpg?default=false'
  assert.match(errors(withApprovedCoversContentHash(tampered), baseBooks), /provider asset binding is invalid/u)
}

{
  const missing = structuredClone(single)
  delete missing.works[0].assets[0].rights.providerTermsUrl
  assert.match(errors(withApprovedCoversContentHash(missing), baseBooks), /providerTermsUrl/u)
  assert.match(errors(single, baseBooks, new Date('2027-02-28T05:30:00.000Z')), /policy review has expired/u)
}

for (const corsEvidence of [
  { state: 'allowed-origin', origin: 'https://covers.openlibrary.org' },
  { state: 'server-only' },
  { state: 'not-applicable' },
]) {
  const corsVariant = structuredClone(single)
  corsVariant.works[0].assets[0].audit.corsEvidence = corsEvidence
  assert.equal(errors(withApprovedCoversContentHash(corsVariant), baseBooks), '')
}

{
  const futureSource = structuredClone(single)
  futureSource.importedAt = '2099-01-01T00:00:00.000Z'
  assert.match(errors(withApprovedCoversContentHash(futureSource), baseBooks), /importedAt cannot be in the future/u)
}
{
  const futureAudit = structuredClone(single)
  const asset = futureAudit.works[0].assets[0]
  asset.audit.checkedAt = '2099-01-01T00:00:00.000Z'
  asset.rights.reviewedAt = '2099-01-01T00:00:00.000Z'
  asset.rights.recheckAfter = sixMonthRecheckAfter(asset.rights.reviewedAt)
  const result = errors(withApprovedCoversContentHash(futureAudit), baseBooks)
  assert.match(result, /audit.checkedAt cannot be in the future/u)
  assert.match(result, /rights.reviewedAt cannot be in the future/u)
}
{
  const reversed = structuredClone(single)
  const asset = reversed.works[0].assets[0]
  asset.rights.reviewedAt = '2026-08-30T05:30:00.000Z'
  asset.rights.recheckAfter = sixMonthRecheckAfter(asset.rights.reviewedAt)
  assert.match(errors(withApprovedCoversContentHash(reversed), baseBooks), /reviewedAt cannot precede/u)
}

{
  const generic = structuredClone(single)
  const asset = generic.works[0].assets[0]
  asset.id = 'fake-cover-asset-1'
  asset.edition = { scheme: 'fake-edition', value: 'edition-1' }
  asset.imageUrl = 'https://images.fake.example/assets/1.png'
  asset.sourcePageUrl = 'https://catalog.fake.example/editions/1'
  asset.provider = 'fake-provider'
  asset.providerWorkId = 'fake-work-1'
  asset.providerAssetId = 'fake-asset-1'
  asset.audit.contentType = 'image/png'
  asset.audit.corsEvidence = { state: 'allowed-origin', origin: 'https://images.fake.example' }
  asset.rights.providerTermsUrl = 'https://fake.example/terms'
  asset.rights.guidanceUrl = 'https://fake.example/covers-guide'
  asset.rights.policyVersion = 'fake-policy-v1'
  asset.rights.providerReportUrl = 'https://fake.example/reports/edition-1'
  asset.lifecycle.purgeKey = 'cover:fake-provider:fake-asset-1:work:edition-1'
  generic.providerPolicies = {
    'fake-provider': {
      version: 'fake-policy-v1',
      guidanceUrl: 'https://fake.example/covers-guide',
      termsUrl: 'https://fake.example/terms',
    },
  }
  const fakeCatalog = [{ id: firstWork.workId, fakeWorkId: 'fake-work-1' }]
  const fakeAdapters = new Map([['fake-provider', {
    validatePolicy: (policy) => policy?.version === 'fake-policy-v1',
    validateAsset: (candidate, book) => candidate.providerWorkId === book?.fakeWorkId,
    displayUrl: () => 'https://images.fake.example/assets/1-medium.png',
    sourceUrl: (candidate) => candidate.sourcePageUrl,
    runtimeFieldNames: ['fakeProviderWorkId'],
    runtimeFields: (candidate) => ({ fakeProviderWorkId: candidate.providerWorkId }),
  }]])
  const rehashed = withApprovedCoversContentHash(generic)
  assert.equal(errors(rehashed, fakeCatalog, VALIDATION_TIME, fakeAdapters), '')
  const applied = applyApprovedCoversToBooks(fakeCatalog, rehashed, { now: VALIDATION_TIME, providerAdapters: fakeAdapters })[0]
  assert.equal(applied.coverUrl, 'https://images.fake.example/assets/1-medium.png')
  assert.equal(applied.fakeProviderWorkId, 'fake-work-1')
  assert.equal(applied.openLibraryId, undefined)
  const tamperedRuntime = structuredClone(applied)
  tamperedRuntime.fakeProviderWorkId = 'forged-work'
  assert.throws(() => assertApprovedCoverOverlay([tamperedRuntime], rehashed, {
    now: VALIDATION_TIME,
    providerAdapters: fakeAdapters,
  }), /does not match the approved cover overlay/u)
  assert.throws(() => assertApprovedCoverOverlay([
    applied,
    { id: 'Q999998', fakeProviderWorkId: 'injected-work', provenance: { coverStatus: 'no-cover-found' } },
  ], rehashed, {
    now: VALIDATION_TIME,
    providerAdapters: fakeAdapters,
  }), /absent from the sidecar/u)
}

{
  const unsupported = structuredClone(single)
  unsupported.works[0].assets[0].provider = 'unknown-provider'
  assert.match(errors(withApprovedCoversContentHash(unsupported), baseBooks), /unsupported active provider/u)
}

{
  const expectedBooks = applyApprovedCoversToBooks([
    structuredClone(memberBook),
    { id: 'Q999999', coverUrl: null, coverSourceUrl: null, provenance: { coverStatus: 'no-cover-found' } },
  ], single, { now: VALIDATION_TIME })
  expectedBooks[1].coverAsset = structuredClone(firstWork.assets[0])
  expectedBooks[1].provenance = {
    ...expectedBooks[1].provenance,
    coverStatus: 'approved-exact-edition',
    coverSidecarContentSha256: single.contentSha256,
  }
  assert.throws(() => assertApprovedCoverOverlay(expectedBooks, single, { now: VALIDATION_TIME }), /absent from the sidecar/u)
}

{
  const invalid = structuredClone(single)
  invalid.works[0].assets[0].lifecycle.status = 'pending'
  assert.match(errors(withApprovedCoversContentHash(invalid), baseBooks), /lifecycle.status is invalid/u)
  const missingTransition = structuredClone(single)
  missingTransition.works[0].assets[0].lifecycle.status = 'quarantined'
  assert.match(errors(withApprovedCoversContentHash(missingTransition), baseBooks), /inactive transition is required/u)
  const futureTransition = transitionSnapshot(single, 'removed')
  futureTransition.works[0].assets[0].lifecycle.transition.changedAt = '2099-01-01T00:00:00.000Z'
  const rehashedFuture = withApprovedCoversContentHash(futureTransition)
  assert.match(errors(rehashedFuture, baseBooks), /transition.changedAt cannot be in the future/u)
}

const EXPIRED_CHECK_TIME = new Date('2030-01-01T00:00:00.000Z')
assert.throws(() => checkApprovedCoverArtifacts({
  sidecar: imported,
  pinnedSourceSnapshot: imported,
  rich,
  catalog,
  manifest,
  now: EXPIRED_CHECK_TIME,
}), /rights policy review has expired/u)
const expiredInactiveOfficialChecks = []
for (const status of ['quarantined', 'removed']) {
  const rehashed = transitionSnapshot(single, status)
  assert.equal(errors(rehashed, baseBooks, EXPIRED_CHECK_TIME), '')
  const applied = applyApprovedCoversToBooks(baseBooks, rehashed, { now: EXPIRED_CHECK_TIME })[0]
  assert.equal(applied.coverUrl, null)
  assert.equal(applied.coverSourceUrl, null)
  assert.equal(applied.coverAsset.lifecycle.status, status)

  const fullRehashed = transitionSnapshot(imported, status, null)
  const richArtifact = applyApprovedCoversToSnapshot(structuredClone(rich), fullRehashed, { now: EXPIRED_CHECK_TIME })
  const catalogArtifact = applyApprovedCoversToSnapshot(structuredClone(catalog), fullRehashed, { now: EXPIRED_CHECK_TIME })
  const manifestArtifact = structuredClone(manifest)
  manifestArtifact.sources.covers.approvedSidecar = structuredClone(richArtifact.provenance.approvedCoverSidecar)
  manifestArtifact.coverage.covers.count = catalogArtifact.books.filter((book) => book.coverUrl).length
  const checked = checkApprovedCoverArtifacts({
    sidecar: fullRehashed,
    pinnedSourceSnapshot: imported,
    rich: richArtifact,
    catalog: catalogArtifact,
    manifest: manifestArtifact,
    now: EXPIRED_CHECK_TIME,
  })
  assert.equal(checked.activeExactEditions, 0)
  assert.equal(checked.covers, 561)
  expiredInactiveOfficialChecks.push({ status, activeExactEditions: checked.activeExactEditions, covers: checked.covers })
}

console.log(JSON.stringify({
  ok: true,
  tests: 32,
  strictGitObject: `${GALLERY_SOURCE_REVISION}:${GALLERY_SOURCE_PATH}`,
  committedFixtureVerified: true,
  expiredLifecycleOfficialCheck: {
    now: EXPIRED_CHECK_TIME.toISOString(),
    activeRejected: true,
    inactiveResults: expiredInactiveOfficialChecks,
  },
  checks: [
    'Git-object attestation and untrusted candidate separation',
    'overlay membership', 'provider-agnostic adapter', 'future timestamps',
    'duplicate image bytes', 'inactive lifecycle/expiry and official checker',
    'payload/content hashes', 'blocklist', 'catalog drift', 'URL/provider binding',
  ],
}, null, 2))
