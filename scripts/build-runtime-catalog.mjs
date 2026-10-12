#!/usr/bin/env node
/**
 * Derive the browser snapshot (public/data/catalog.runtime.json) from the
 * audited catalog (public/data/catalog.json).
 *
 * The audited catalog keeps every eligibility trace, provenance record and
 * edge statistic for review.  The browser needs only what it renders or
 * navigates by, so this step drops audit-only fields, rounds layout floats and
 * adds a verbatim lead "hook" per book.  `--check` fails when the committed
 * runtime file is stale.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { bookHook } from './lib/book-hook.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INPUT = resolve(ROOT, 'public/data/catalog.json')
const OUTPUT = resolve(ROOT, 'public/data/catalog.runtime.json')
const check = process.argv.includes('--check')

const round = (value, digits = 4) => (typeof value === 'number' && Number.isFinite(value)
  ? Number(value.toFixed(digits))
  : value)
const roundRecord = (record) => record && Object.fromEntries(Object.entries(record).map(([key, value]) => [key, round(value)]))
const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null))

function slimBook(book) {
  return compact({
    id: book.id,
    title: book.title,
    wikipediaTitle: book.wikipediaTitle,
    aliases: book.aliases,
    instanceOf: book.instanceOf?.map(({ id, label }) => ({ id, label })),
    eligibility: book.eligibility ? { accepted: book.eligibility.accepted, reason: book.eligibility.status ?? '' } : undefined,
    originalTitle: book.originalTitle,
    foreignTitle: book.foreignTitle,
    author: book.author,
    year: book.year,
    language: book.language,
    country: book.country,
    summary: book.summary,
    hook: bookHook(book.summary),
    themes: book.themes,
    source: book.source,
    sourceUrl: book.sourceUrl,
    wikidataUrl: book.wikidataUrl,
    openLibraryId: book.openLibraryId,
    coverUrl: book.coverUrl,
    coverSourceUrl: book.coverSourceUrl,
    imageKind: book.imageKind,
    popularity: round(book.popularity),
    contentLength: book.contentLength,
    provenance: book.provenance?.wikipediaRevisionUrl
      ? { wikipediaRevisionUrl: book.provenance.wikipediaRevisionUrl }
      : undefined,
    position: book.position?.map((value) => round(value, 3)),
    localDensity: round(book.localDensity),
    outlierScore: round(book.outlierScore),
    magnitude: round(book.magnitude),
    halo: round(book.halo),
    shape: book.shape,
    temperature: round(book.temperature),
    clusterLabels: book.clusterLabels,
    // The observatory reads the nearest semantic neighbour and three nearby
    // stars; the rest of the ranked list stays in the audited catalog.
    neighbors: [...(book.neighbors ?? [])]
      .sort((left, right) => (left.semanticRank ?? 1e9) - (right.semanticRank ?? 1e9))
      .slice(0, 4)
      .map((neighbor) => compact({
      id: neighbor.id,
      semanticRank: neighbor.semanticRank,
      similarity: round(neighbor.similarity, 3),
      surprise: round(neighbor.surprise, 3),
      navigable: neighbor.navigable || undefined,
      basis: neighbor.basis,
    })),
    spatialNeighbors: book.spatialNeighbors?.slice(0, 4),
    spatialSemanticOverlap: round(book.spatialSemanticOverlap),
  })
}

function slimEdge(edge) {
  const shared = Array.isArray(edge.evidence?.sharedThemes) ? edge.evidence.sharedThemes : undefined
  return compact({
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    similarity: round(edge.similarity),
    weight: round(edge.weight),
    basis: edge.basis,
    sentence: edge.sentence,
    surprise: round(edge.surprise),
    surpriseByBook: roundRecord(edge.surpriseByBook),
    bandByBook: edge.bandByBook,
    confidence: round(edge.confidence),
    // Only the shared themes survive: the offline librarian names them.
    evidence: shared?.length ? { sharedThemes: shared } : undefined,
    provenance: edge.provenance,
  })
}

const sourceText = await readFile(INPUT, 'utf8')
const catalog = JSON.parse(sourceText)
const runtime = {
  schemaVersion: catalog.schemaVersion,
  runtimeOf: 'catalog.json',
  generatedAt: catalog.generatedAt,
  source: catalog.source,
  sourceUrl: catalog.sourceUrl,
  layoutModel: catalog.layoutModel,
  books: catalog.books.map(slimBook),
  relations: catalog.relations.map(slimEdge),
}
const text = `${JSON.stringify(runtime)}\n`
const kb = (value) => `${(value / 1024).toFixed(0)} KB`
const report = {
  audited: { raw: kb(Buffer.byteLength(sourceText)), gzip: kb(gzipSync(sourceText).length) },
  runtime: { raw: kb(Buffer.byteLength(text)), gzip: kb(gzipSync(text).length) },
  hooks: runtime.books.filter((book) => book.hook).length,
}

if (check) {
  const existing = await readFile(OUTPUT, 'utf8').catch(() => '')
  if (existing !== text) {
    console.error('catalog.runtime.json is stale; run `npm run build:data:runtime`.')
    process.exit(1)
  }
  console.log(JSON.stringify({ mode: 'check', ...report }, null, 2))
} else {
  await writeFile(OUTPUT, text)
  console.log(JSON.stringify({ mode: 'write', output: 'public/data/catalog.runtime.json', ...report }, null, 2))
}
