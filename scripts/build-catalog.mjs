#!/usr/bin/env node

/**
 * Build a deterministic, offline-friendly bookshelf-galaxy catalog from the
 * Project Gutenberg machine-readable catalog.
 *
 * No third-party packages are required. The downloaded source is kept under
 * public/data/raw/ (ignored by git) and is never copied into the demo bundle.
 */

import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = resolve(ROOT, 'public/data')
const RAW_DIR = resolve(DATA_DIR, 'raw')
const DEFAULT_SOURCE_URL = 'https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz'
const DEFAULT_LIMIT = 20_000
const DEFAULT_RELATIONS = 60_000
const MIN_LIMIT = 20_000
const MIN_RELATIONS = 50_000
const USER_AGENT = 'bookshelf-galaxy-catalog-builder/1.0 (+https://www.gutenberg.org/)'

const STOP_WORDS = new Set([
  'about', 'after', 'also', 'among', 'before', 'being', 'between', 'from',
  'have', 'into', 'more', 'over', 'that', 'their', 'there', 'these', 'this',
  'through', 'under', 'were', 'which', 'with', '的', '和', '在', '对', '于',
  '与', '或', '及', '之', '等', '中', '以', '为', '一',
])

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const [rawKey, inline] = arg.slice(2).split('=', 2)
    if (inline !== undefined) options[rawKey] = inline
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) options[rawKey] = argv[++i]
    else options[rawKey] = true
  }
  return options
}

function asPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/\uFEFF/g, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function splitSemicolon(value) {
  return [...new Set(String(value ?? '')
    .split(';')
    .map(cleanText)
    .filter(Boolean))]
}

function normalize(value) {
  return cleanText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function shortLabel(value, max = 72) {
  const text = cleanText(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function firstLanguage(value) {
  return cleanText(value).split(/[;,\s]+/u).find(Boolean) || 'und'
}

function firstAuthor(value) {
  const author = splitSemicolon(value)[0] || cleanText(value)
  return shortLabel(author.replace(/\s*\[[^\]]+\]\s*$/u, ''), 96) || 'Unknown author'
}

function firstYear(value) {
  const match = String(value ?? '').match(/\b(1[0-9]{3}|20[0-9]{2}|21[0-9]{2})\b/u)
  return match ? Number(match[1]) : undefined
}

function issuedDate(value) {
  const match = String(value ?? '').match(/\b(1[0-9]{3}|20[0-9]{2}|21[0-9]{2})-[0-9]{2}-[0-9]{2}\b/u)
  return match ? match[0] : undefined
}

function hash32(value) {
  let hash = 0x811c9dc5
  for (const char of String(value)) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field.replace(/\r$/u, ''))
      if (row.some((cell) => cell.length > 0)) rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/u, ''))
    if (row.some((cell) => cell.length > 0)) rows.push(row)
  }
  return rows
}

