#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dataDir = resolve(root, 'data/legacy')
const catalogPath = resolve(dataDir, 'catalog.json')
const manifestPath = resolve(dataDir, 'manifest.json')

const fail = (message) => {
  throw new Error(message)
}

const hash = (buffer) => createHash('sha256').update(buffer).digest('hex')

async function main() {
  const [catalogBuffer, manifestBuffer] = await Promise.all([
    readFile(catalogPath),
    readFile(manifestPath),
  ])
  const catalog = JSON.parse(catalogBuffer)
  const manifest = JSON.parse(manifestBuffer)
  if (catalog.schemaVersion !== 'bookshelf-galaxy/catalog-v1') fail('unexpected catalog schema')
  if (!Array.isArray(catalog.books) || catalog.books.length < 20_000) fail('need at least 20,000 books')
  if (!Array.isArray(catalog.relations) || catalog.relations.length < 50_000) fail('need at least 50,000 relations')
  if (manifest.bookCount !== catalog.books.length) fail('manifest book count mismatch')
  if (manifest.relationCount !== catalog.relations.length) fail('manifest relation count mismatch')
  if (manifest.catalogSha256 !== hash(catalogBuffer)) fail('catalog sha256 mismatch')

  const ids = new Set()
  const works = new Set()
  for (const book of catalog.books) {
    if (!book.id || ids.has(book.id)) fail(`duplicate/missing book id: ${book.id}`)
    ids.add(book.id)
    if (!book.title || !book.author || !book.language) fail(`incomplete book: ${book.id}`)
    const workKey = `${book.title.toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim()}\u0000${book.author.toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim()}`
    if (works.has(workKey)) fail(`duplicate normalized work: ${book.id}`)
    works.add(workKey)
    if (!Array.isArray(book.subjects)) fail(`subjects must be an array: ${book.id}`)
    if (!Object.prototype.hasOwnProperty.call(book, 'downloads')) fail(`downloads field missing: ${book.id}`)
    if (!Number.isInteger(book.seed)) fail(`seed must be an integer: ${book.id}`)
    if (!/^https:\/\//u.test(book.sourceUrl)) fail(`source URL missing: ${book.id}`)
  }

  const edges = new Set()
  for (const relation of catalog.relations) {
    if (!ids.has(relation.source) || !ids.has(relation.target)) fail(`dangling relation: ${relation.source}/${relation.target}`)
    if (relation.source === relation.target) fail(`self relation: ${relation.source}`)
    const key = [relation.source, relation.target].sort().join('\u0000')
    if (edges.has(key)) fail(`duplicate relation: ${key}`)
    edges.add(key)
    if (!Array.isArray(relation.basis) || relation.basis.length === 0) fail(`relation basis missing: ${key}`)
    if (!Number.isFinite(relation.weight)) fail(`relation weight missing: ${key}`)
  }

  console.log(JSON.stringify({
    ok: true,
    books: catalog.books.length,
    relations: catalog.relations.length,
    languages: new Set(catalog.books.map((book) => book.language)).size,
    sha256: manifest.catalogSha256,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
