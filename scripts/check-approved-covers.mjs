#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COVER_BLOCKLIST,
  COVER_GUIDANCE_URL,
  COVER_POLICY_VERSION,
  COVER_PROVIDER_ADAPTERS,
  COVER_REMOVAL_CONTACT_URL,
  COVER_TERMS_URL,
  GALLERY_SOURCE_BLOB_OID,
  GALLERY_SOURCE_PATH,
  GALLERY_SOURCE_PAYLOAD_SHA256,
  GALLERY_SOURCE_REVISION,
  assertApprovedCoverOverlay,
  assertApprovedCoversSourceDerived,
  assertValidApprovedCovers,
} from './lib/cover-policy.mjs'
import {
  DEFAULT_GALLERY_PROVENANCE_FIXTURE,
  importGalleryApprovedCovers,
  readAllowedGalleryProvenanceFixture,
} from './import-approved-covers.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_QIDS = ['Q1760054', 'Q180736', 'Q3140506', 'Q607112', 'Q70784', 'Q753894']
const EXPECTED = {
  upstreamCatalogRevision: 'a7d3ae237bb0e2cf8accd0444ec49fa1269a743c',
  upstreamCatalogSha256: '1bbbc85c8e4c25c0eef0d2076873a87df1e3d2c3f50458a4129e3ce9693b8ade',
  importedAt: '2026-08-31T05:30:00.000Z',
}

export function reconstructPinnedSourceSnapshot({ attestedObject, catalogBuffer, manifest }) {
  return importGalleryApprovedCovers({
    attestedObject,
    catalogBuffer,
    manifest,
    now: new Date(EXPECTED.importedAt),
  })
}