async function fetchCatalog(sourceUrl, rawGzipPath, rawCsvPath) {
  console.log(`Downloading ${sourceUrl}`)
  const response = await fetch(sourceUrl, {
    headers: { 'accept': 'application/gzip, text/csv;q=0.9', 'user-agent': USER_AGENT },
  })
  if (!response.ok) throw new Error(`Unable to download catalog: HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(rawGzipPath, buffer)
  const csvBuffer = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer
  await writeFile(rawCsvPath, csvBuffer)
  return {
    lastModified: response.headers.get('last-modified') || undefined,
    etag: response.headers.get('etag') || undefined,
    bytes: csvBuffer.byteLength,
  }
}

async function getSource(sourceUrl, inputPath, refresh) {
  const rawGzipPath = resolve(RAW_DIR, 'pg_catalog.csv.gz')
  const rawCsvPath = inputPath ? resolve(ROOT, inputPath) : resolve(RAW_DIR, 'pg_catalog.csv')
  await mkdir(RAW_DIR, { recursive: true })

  if (inputPath && !existsSync(rawCsvPath)) {
    throw new Error(`Input catalog does not exist: ${rawCsvPath}`)
  }
  if (!inputPath && (refresh || !existsSync(rawCsvPath))) {
    const fetched = await fetchCatalog(sourceUrl, rawGzipPath, rawCsvPath)
    return { path: rawCsvPath, ...fetched }
  }
  const stat = await readFile(rawCsvPath)
  return { path: rawCsvPath, bytes: stat.byteLength }
}

function rowToBook(row, columns) {
  const rawId = cleanText(row[columns['Text#']])
  const title = cleanText(row[columns.Title])
  if (!/^\d+$/u.test(rawId) || !title) return null
  const language = firstLanguage(row[columns.Language])
  const author = firstAuthor(row[columns.Authors])
  const subjects = splitSemicolon(row[columns.Subjects])
  const shelves = splitSemicolon(row[columns.Bookshelves])
  const mergedSubjects = [...new Set([...subjects, ...shelves])].slice(0, 12)
  const id = `pg-${rawId}`
  const seed = hash32(`bookshelf-galaxy-v1:${id}`)
  const year = firstYear(row[columns.Issued])
  const book = {
    id,
    title,
    author,
    ...(year ? { year } : {}),
    language,
    subjects: mergedSubjects,
    themes: mergedSubjects.slice(0, 8),
    // pg_catalog.csv intentionally does not publish download counts.
    // null is explicit so consumers can distinguish "not reported" from zero.
    downloads: null,
    source: 'Project Gutenberg',
    sourceUrl: `https://www.gutenberg.org/ebooks/${rawId}`,
    seed,
  }
  return {
    book,
    // Gutenberg has one text record per translation/edition. The graph uses
    // one representative record per normalized title + author so a work is
    // not rendered as several stars solely because its language differs.
    key: `${normalize(title)}\u0000${normalize(author)}`,
    numericId: Number(rawId),
    subjectCount: mergedSubjects.length,
    hasKnownAuthor: author !== 'Unknown author',
  }
}

function selectBooks(rows, limit, columns) {
  const unique = new Map()
  for (const row of rows) {
    const item = rowToBook(row, columns)
    if (!item || unique.has(item.key)) continue
    unique.set(item.key, item)
  }
  const candidates = [...unique.values()]
  // Metadata-rich records keep the generated graph useful while numeric ID is
  // the stable tie-breaker. No random sampling means identical input => same
  // snapshot.
  candidates.sort((a, b) => {
    const scoreA = a.subjectCount * 4 + (a.hasKnownAuthor ? 2 : 0)
    const scoreB = b.subjectCount * 4 + (b.hasKnownAuthor ? 2 : 0)
    return scoreB - scoreA || a.numericId - b.numericId
  })
  if (candidates.length < limit) {
    throw new Error(`Catalog has only ${candidates.length} unique text works; need at least ${limit}`)
  }
  const selected = candidates.slice(0, limit)
  selected.sort((a, b) => a.numericId - b.numericId)
  return { selected, uniqueCount: candidates.length }
}

function subjectKeys(subjects) {
  const keys = []
  for (const subject of subjects) {
    const full = normalize(subject)
    if (full.length >= 3) keys.push({ key: `subject:${full}`, label: shortLabel(subject) })
    const tokens = full.split(' ').filter((token) => token.length >= 4 && !STOP_WORDS.has(token))
    for (const token of tokens.slice(0, 3)) {
      keys.push({ key: `topic:${token}`, label: shortLabel(subject) })
    }
  }
  const seen = new Set()
  return keys.filter(({ key }) => !seen.has(key) && seen.add(key)).slice(0, 10)
}

function groupMap() {
  return new Map()
}

function addGroup(map, key, index, label) {
  if (!key) return
  let group = map.get(key)
  if (!group) {
    group = { key, label, members: [], positions: new Map() }
    map.set(key, group)
  }
  group.positions.set(index, group.members.length)
  group.members.push(index)
}

function fromGroup(group, index, offset) {
  if (!group || group.members.length < 2) return undefined
  const position = group.positions.get(index)
  if (position === undefined) return undefined
  return group.members[(position + offset) % group.members.length]
}

function relationKind(type) {
  return type === 'subject' || type === 'topic' ? '回声'
    : type === 'author' ? '镜像'
      : type === 'language' ? '潮汐'
        : '暗河'
}

