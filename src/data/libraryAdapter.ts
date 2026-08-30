import type { Book } from '../types'

/** A loose CSV/JSON row from a library, OPAC, or future catalogue connector. */
export type LibraryRecord = Record<string, unknown>

/** Extra fields kept at the integration boundary without changing the app's Book model. */
export interface LibraryBook extends Book {
  isbn?: string
  callNumber?: string
  collectionNumber?: string
  recordId?: string
}

export type NormalizeLibraryRecordResult =
  | { ok: true; book: LibraryBook }
  | { ok: false; error: string; field?: string }

const aliases = {
  title: ['题名', '书名', '标题', '名称', 'title', 'book title', 'bookTitle', 'name'],
  author: ['作者', '著者', '作者名', 'author', 'creator', 'contributor', 'written by', 'writtenBy'],
  isbn: ['ISBN', 'ISBN-10', 'ISBN-13', 'isbn', 'isbn10', 'isbn13', '标准书号', '国际标准书号', '书号'],
  subject: ['主题', '主题词', '关键词', '学科', '分类', 'subjects', 'subject', 'keywords', 'tags', 'topic', 'classification'],
  language: ['语种', '语言', '文种', 'language', 'lang', 'languageCode'],
  callNumber: ['索书号', '分类号', '排架号', '调用号', 'callNumber', 'call_no', 'callNo', 'shelfMark', 'shelfmark'],
  collectionNumber: ['馆藏号', '馆藏编号', '馆藏条码', 'collectionNumber', 'collection_no', 'collectionId', 'barcode'],
  recordId: ['记录号', '控制号', '书目号', 'recordId', 'record_id', 'bibId', 'controlNumber', 'id'],
  sourceUrl: ['来源链接', '记录链接', '链接', '网址', 'URL', 'url', 'sourceUrl', 'source_url', 'link', 'recordUrl', 'permalink'],
  source: ['来源', '数据源', '机构', '馆藏机构', 'source', 'provider', 'institution', 'library'],
  year: ['出版年', '出版日期', '年份', 'year', 'publishedYear', 'publicationYear', 'date'],
  originalTitle: ['原题名', '原书名', 'originalTitle', 'original_title'],
  summary: ['简介', '摘要', '内容提要', 'description', 'summary', 'abstract', 'notes'],
} as const

function keyOf(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_\-.]+/g, '')
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'bigint') return String(value).trim()
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('、')
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    for (const key of ['label', 'name', 'value', 'text', 'display']) {
      const text = textOf(object[key])
      if (text) return text
    }
  }
  return ''
}

function valuesOf(record: LibraryRecord, names: readonly string[]): string[] {
  const wanted = new Set(names.map(keyOf))
  return Object.entries(record)
    .filter(([key]) => wanted.has(keyOf(key)))
    .map(([, value]) => textOf(value))
    .filter(Boolean)
}

function firstValue(record: LibraryRecord, names: readonly string[]): string {
  return valuesOf(record, names)[0] ?? ''
}

function splitSubjects(value: unknown): string[] {
  return textOf(value)
    .split(/[;,，、；|/]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, 8)
}

function normalizeIsbn(value: string): string | undefined {
  const compact = value.toUpperCase().replace(/[^0-9X]/g, '')
  const match = compact.match(/97[89]\d{10}|\d{9}[\dX]/)
  return match?.[0]
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function stableId(record: LibraryRecord, title: string, author: string, isbn?: string, callNumber?: string): { id: string; recordId?: string } {
  const explicitRecordId = firstValue(record, aliases.recordId)
  if (explicitRecordId) return { id: `library-record-${stableHash(explicitRecordId)}`, recordId: explicitRecordId }
  if (isbn) return { id: `library-isbn-${isbn}` }
  return { id: `library-${stableHash([title, author, callNumber ?? ''].join('\u001f'))}` }
}

function safeHttpsUrl(value: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : undefined
  } catch {
    return undefined
  }
}

function yearOf(value: string): number | undefined {
  const match = value.match(/\b(\d{4})\b/)
  if (!match) return undefined
  const year = Number(match[1])
  return year >= 1 && year <= 9999 ? year : undefined
}

/** Normalize one loose library record without network access or mutation. */
export function normalizeLibraryRecord(input: unknown): NormalizeLibraryRecordResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '馆藏记录必须是对象', field: 'record' }
  }

  const record = input as LibraryRecord
  const title = firstValue(record, aliases.title)
  const author = firstValue(record, aliases.author)
  if (!title) return { ok: false, error: '缺少书名或题名（title）', field: 'title' }
  if (!author) return { ok: false, error: '缺少作者或著者（author）', field: 'author' }

  const sourceUrlValue = firstValue(record, aliases.sourceUrl)
  if (sourceUrlValue && !safeHttpsUrl(sourceUrlValue)) {
    return { ok: false, error: '来源链接必须是有效的 HTTPS 地址', field: 'sourceUrl' }
  }

  const isbn = normalizeIsbn(firstValue(record, aliases.isbn))
  const collectionNumber = firstValue(record, aliases.collectionNumber)
  const callNumber = firstValue(record, aliases.callNumber) || collectionNumber || undefined
  const ids = stableId(record, title, author, isbn, callNumber)
  const subjects = valuesOf(record, aliases.subject).flatMap(splitSubjects)
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, 8)
  const source = firstValue(record, aliases.source) || '外部图书馆馆藏记录'

  const book: LibraryBook = {
    id: ids.id,
    title,
    author,
    themes: subjects,
    language: firstValue(record, aliases.language) || undefined,
    year: yearOf(firstValue(record, aliases.year)),
    originalTitle: firstValue(record, aliases.originalTitle) || undefined,
    summary: firstValue(record, aliases.summary) || undefined,
    source,
    sourceUrl: sourceUrlValue ? safeHttpsUrl(sourceUrlValue) : undefined,
    isbn,
    callNumber,
    collectionNumber: collectionNumber || undefined,
    recordId: ids.recordId,
  }

  return { ok: true, book }
}
