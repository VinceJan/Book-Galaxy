#!/usr/bin/env node
// First-paint slice of the runtime catalog: just what the star field, the
// intro search and the featured list need (~190 KB gzipped instead of ~1.2 MB).
// The full catalog.runtime.json is still fetched right after and merged in.
//   node scripts/build-core-catalog.mjs          write public/data/catalog.core.json
//   node scripts/build-core-catalog.mjs --check  fail if it is stale
import { readFileSync, writeFileSync } from 'node:fs'

const RUNTIME = new URL('../public/data/catalog.runtime.json', import.meta.url)
const CORE = new URL('../public/data/catalog.core.json', import.meta.url)
export const CORE_FIELDS = ['id', 'title', 'author', 'year', 'originalTitle', 'aliases', 'themes', 'coverUrl',
  'imageKind', 'position', 'magnitude', 'halo', 'shape', 'temperature', 'localDensity', 'outlierScore', 'clusterWeights', 'clusterLabels']
const normalize = (value) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
// First-seconds search only needs the Chinese-script alternate titles; the
// foreign-language ones (and everything else) arrive with the full catalog.
function chineseAliases(book) {
  const seen = new Set([normalize(book.title), normalize(book.originalTitle || '')])
  return (book.aliases || []).filter((alias) => {
    if (!/[\u3400-\u9fff]/u.test(alias) || /[\u3040-\u30ff\uac00-\ud7af]/u.test(alias)) return false
    const key = normalize(alias)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
const han = (value) => (value?.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu) ?? []).length

const runtime = JSON.parse(readFileSync(RUNTIME, 'utf8'))
const core = {
  schemaVersion: 'bookshelf-galaxy/catalog-core-v1',
  coreOf: runtime.generatedAt,
  source: runtime.source,
  regions: runtime.regions,
  books: runtime.books.map((book) => {
    const slim = {}
    for (const key of CORE_FIELDS) if (book[key] !== undefined && book[key] !== null) slim[key] = book[key]
    if (slim.aliases) slim.aliases = chineseAliases(book)
    if (!slim.aliases?.length) delete slim.aliases
    slim.summaryChars = han(book.summary)
    return slim
  }),
}
const text = `${JSON.stringify(core)}\n`
if (process.argv.includes('--check')) {
  let current = ''
  try { current = readFileSync(CORE, 'utf8') } catch {}
  if (current !== text) { console.error('catalog.core.json is stale: run npm run build:data:runtime'); process.exit(1) }
  console.log(`catalog.core.json up to date (${core.books.length} books)`)
} else {
  writeFileSync(CORE, text)
  console.log(`catalog.core.json: ${core.books.length} books, ${(text.length / 1024).toFixed(0)} KB`)
}