function relationWeight(type, offset) {
  const base = type === 'author' ? 0.92 : type === 'subject' ? 0.72 : type === 'topic' ? 0.58 : type === 'language' ? 0.28 : 0.34
  return Number(Math.max(0.12, base - Math.min(offset - 1, 6) * 0.035).toFixed(3))
}

function generateRelations(books, target) {
  const groups = {
    subject: groupMap(),
    topic: groupMap(),
    author: groupMap(),
    language: groupMap(),
    era: groupMap(),
  }
  const descriptors = []
  for (let index = 0; index < books.length; index += 1) {
    const book = books[index]
    const subjectRefs = subjectKeys(book.subjects)
    const refs = subjectRefs.map((ref) => ({ ...ref, type: ref.key.startsWith('topic:') ? 'topic' : 'subject' }))
    for (const ref of refs) addGroup(groups[ref.type], ref.key, index, ref.label)
    const authorKey = `author:${normalize(book.author)}`
    const languageKey = `language:${book.language}`
    const eraKey = `era:${book.year ? Math.floor(book.year / 10) * 10 : 'unknown'}`
    addGroup(groups.author, authorKey, index, shortLabel(book.author))
    addGroup(groups.language, languageKey, index, book.language)
    addGroup(groups.era, eraKey, index, eraKey.slice(4))
    descriptors.push({
      subjects: refs,
      author: { type: 'author', key: authorKey, label: shortLabel(book.author) },
      language: { type: 'language', key: languageKey, label: book.language },
      era: { type: 'era', key: eraKey, label: eraKey.slice(4) },
    })
  }

  const edgeMap = new Map()
  const outCounts = new Uint8Array(books.length)
  const addEdge = (sourceIndex, targetIndex, descriptor, offset) => {
    if (targetIndex === undefined || targetIndex === sourceIndex) return false
    const left = Math.min(sourceIndex, targetIndex)
    const right = Math.max(sourceIndex, targetIndex)
    const key = `${left}:${right}`
    const kind = relationKind(descriptor.type)
    const basis = descriptor.type === 'subject' || descriptor.type === 'topic'
      ? `主题:${descriptor.label}`
      : descriptor.type === 'author'
        ? `作者:${descriptor.label}`
        : descriptor.type === 'language'
          ? `语言:${descriptor.label}`
          : `年代:${descriptor.label}`
    const existing = edgeMap.get(key)
    if (existing) {
      if (!existing.basis.includes(basis)) existing.basis.push(basis)
      if (relationWeight(descriptor.type, offset) > existing.weight) {
        existing.weight = relationWeight(descriptor.type, offset)
        existing.kind = kind
      }
      return false
    }
    edgeMap.set(key, {
      source: books[left].id,
      target: books[right].id,
      kind,
      weight: relationWeight(descriptor.type, offset),
      basis: [basis],
      provenance: 'catalog',
    })
    outCounts[sourceIndex] += 1
    return true
  }

  const passes = [3, 4, 5, 6]
  for (const perBookLimit of passes) {
    for (let index = 0; index < books.length && edgeMap.size < target; index += 1) {
      if (outCounts[index] >= perBookLimit) continue
      const descriptor = descriptors[index]
      const candidates = []
      for (const subject of descriptor.subjects.slice(0, 3)) {
        const group = groups[subject.type].get(subject.key)
        for (let offset = 1; offset <= 2; offset += 1) candidates.push({ group, descriptor: subject, offset })
      }
      for (const ref of [descriptor.author, descriptor.language, descriptor.era]) {
        const group = groups[ref.type].get(ref.key)
        for (let offset = 1; offset <= 4; offset += 1) candidates.push({ group, descriptor: ref, offset })
      }
      // Stable per-node rotation avoids making the first catalog records hubs.
      const rotation = hash32(index) % Math.max(1, candidates.length)
      const rotated = candidates.slice(rotation).concat(candidates.slice(0, rotation))
      for (const candidate of rotated) {
        if (outCounts[index] >= perBookLimit) break
        const targetIndex = fromGroup(candidate.group, index, candidate.offset)
        addEdge(index, targetIndex, candidate.descriptor, candidate.offset)
      }
    }
    if (edgeMap.size >= target) break
  }

  if (edgeMap.size < MIN_RELATIONS) {
    throw new Error(`Only generated ${edgeMap.size} relations; need at least ${MIN_RELATIONS}`)
  }
  const relations = [...edgeMap.values()]
  relations.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
  return relations
}

