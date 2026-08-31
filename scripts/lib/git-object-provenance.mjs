import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import {
  GALLERY_SOURCE_BLOB_OID,
  GALLERY_SOURCE_PATH,
  GALLERY_SOURCE_PAYLOAD_SHA256,
  GALLERY_SOURCE_REPO,
  GALLERY_SOURCE_REVISION,
  canonicalJson,
} from './cover-policy.mjs'

export const GALLERY_PROVENANCE_SCHEMA = 'book-galaxy/git-object-provenance-v1'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function gitObjectOid(type, content) {
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`${type} ${content.byteLength}\0`), content]))
    .digest('hex')
}

export function provenanceFixtureContentSha256(fixture) {
  const { contentSha256: _ignored, ...withoutHash } = fixture
  return createHash('sha256').update(canonicalJson(withoutHash)).digest('hex')
}

function decodeObject(record, index) {
  if (!isObject(record) || !['commit', 'tree', 'blob'].includes(record.type) || !/^[a-f0-9]{40}$/u.test(String(record.oid || ''))) {
    throw new Error(`provenance object[${index}] descriptor is invalid`)
  }
  if (typeof record.contentBase64 !== 'string') throw new Error(`provenance object[${index}] content is missing`)
  const content = Buffer.from(record.contentBase64, 'base64')
  if (content.toString('base64') !== record.contentBase64) throw new Error(`provenance object[${index}] base64 is not canonical`)
  const actualOid = gitObjectOid(record.type, content)
  if (actualOid !== record.oid) throw new Error(`provenance object[${index}] Git OID mismatch: ${actualOid}`)
  return { ...record, content }
}

function parseTree(content, treeOid) {
  const entries = []
  let offset = 0
  while (offset < content.byteLength) {
    const space = content.indexOf(0x20, offset)
    const nul = content.indexOf(0, offset)
    if (space < offset || nul <= space || nul + 21 > content.byteLength) throw new Error(`tree ${treeOid} is malformed`)
    const mode = content.subarray(offset, space).toString('ascii')
    const nameBytes = content.subarray(space + 1, nul)
    const name = nameBytes.toString('utf8')
    if (!name || name.includes('/') || Buffer.from(name, 'utf8').compare(nameBytes) !== 0) throw new Error(`tree ${treeOid} has an invalid name`)
    entries.push({ mode, name, oid: content.subarray(nul + 1, nul + 21).toString('hex') })
    offset = nul + 21
  }
  return entries
}

/** Recompute the pinned commit/tree/blob chain and return only the resolved blob bytes. */
export function verifyGalleryProvenanceFixture(fixture) {
  if (!isObject(fixture)) throw new Error('Gallery provenance fixture must be an object')
  if (fixture.schemaVersion !== GALLERY_PROVENANCE_SCHEMA) throw new Error(`Gallery provenance schema must be ${GALLERY_PROVENANCE_SCHEMA}`)
  if (fixture.repository !== GALLERY_SOURCE_REPO) throw new Error('Gallery provenance repository is invalid')
  if (fixture.commitOid !== GALLERY_SOURCE_REVISION) throw new Error('Gallery provenance commit is invalid')
  if (fixture.path !== GALLERY_SOURCE_PATH) throw new Error('Gallery provenance path is invalid')
  if (fixture.blobOid !== GALLERY_SOURCE_BLOB_OID) throw new Error('Gallery provenance blob OID is invalid')
  if (fixture.payloadSha256 !== GALLERY_SOURCE_PAYLOAD_SHA256) throw new Error('Gallery provenance payload SHA is invalid')
  if (fixture.contentSha256 !== provenanceFixtureContentSha256(fixture)) throw new Error('Gallery provenance fixture content SHA mismatch')
  if (!Array.isArray(fixture.objects) || fixture.objects.length < 3) throw new Error('Gallery provenance object chain is missing')

  const objects = new Map()
  for (const [index, record] of fixture.objects.entries()) {
    const object = decodeObject(record, index)
    if (objects.has(object.oid)) throw new Error(`Gallery provenance object is duplicated: ${object.oid}`)
    objects.set(object.oid, object)
  }
  const commit = objects.get(fixture.commitOid)
  if (commit?.type !== 'commit') throw new Error('Gallery provenance commit object is missing')
  const rootTree = /^tree ([a-f0-9]{40})$/mu.exec(commit.content.toString('utf8'))?.[1]
  if (!rootTree) throw new Error('Gallery provenance commit has no root tree')

  const visited = new Set([fixture.commitOid])
  let currentOid = rootTree
  const segments = fixture.path.split('/')
  for (const [index, segment] of segments.entries()) {
    const tree = objects.get(currentOid)
    if (tree?.type !== 'tree') throw new Error(`Gallery provenance tree is missing: ${currentOid}`)
    visited.add(currentOid)
    const entry = parseTree(tree.content, currentOid).find((candidate) => candidate.name === segment)
    if (!entry) throw new Error(`Gallery provenance path segment is missing: ${segment}`)
    const final = index === segments.length - 1
    if (!final && entry.mode !== '40000') throw new Error(`Gallery provenance path segment is not a tree: ${segment}`)
    if (final && !/^100\d{3}$/u.test(entry.mode)) throw new Error(`Gallery provenance target is not a regular blob: ${segment}`)
    currentOid = entry.oid
  }

  if (currentOid !== fixture.blobOid) throw new Error(`Gallery provenance path resolved to unexpected blob: ${currentOid}`)
  const blob = objects.get(currentOid)
  if (blob?.type !== 'blob') throw new Error('Gallery provenance blob object is missing')
  visited.add(currentOid)
  if (visited.size !== objects.size) throw new Error('Gallery provenance fixture contains unreferenced objects')
  const payloadSha256 = createHash('sha256').update(blob.content).digest('hex')
  if (payloadSha256 !== fixture.payloadSha256) throw new Error(`Gallery provenance blob payload SHA mismatch: ${payloadSha256}`)

  return Object.freeze({
    payloadBuffer: Buffer.from(blob.content),
    repo: fixture.repository,
    commit: fixture.commitOid,
    path: fixture.path,
    blobOid: fixture.blobOid,
    payloadSha256,
    fixtureContentSha256: fixture.contentSha256,
  })
}

export async function loadGalleryProvenanceFixture(path) {
  let fixture
  try {
    fixture = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`Gallery provenance fixture cannot be read: ${error instanceof Error ? error.message : error}`)
  }
  return verifyGalleryProvenanceFixture(fixture)
}
