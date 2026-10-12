#!/usr/bin/env node
/**
 * Derive the browser snapshot (public/data/catalog.runtime.json) from the
 * audited catalog (data/catalog.json).
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
import { bookHook, bookNotes } from './lib/book-hook.mjs'

/** Lead whose opening 《title》 names a different work (a data error upstream). */
const COVERS = JSON.parse(await readFile(new URL('../data/covers.json', import.meta.url), 'utf8'))
const ALIASES = JSON.parse(await readFile(new URL('../data/search-aliases.json', import.meta.url), 'utf8'))
export const leadIssues = new Map()
// Hand-checked: the Wikipedia lead fetched for this id describes a sibling work.
const CONFIRMED_MISMATCH = new Set(JSON.parse(await readFile(new URL('../data/issues/lead-confirmed.json', import.meta.url), 'utf8')))
function leadMismatch(book) {
  const first = (book.summary ?? '').slice(0, 4).includes('《') ? /《([^》]+)》/u.exec(book.summary)?.[1] : undefined
  if (!first) return false
  const norm = (value) => value.replace(/[\s·：:（）()]/gu, '')
  const a = norm(first)
  const b = norm(book.title)
  if (a.includes(b) || b.includes(a)) return false
  const shared = [...new Set(b)].filter((ch) => a.includes(ch)).length
  if (shared / new Set(b).size >= 0.6) return false
  // Alternate translations (三剑客 / 三个火枪手) are the same work; only flag leads that point at a sibling work.
  if (norm(book.summary).includes(b) || !/系列|选集|合集|续作|前作|第[一二三四五六七八九十\d]+(?:部|卷|集)(?!经)/u.test(book.summary.slice(0, 120))) return false
  const confirmed = CONFIRMED_MISMATCH.has(book.id)
  leadIssues.set(book.id, { id: book.id, title: book.title, leadNames: first, status: confirmed ? 'confirmed: lead is about another work, hook dropped' : 'review: likely an alternate translation' })
  return confirmed
}
import { buildRegions } from './lib/regions.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INPUT = resolve(ROOT, 'data/catalog.json')
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
    instanceOf: book.instanceOf?.map(({ id, label }) => ({ id, label })),
    eligibility: book.eligibility ? { accepted: book.eligibility.accepted, reason: book.eligibility.status ?? '' } : undefined,
    originalTitle: book.originalTitle,
    foreignTitle: book.foreignTitle,
    author: book.author,
    year: book.year,
    language: book.language,
    country: book.country,
    summary: book.summary,
    hook: leadMismatch(book) ? '' : bookHook(book.summary),
    notes: leadMismatch(book) ? undefined : (() => {
      const notes = bookNotes(book.summary, bookHook(book.summary))
      return Object.keys(notes).length ? notes : undefined
    })(),
    themes: book.themes,
    source: book.source,
    sourceUrl: book.sourceUrl,
    wikidataUrl: book.wikidataUrl,
    openLibraryId: book.openLibraryId,
    // Self-hosted 400px WebP covers (scripts/build-covers.py); credits in public/covers/ATTRIBUTION.md.
    coverUrl: COVERS[book.id]?.file,
    coverSourceUrl: COVERS[book.id]?.sourceUrl,
    imageKind: COVERS[book.id] ? 'cover' : undefined,
    aliases: [...new Set([...(book.aliases ?? []), ...(ALIASES[book.id] ?? [])])].slice(0, 10),
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
const names = JSON.parse(await readFile(resolve(ROOT, 'data/regions/names.json'), 'utf8')).regions
const regions = buildRegions(catalog.books).map((region) => {
  const named = names[region.key]
  if (!named?.name || !named?.question) {
    console.error(`Region ${region.key} (${region.size} books: ${region.examples.slice(0, 5).join('、')}) has no name in data/regions/names.json`)
    process.exit(1)
  }
  return {
    id: region.key,
    name: named.name,
    subtitle: named.subtitle,
    question: named.question,
    size: region.size,
    density: round(region.density, 3),
    bookIds: region.bookIds,
  }
})
const unused = Object.keys(names).filter((key) => !regions.some((region) => region.id === key))
if (unused.length) {
  console.error(`Stale region names (no matching region): ${unused.join(', ')}`)
  process.exit(1)
}
const runtime = {
  schemaVersion: catalog.schemaVersion,
  runtimeOf: 'catalog.json',
  generatedAt: catalog.generatedAt,
  source: catalog.source,
  sourceUrl: catalog.sourceUrl,
  layoutModel: catalog.layoutModel,
  books: catalog.books.map(slimBook),
  relations: catalog.relations.map(slimEdge),
  regions,
}
const text = `${JSON.stringify(runtime)}\n`
const kb = (value) => `${(value / 1024).toFixed(0)} KB`
const report = {
  audited: { raw: kb(Buffer.byteLength(sourceText)), gzip: kb(gzipSync(sourceText).length) },
  runtime: { raw: kb(Buffer.byteLength(text)), gzip: kb(gzipSync(text).length) },
  hooks: runtime.books.filter((book) => book.hook).length,
  leadIssues: leadIssues.size,
  regions: regions.map((region) => `${region.name}(${region.size})`).join(' '),
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
  await writeFile(new URL('../data/issues/lead-mismatch.json', import.meta.url), `${JSON.stringify([...leadIssues.values()], null, 2)}\n`)
  console.log(JSON.stringify({ mode: 'write', output: 'public/data/catalog.runtime.json', ...report }, null, 2))
}