function stableIsoDate(value, fallbackDate) {
  const supplied = value ? new Date(value) : null
  if (supplied && !Number.isNaN(supplied.getTime())) return supplied.toISOString()
  const sourceDate = fallbackDate ? new Date(`${fallbackDate}T00:00:00Z`) : new Date('1970-01-01T00:00:00Z')
  return sourceDate.toISOString()
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const limit = asPositiveInt(options.limit, DEFAULT_LIMIT)
  const targetRelations = asPositiveInt(options.relations, DEFAULT_RELATIONS)
  if (limit < MIN_LIMIT) throw new Error(`--limit must be at least ${MIN_LIMIT}`)
  if (targetRelations < MIN_RELATIONS) throw new Error(`--relations must be at least ${MIN_RELATIONS}`)

  const sourceUrl = String(options.source || DEFAULT_SOURCE_URL)
  const source = await getSource(sourceUrl, options.input, Boolean(options.refresh))
  const csv = await readFile(source.path, 'utf8')
  const rows = parseCsv(csv)
  if (rows.length < 2) throw new Error('Catalog CSV is empty')
  const headers = rows.shift().map(cleanText)
  const columns = Object.fromEntries(headers.map((header, index) => [header, index]))
  for (const required of ['Text#', 'Type', 'Title', 'Language', 'Authors', 'Subjects', 'Issued', 'Bookshelves']) {
    if (columns[required] === undefined) throw new Error(`Catalog is missing required column: ${required}`)
  }
  rows.columns = columns
  const textRows = rows.filter((row) => cleanText(row[columns.Type]).toLocaleLowerCase('en-US') === 'text')
  const { selected, uniqueCount } = selectBooks(textRows, limit, columns)
  const books = selected.map((item) => item.book)
  const relations = generateRelations(books, targetRelations)
  const maxIssuedDate = textRows.reduce((max, row) => {
    const issued = issuedDate(row[columns.Issued])
    return issued && issued > max ? issued : max
  }, '')
  const generatedAt = stableIsoDate(options['generated-at'] || source.lastModified, maxIssuedDate)
  const snapshot = {
    schemaVersion: 'bookshelf-galaxy/catalog-v1',
    generatedAt,
    snapshotAt: source.lastModified || generatedAt,
    source: 'Project Gutenberg Offline Catalog (pg_catalog.csv)',
    sourceUrl: 'https://www.gutenberg.org/ebooks/offline_catalogs.html',
    books,
    relations,
  }
  const catalogPath = resolve(DATA_DIR, 'catalog.json')
  const manifestPath = resolve(DATA_DIR, 'manifest.json')
  await mkdir(DATA_DIR, { recursive: true })
  const catalogBuffer = Buffer.from(JSON.stringify(snapshot))
  await writeFile(catalogPath, catalogBuffer)
  const manifest = {
    schemaVersion: snapshot.schemaVersion,
    generatedAt,
    snapshotAt: snapshot.snapshotAt,
    source: snapshot.source,
    sourceUrl: snapshot.sourceUrl,
    sourceDownloadUrl: sourceUrl,
    sourceLicense: 'Project Gutenberg catalog metadata; see data-sources.md for attribution and redistribution notes.',
    generator: 'scripts/build-catalog.mjs',
    sourceBytes: source.bytes,
    catalogRows: textRows.length,
    uniqueWorksAvailable: uniqueCount,
    bookCount: books.length,
    relationCount: relations.length,
    catalogFile: 'catalog.json',
    catalogSha256: sha256(catalogBuffer),
    downloadsField: 'null: pg_catalog.csv does not publish download counts',
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(JSON.stringify({
    source: basename(source.path),
    catalog: catalogPath,
    manifest: manifestPath,
    books: books.length,
    relations: relations.length,
    sha256: manifest.catalogSha256,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