export function checkApprovedCoverArtifacts({ sidecar, pinnedSourceSnapshot, rich, catalog, manifest, now = new Date() }) {
  assertValidApprovedCovers(sidecar, { catalogBooks: catalog.books, now })
  const pinnedValidationTime = new Date(pinnedSourceSnapshot.importedAt)
  assert.ok(Number.isFinite(pinnedValidationTime.getTime()), 'pinned source importedAt must be a valid historical timestamp')
  assertValidApprovedCovers(pinnedSourceSnapshot, { catalogBooks: catalog.books, now: pinnedValidationTime })
  assertApprovedCoversSourceDerived(sidecar, pinnedSourceSnapshot)
  assert.deepEqual(sidecar.works.map((work) => work.workId), EXPECTED_QIDS)
  assert.equal(sidecar.source.revision, GALLERY_SOURCE_REVISION)
  assert.equal(sidecar.source.path, GALLERY_SOURCE_PATH)
  assert.equal(sidecar.source.payloadSha256, GALLERY_SOURCE_PAYLOAD_SHA256)
  assert.deepEqual(sidecar.source.gitObject, {
    kind: 'git-object',
    commit: GALLERY_SOURCE_REVISION,
    path: GALLERY_SOURCE_PATH,
    blobOid: GALLERY_SOURCE_BLOB_OID,
  })
  assert.equal(sidecar.source.upstreamCatalogRevision, EXPECTED.upstreamCatalogRevision)
  assert.equal(sidecar.source.upstreamCatalogSha256, EXPECTED.upstreamCatalogSha256)
  assert.equal(sidecar.importedAt, EXPECTED.importedAt)
  assert.equal(sidecar.providerPolicies['open-library'].version, COVER_POLICY_VERSION)
  assert.equal(sidecar.providerPolicies['open-library'].guidanceUrl, COVER_GUIDANCE_URL)
  assert.equal(sidecar.providerPolicies['open-library'].termsUrl, COVER_TERMS_URL)
  assert.equal(sidecar.removalContactUrl, COVER_REMOVAL_CONTACT_URL)

  const sidecarIds = new Set(sidecar.works.map((work) => work.workId))
  const activeAssets = sidecar.works.flatMap((work) => work.assets
    .filter((asset) => asset.reviewStatus === 'approved' && asset.lifecycle.status === 'active')
    .map((asset) => ({ workId: work.workId, asset })))
  const lifecycle = { active: 0, quarantined: 0, removed: 0 }
  for (const asset of sidecar.works.flatMap((work) => work.assets)) lifecycle[asset.lifecycle.status] += 1

  let expectedCoverCount = null
  for (const books of [rich.books, catalog.books]) {
    assertApprovedCoverOverlay(books, sidecar, { now })
    for (const [qid, reason] of COVER_BLOCKLIST) {
      const book = books.find((entry) => entry.id === qid)
      if (!book) continue
      assert.equal(book.coverUrl, null)
      assert.equal(book.coverSourceUrl, null)
      assert.equal(book.provenance?.coverBlockReason, reason)
    }
    for (const work of sidecar.works) {
      const book = books.find((entry) => entry.id === work.workId)
      const asset = work.assets[0]
      assert.deepEqual(book.coverAsset, asset)
      assert.equal(book.provenance.coverSidecarContentSha256, sidecar.contentSha256)
      assert.equal(book.provenance.coverAssetImageSha256, asset.audit.imageSha256)
      if (asset.lifecycle.status === 'active') {
        const adapter = COVER_PROVIDER_ADAPTERS.get(asset.provider)
        assert.ok(adapter)
        assert.equal(book.coverSourceUrl, adapter.sourceUrl(asset))
        assert.equal(book.coverUrl, adapter.displayUrl(asset))
        assert.equal(book.provenance.coverStatus, 'approved-exact-edition')
      } else {
        assert.equal(book.coverUrl, null)
        assert.equal(book.coverSourceUrl, null)
        assert.equal(book.provenance.coverStatus, `approved-cover-${asset.lifecycle.status}`)
      }
    }
    const nonSidecarCovers = books.filter((book) => !sidecarIds.has(book.id) && book.coverUrl).length
    const derivedCoverCount = nonSidecarCovers + activeAssets.length
    assert.equal(books.filter((book) => book.coverUrl).length, derivedCoverCount)
    expectedCoverCount ??= derivedCoverCount
    assert.equal(derivedCoverCount, expectedCoverCount)
  }

  assert.equal(rich.provenance.approvedCoverSidecar.contentSha256, sidecar.contentSha256)
  assert.equal(rich.provenance.approvedCoverSidecar.activeAssetCount, activeAssets.length)
  assert.equal(manifest.sources.covers.approvedSidecar.contentSha256, sidecar.contentSha256)
  assert.equal(manifest.sources.covers.approvedSidecar.activeAssetCount, activeAssets.length)
  assert.equal(manifest.sources.covers.approvedSidecar.removalContactUrl, COVER_REMOVAL_CONTACT_URL)
  assert.equal(manifest.sources.covers.approvedSidecar.providerPolicies['open-library'].termsUrl, COVER_TERMS_URL)
  assert.equal(manifest.coverage.covers.count, expectedCoverCount)

  return {
    schemaVersion: sidecar.schemaVersion,
    qids: EXPECTED_QIDS,
    exactEditions: sidecar.works.length,
    activeExactEditions: activeAssets.length,
    covers: expectedCoverCount,
    contentSha256: sidecar.contentSha256,
    payloadSha256: sidecar.source.payloadSha256,
    lifecycle,
  }
}

async function main() {
  const [sidecarBuffer, richBuffer, catalogBuffer, manifestBuffer] = await Promise.all([
    readFile(resolve(ROOT, 'data/covers/approved-v1.json')),
    readFile(resolve(ROOT, 'data/rich/books.json')),
    readFile(resolve(ROOT, 'public/data/catalog.json')),
    readFile(resolve(ROOT, 'public/data/manifest.json')),
  ])
  const sidecar = JSON.parse(sidecarBuffer.toString('utf8'))
  const rich = JSON.parse(richBuffer.toString('utf8'))
  const catalog = JSON.parse(catalogBuffer.toString('utf8'))
  const manifest = JSON.parse(manifestBuffer.toString('utf8'))
  const attestedObject = await readAllowedGalleryProvenanceFixture({ fixturePath: DEFAULT_GALLERY_PROVENANCE_FIXTURE })
  const pinnedSourceSnapshot = reconstructPinnedSourceSnapshot({ attestedObject, catalogBuffer, manifest })
  console.log(JSON.stringify({
    ok: true,
    ...checkApprovedCoverArtifacts({ sidecar, pinnedSourceSnapshot, rich, catalog, manifest }),
  }, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
