#!/usr/bin/env node

/**
 * Assemble the rich Chinese-first source snapshot and the offline semantic
 * layout into the browser payload.  This script is deliberately fail-closed:
 * a missing layout, an incomplete book, or a dangling relation never produces
 * a partial public/data/catalog.json.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isOpenLibraryCoverUrl,
  isOpenLibrarySourceUrl,
  isTrustedEndpointUrl,
  isWikipediaRevisionUrl,
  isWikipediaSourceUrl,
  isWikidataUrl,
} from './lib/source-urls.mjs'
import { applyApprovedCoversToSnapshot } from './lib/cover-policy.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_BOOKS = resolve(ROOT, 'data/rich/books.json')
const DEFAULT_LAYOUT = resolve(ROOT, 'data/rich/layout.json')
const DEFAULT_CATALOG = resolve(ROOT, 'public/data/catalog.json')
const DEFAULT_MANIFEST = resolve(ROOT, 'public/data/manifest.json')
const DEFAULT_APPROVED_COVERS = resolve(ROOT, 'data/covers/approved-v1.json')

const RICH_SCHEMA = 'bookshelf-galaxy/rich-books-v2'
const LAYOUT_SCHEMA = 'bookshelf-galaxy/semantic-layout-v1'
const CATALOG_SCHEMA = 'bookshelf-galaxy/catalog-v2'
const MANIFEST_SCHEMA = 'bookshelf-galaxy/manifest-v2'
const MIN_SUMMARY_CHINESE = 120
const MIN_THEMES = 3
const DEFAULT_MIN_DEGREE = 3
const CHINESE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu
const PLACEHOLDER = /尚无简介|暂无简介|需要补充|正在編寫|正在编写|没有描述|可能指|本條目需要|消歧義/iu
const SEMANTIC_BASIS = '多维书目语义相似度'
const METADATA_BASIS = new Set(['主题', '时代', '地域'])
const UNKNOWN_METADATA = new Set(['', '未知', '不详', '未注明', '未詳', '无', 'n/a', 'na', 'none', 'null', 'unknown', '-'])
const GENERIC_THEME_LABELS = new Set(['阅读与人性', '时代与命运', '世界文学', '文本叙事', '作品语境', '阅读路径', '未分类', '主题未知', '未分类/主题未知', '閱讀與人性', '時代與命運', '世界文學'])
const THEME_SOURCES = new Set(['wikidata-claim', 'summary-rule', 'contextual-metadata', 'generic-last-resort'])
const SHAPES = new Set(['orb', 'ring', 'diamond', 'petal', 'seed', 'cross', 'flare', 'soft', 'double-halo', 'eccentric'])
const RELATION_KINDS = new Set(['回声', '镜像', '暗河', '裂隙', '余烬', '潮汐'])

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const [key, inline] = arg.slice(2).split('=', 2)
    if (inline !== undefined) options[key] = inline
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) options[key] = argv[++index]
    else options[key] = true
  }
  return options
}

function pathValue(value, fallback) {
  return value === undefined || value === true ? fallback : resolve(ROOT, String(value))
}

function chineseCount(value) {
  return (String(value ?? '').match(CHINESE) || []).length
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

function fold(value) {
  return cleanText(value).toLocaleLowerCase('en-US')
}

function finite(value, label, errors, { min, max } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${label} 必须是有限数字`)
    return false
  }
  if (min !== undefined && value < min) errors.push(`${label} 不能小于 ${min}`)
  if (max !== undefined && value > max) errors.push(`${label} 不能大于 ${max}`)
  return true
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function edgeKey(source, target) {
  return [source, target].sort().join('\u0000')
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(cleanText).filter(Boolean))]
}

function validateEvidence(value, label, errors) {
  if (!isObject(value)) {
    errors.push(`${label} 必须是对象`)
    return
  }
  for (const [key, item] of Object.entries(value)) {
    const itemLabel = `${label}.${key}`
    if (typeof item === 'number') {
      finite(item, itemLabel, errors)
    } else if (typeof item === 'boolean') {
      continue
    } else if (Array.isArray(item)) {
      // ``sharedThemes`` is intentionally allowed to be [] when a semantic
      // edge is supported by era/region instead of a shared theme.  Entries,
      // when present, must still be non-empty strings.
      if (item.some((entry) => typeof entry !== 'string' || !cleanText(entry))) {
        errors.push(`${itemLabel} 必须是字符串数组，数组元素不得为空`)
      }
    } else {
      errors.push(`${itemLabel} 只允许有限数字、布尔值或非空字符串数组`)
    }
  }
}

function relationEvidenceFromBooks(first, second) {
  const firstThemes = (Array.isArray(first?.themes) ? first.themes : []).map(cleanText).filter(Boolean)
  const secondThemes = new Set((Array.isArray(second?.themes) ? second.themes : []).map(cleanText).filter(Boolean).map(fold))
  const sharedThemes = firstThemes.filter((theme) => secondThemes.has(fold(theme)) && !GENERIC_THEME_LABELS.has(fold(theme)))
  const eraKnown = first?.year !== null && first?.year !== undefined && second?.year !== null && second?.year !== undefined
  const eraGap = eraKnown ? Math.min(Math.abs(Number(first.year) - Number(second.year)) / 180, 1) : 0
  const firstCountry = fold(first?.country)
  const secondCountry = fold(second?.country)
  const countryKnown = !UNKNOWN_METADATA.has(firstCountry) && !UNKNOWN_METADATA.has(secondCountry)
  const countryGap = countryKnown && firstCountry === secondCountry ? 0 : 1
  return { sharedThemes, eraGap, countryKnown, countryGap }
}

function validateRelationEvidence(value, first, second, label, errors) {
  if (!isObject(value) || !isObject(first) || !isObject(second)) return
  const expected = relationEvidenceFromBooks(first, second)
  const actualThemes = Array.isArray(value.sharedThemes) ? value.sharedThemes : null
  const expectedThemeKeys = new Set(expected.sharedThemes.map(fold))
  const actualThemeKeys = new Set((actualThemes || []).map(fold))
  if (!actualThemes
    || actualThemes.length !== actualThemeKeys.size
    || actualThemeKeys.size !== expectedThemeKeys.size
    || [...actualThemeKeys].some((theme) => !expectedThemeKeys.has(theme))) {
    errors.push(`${label}.sharedThemes 与最终书目 themes 重算结果不一致`)
  }
  if (typeof value.eraGap !== 'number' || Math.abs(value.eraGap - expected.eraGap) > 1e-6) errors.push(`${label}.eraGap 与最终书目 year 重算结果不一致`)
  if (typeof value.countryKnown !== 'boolean' || value.countryKnown !== expected.countryKnown) errors.push(`${label}.countryKnown 与最终书目 country 重算结果不一致`)
  if (typeof value.countryGap !== 'number' || Math.abs(value.countryGap - expected.countryGap) > 1e-6) errors.push(`${label}.countryGap 与最终书目 country 重算结果不一致`)
}

async function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} 不存在：${path}`)
  let value
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${error instanceof Error ? error.message : error}`)
  }
  return value
}

async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, text, 'utf8')
  try {
    await rename(temporary, path)
  } catch (error) {
    // Windows refuses rename(temp, existingTarget).  Move the old target to a
    // unique sibling first, then replace it; restore the backup if the second
    // move fails so a failed build never destroys the previous snapshot.
    if (!existsSync(path) || !['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) {
      await rm(temporary, { force: true })
      throw error
    }
    const backup = `${path}.bak-${process.pid}-${Date.now()}`
    await rename(path, backup)
    try {
      await rename(temporary, path)
      await rm(backup, { force: true })
    } catch (replacementError) {
      await rm(path, { force: true })
      await rename(backup, path).catch(() => {})
      await rm(temporary, { force: true })
      throw replacementError
    }
  }
}

function validateRichBooks(snapshot) {
  const errors = []
  if (!isObject(snapshot)) return { books: [], errors: ['富书目快照必须是对象'] }
  if (snapshot.schemaVersion !== RICH_SCHEMA) errors.push(`富书目 schemaVersion 必须为 ${RICH_SCHEMA}`)
  if (!Array.isArray(snapshot.books) || snapshot.books.length < 2) {
    errors.push('富书目必须包含至少两本书')
    return { books: [], errors }
  }
  const endpointKinds = [
    ['summaryEndpoint', 'wikipedia'],
    ['metadataEndpoint', 'wikidata-api'],
    ['candidateEndpoint', 'wdqs'],
    ['coverMetadataEndpoint', 'openlibrary-api'],
  ]
  for (const [field, kind] of endpointKinds) {
    if (snapshot.provenance?.[field] !== undefined && !isTrustedEndpointUrl(snapshot.provenance[field], kind)) {
      errors.push(`provenance.${field} 不是受信任的固定数据源端点`)
    }
  }
  const ids = new Set()
  const pageIds = new Set()
  const sourceUrls = new Set()
  const revisionUrls = new Set()
  const contentFingerprints = new Set()
  for (const [index, book] of snapshot.books.entries()) {
    const prefix = `books[${index}]`
    if (!isObject(book)) {
      errors.push(`${prefix} 必须是对象`)
      continue
    }
    const id = cleanText(book.id)
    if (!/^Q\d+$/u.test(id)) errors.push(`${prefix}.id 必须是 Wikidata Q-id`)
    if (ids.has(id)) errors.push(`${prefix}.id 重复：${id}`)
    ids.add(id)
    const title = cleanText(book.title)
    if (!title || chineseCount(title) < 1) errors.push(`${prefix}.title 必须是中文主标题`)
    const summary = cleanText(book.summary)
    if (!summary || chineseCount(summary) < MIN_SUMMARY_CHINESE || PLACEHOLDER.test(summary)) {
      errors.push(`${prefix}.summary 少于 ${MIN_SUMMARY_CHINESE} 个中文字符或为占位摘要`)
    }
    const themes = uniqueStrings(book.themes)
    if (themes.length < MIN_THEMES) errors.push(`${prefix}.themes 少于 ${MIN_THEMES} 个有效主题`)
    if (!isObject(book.themeProvenance)) errors.push(`${prefix}.themeProvenance 缺失`)
    else {
      const themeKeys = Object.keys(book.themeProvenance)
      if (themeKeys.length !== themes.length || themes.some((theme) => !Object.hasOwn(book.themeProvenance, theme))) errors.push(`${prefix}.themeProvenance 未逐条覆盖 themes`)
      if (themeKeys.some((theme) => !THEME_SOURCES.has(book.themeProvenance[theme]))) errors.push(`${prefix}.themeProvenance 含未知来源类型`)
    }
    if (!isObject(book.themeEvidence)) errors.push(`${prefix}.themeEvidence 缺失`)
    else if (Object.keys(book.themeEvidence).length !== themes.length || themes.some((theme) => !cleanText(book.themeEvidence[theme]))) errors.push(`${prefix}.themeEvidence 未逐条覆盖 themes`)
    const pageId = Number(book.provenance?.wikipediaPageId)
    if (!Number.isInteger(pageId) || pageId < 1) errors.push(`${prefix}.provenance.wikipediaPageId 缺失`)
    else if (pageIds.has(pageId)) errors.push(`${prefix}.provenance.wikipediaPageId 重复：${pageId}`)
    else pageIds.add(pageId)
    const sourceKey = cleanText(book.sourceUrl).replace(/[?#].*$/u, '').replace(/\/+$/u, '').toLocaleLowerCase('en-US')
    if (sourceUrls.has(sourceKey)) errors.push(`${prefix}.sourceUrl 重复`)
    else sourceUrls.add(sourceKey)
    const revisionKey = cleanText(book.provenance?.wikipediaRevisionUrl)
    if (revisionUrls.has(revisionKey)) errors.push(`${prefix}.provenance.wikipediaRevisionUrl 重复`)
    else revisionUrls.add(revisionKey)
    const contentKey = `${title.replace(/\s+/gu, '')}\u0000${summary.replace(/\s+/gu, '')}`
    if (contentFingerprints.has(contentKey)) errors.push(`${prefix} 中文题名与摘要完全重复`)
    else contentFingerprints.add(contentKey)
    if (!cleanText(book.author)) errors.push(`${prefix}.author 缺失`)
    if (!isWikipediaSourceUrl(book.sourceUrl)) errors.push(`${prefix}.sourceUrl 必须是中文维基百科文章 HTTPS 链接`)
    if (!cleanText(book.source)) errors.push(`${prefix}.source 缺失`)
    if (!Array.isArray(book.instanceOf) || book.instanceOf.length === 0 || book.instanceOf.some((type) => !isObject(type) || !cleanText(type.id) || !cleanText(type.label))) {
      errors.push(`${prefix}.instanceOf 作品类型证据缺失`)
    }
    if (!isObject(book.eligibility) || book.eligibility.accepted !== true || !cleanText(book.eligibility.reason)) {
      errors.push(`${prefix}.eligibility 未确认通过或缺少理由`)
    }
    if (!isObject(book.provenance)) {
      errors.push(`${prefix}.provenance 缺失`)
    } else {
      if (!isWikipediaRevisionUrl(book.sourceUrl, book.provenance.wikipediaRevisionUrl)) errors.push(`${prefix}.provenance.wikipediaRevisionUrl 必须与 sourceUrl 同页且 oldid 为纯数字`)
      if (!cleanText(book.provenance.variantTitleSource)) errors.push(`${prefix}.provenance.variantTitleSource 缺失`)
    }
    if (!isWikidataUrl(book.wikidataUrl, id)) errors.push(`${prefix}.wikidataUrl 必须链接到该作品的 Wikidata Q 项`)
    if (book.coverUrl !== null && book.coverUrl !== undefined && !isOpenLibraryCoverUrl(book.coverUrl)) errors.push(`${prefix}.coverUrl 必须是 covers.openlibrary.org 的固定 JPG 封面链接`)
    if (book.coverSourceUrl && !isOpenLibrarySourceUrl(book.coverSourceUrl)) errors.push(`${prefix}.coverSourceUrl 必须是 Open Library work 或 exact Edition 链接`)
    if (book.year !== null && book.year !== undefined) finite(book.year, `${prefix}.year`, errors)
    if (book.metadataCompleteness !== undefined) finite(book.metadataCompleteness, `${prefix}.metadataCompleteness`, errors, { min: 0, max: 1 })
  }
  return { books: snapshot.books, ids, errors }
}

function validateLayout(layout, richIds, richBookById, minDegree) {
  const errors = []
  if (!isObject(layout)) return { records: [], relations: [], errors: ['语义布局必须是对象'] }
  if (layout.schemaVersion !== LAYOUT_SCHEMA) errors.push(`语义布局 schemaVersion 必须为 ${LAYOUT_SCHEMA}`)
  if (!Array.isArray(layout.books) || layout.books.length < 2) errors.push('语义布局必须包含至少两本书')
  if (!Array.isArray(layout.relations)) errors.push('语义布局 relations 必须是数组')
  const records = Array.isArray(layout.books) ? layout.books : []
  const relations = Array.isArray(layout.relations) ? layout.relations : []
  if (records.length !== richIds.size) errors.push(`布局书数 ${records.length} 与富书目书数 ${richIds.size} 不一致`)
  const layoutIds = new Set()
  const byId = new Map()
  for (const [index, record] of records.entries()) {
    const prefix = `layout.books[${index}]`
    if (!isObject(record)) {
      errors.push(`${prefix} 必须是对象`)
      continue
    }
    const id = cleanText(record.id)
    if (!richIds.has(id)) errors.push(`${prefix}.id 不在富书目中：${id}`)
    if (layoutIds.has(id)) errors.push(`${prefix}.id 重复：${id}`)
    layoutIds.add(id)
    byId.set(id, record)
    if (!Array.isArray(record.position) || record.position.length !== 3) errors.push(`${prefix}.position 必须包含 3 个坐标`)
    else record.position.forEach((value, axis) => finite(value, `${prefix}.position[${axis}]`, errors, { min: -150, max: 150 }))
    finite(record.localDensity, `${prefix}.localDensity`, errors, { min: 0, max: 1 })
    finite(record.outlierScore, `${prefix}.outlierScore`, errors, { min: 0, max: 1 })
    finite(record.magnitude, `${prefix}.magnitude`, errors, { min: Number.MIN_VALUE })
    finite(record.halo, `${prefix}.halo`, errors, { min: 0, max: 2 })
    if (!SHAPES.has(String(record.shape || ''))) errors.push(`${prefix}.shape 不是已知星体形状`)
    finite(record.temperature, `${prefix}.temperature`, errors, { min: 0, max: 1 })
    if (!Array.isArray(record.neighbors) || record.neighbors.length < minDegree) errors.push(`${prefix}.neighbors 少于 ${minDegree} 个`)
    if (record.spatialNeighbors !== undefined && !Array.isArray(record.spatialNeighbors)) errors.push(`${prefix}.spatialNeighbors 必须是数组`)
    if (Array.isArray(record.spatialNeighbors)) {
      const spatialSeen = new Set()
      for (const neighbourId of record.spatialNeighbors) {
        if (!richIds.has(String(neighbourId))) errors.push(`${prefix}.spatialNeighbors 存在悬空节点：${neighbourId}`)
        if (String(neighbourId) === id || spatialSeen.has(String(neighbourId))) errors.push(`${prefix}.spatialNeighbors 存在自环或重复`)
        spatialSeen.add(String(neighbourId))
      }
    }
    if (Array.isArray(record.neighbors)) {
      const seen = new Set()
      for (const [neighbourIndex, neighbour] of record.neighbors.entries()) {
        const neighbourLabel = `${prefix}.neighbors[${neighbourIndex}]`
        if (!isObject(neighbour)) {
          errors.push(`${neighbourLabel} 必须是对象`)
          continue
        }
        const neighbourId = cleanText(neighbour.id)
        if (!richIds.has(neighbourId)) errors.push(`${neighbourLabel} 存在悬空节点：${neighbourId}`)
        if (neighbourId === id || seen.has(neighbourId)) errors.push(`${neighbourLabel} 存在自环或重复`)
        seen.add(neighbourId)
        finite(neighbour.similarity, `${neighbourLabel}.similarity`, errors, { min: 0, max: 1 })
        finite(neighbour.surprise, `${neighbourLabel}.surprise`, errors, { min: 0, max: 1 })
        if (neighbour.navigable === true) validateBasis(neighbour.basis, neighbourLabel, errors)
      }
    }
  }
  for (const id of richIds) if (!layoutIds.has(id)) errors.push(`富书目 ${id} 缺少语义布局记录`)

  const relationKeys = new Set()
  const degree = new Map([...richIds].map((id) => [id, 0]))
  for (const [index, relation] of relations.entries()) {
    const prefix = `layout.relations[${index}]`
    if (!isObject(relation)) {
      errors.push(`${prefix} 必须是对象`)
      continue
    }
    const source = cleanText(relation.source)
    const target = cleanText(relation.target)
    if (!richIds.has(source) || !richIds.has(target)) errors.push(`${prefix} 存在悬空端点：${source}/${target}`)
    if (!source || source === target) errors.push(`${prefix} 不能是自环`)
    const key = edgeKey(source, target)
    if (relationKeys.has(key)) errors.push(`${prefix} 与已有关系重复：${key}`)
    relationKeys.add(key)
    finite(relation.similarity, `${prefix}.similarity`, errors, { min: 0, max: 1 })
    finite(relation.weight, `${prefix}.weight`, errors, { min: 0, max: 1 })
    finite(relation.surprise, `${prefix}.surprise`, errors, { min: 0, max: 1 })
    if (!isObject(relation.surpriseByBook) || !isObject(relation.bandByBook)) errors.push(`${prefix} 缺少逐出发书校准的 surpriseByBook/bandByBook`)
    else {
      for (const [bookId, surprise] of Object.entries(relation.surpriseByBook)) {
        if (bookId !== source && bookId !== target) errors.push(`${prefix}.surpriseByBook 含非端点：${bookId}`)
        finite(surprise, `${prefix}.surpriseByBook.${bookId}`, errors, { min: 0, max: 1 })
        if (!['low', 'middle', 'high'].includes(relation.bandByBook[bookId])) errors.push(`${prefix}.bandByBook.${bookId} 缺失或无效`)
      }
    }
    finite(relation.confidence, `${prefix}.confidence`, errors, { min: 0, max: 1 })
    validateBasis(relation.basis, prefix, errors)
    if (relation.kind !== undefined && !RELATION_KINDS.has(String(relation.kind))) errors.push(`${prefix}.kind 不是应用支持的关系类型`)
    if (cleanText(relation.sentence).length < 20) errors.push(`${prefix}.sentence 太短，缺少关系解释`)
    if (relation.evidence === undefined) errors.push(`${prefix}.evidence 缺失`)
    else {
      validateEvidence(relation.evidence, `${prefix}.evidence`, errors)
      validateRelationEvidence(relation.evidence, richBookById.get(source), richBookById.get(target), `${prefix}.evidence`, errors)
    }
    if (degree.has(source)) degree.set(source, degree.get(source) + 1)
    if (degree.has(target)) degree.set(target, degree.get(target) + 1)
  }
  for (const [id, count] of degree) if (count < minDegree) errors.push(`书 ${id} 的可解释关系数仅 ${count}，少于 ${minDegree}`)
  return { records, relations, byId, degree, errors }
}

function validateBasis(value, label, errors) {
  const basis = uniqueStrings(value)
  if (basis.length < 2) {
    errors.push(`${label}.basis 至少需要语义证据和一项元数据证据`)
    return
  }
  if (!basis.includes(SEMANTIC_BASIS)) errors.push(`${label}.basis 缺少 ${SEMANTIC_BASIS}`)
  if (!basis.some((item) => METADATA_BASIS.has(item))) errors.push(`${label}.basis 缺少主题/时代/地域证据`)
  if (basis.some((item) => /语言|年份|年代/u.test(item)) && !basis.some((item) => METADATA_BASIS.has(item))) {
    errors.push(`${label}.basis 不能只依赖语言或年份`)
  }
}

function relationKind(relation) {
  const surprise = Number(relation.surprise)
  if (surprise >= 0.82) return '裂隙'
  if (surprise >= 0.66) return '暗河'
  if (surprise >= 0.5) return '余烬'
  if (Number(relation.similarity) >= 0.84) return '回声'
  return '潮汐'
}

function cloneNeighbour(neighbour) {
  const cloned = { ...neighbour }
  if (Array.isArray(neighbour.basis)) cloned.basis = uniqueStrings(neighbour.basis)
  return cloned
}

function buildManifest(snapshot, rich, layout, catalogBuffer, degree) {
  const books = snapshot.books
  const summaryCount = books.filter((book) => chineseCount(book.summary) >= MIN_SUMMARY_CHINESE).length
  const summaryLengths = books.map((book) => chineseCount(book.summary)).sort((left, right) => left - right)
  const summaryMedian = summaryLengths[Math.floor(summaryLengths.length / 2)] || 0
  const titleCount = books.filter((book) => chineseCount(book.title) > 0).length
  const namedAuthorCount = books.filter((book) =>
    Array.isArray(book.authors)
    && book.authors.some((author) => /^Q\d+$/u.test(cleanText(author?.id)) && Boolean(cleanText(author?.name))),
  ).length
  const themeCount = books.filter((book) => uniqueStrings(book.themes).length >= MIN_THEMES).length
  const sourceCount = books.filter((book) => isWikipediaSourceUrl(book.sourceUrl)).length
  const coverCount = books.filter((book) => isOpenLibraryCoverUrl(book.coverUrl)).length
  const eligibilityCount = books.filter((book) => book.eligibility?.accepted === true).length
  const revisionUrlCount = books.filter((book) => isWikipediaRevisionUrl(book.sourceUrl, book.provenance?.wikipediaRevisionUrl)).length
  const degreeValues = [...degree.values()]
  const averageDegree = degreeValues.reduce((sum, value) => sum + value, 0) / Math.max(1, degreeValues.length)
  const richProvenance = isObject(rich.provenance) ? rich.provenance : {}
  return {
    schemaVersion: MANIFEST_SCHEMA,
    generatedAt: snapshot.generatedAt,
    catalogSha256: hashBuffer(catalogBuffer),
    catalogBytes: catalogBuffer.byteLength,
    bookCount: books.length,
    relationCount: snapshot.relations.length,
    eligibilityCoverage: {
      count: eligibilityCount,
      total: books.length,
      rate: Number((eligibilityCount / books.length).toFixed(4)),
    },
    revisionUrlCoverage: {
      count: revisionUrlCount,
      total: books.length,
      rate: Number((revisionUrlCount / books.length).toFixed(4)),
    },
    sources: {
      works: {
        name: 'Wikidata + 中文维基百科',
        url: 'https://zh.wikipedia.org/',
        metadataUrl: richProvenance.metadataEndpoint || 'https://www.wikidata.org/w/api.php',
        candidateUrl: richProvenance.candidateEndpoint || 'https://query.wikidata.org/sparql',
        license: richProvenance.licenses?.wikipedia || 'CC BY-SA 4.0（中文维基百科导语）',
        metadataLicense: richProvenance.licenses?.wikidata || 'CC0 1.0（Wikidata 数据）',
      },
      summaries: {
        name: '中文维基百科导语（zh-cn）',
        url: richProvenance.summaryEndpoint || 'https://zh.wikipedia.org/w/api.php',
        license: richProvenance.licenses?.wikipedia || 'CC BY-SA 4.0',
      },
      covers: {
        name: 'Open Library Covers',
        url: richProvenance.coverMetadataEndpoint || 'https://openlibrary.org/search.json',
        license: richProvenance.licenses?.openLibraryCovers || 'Open Library cover service terms',
        note: '仅保留远程封面 URL，不在构建时批量下载图片。',
        approvedSidecar: richProvenance.approvedCoverSidecar || null,
      },
      layout: {
        name: layout.model || 'BAAI/bge-small-zh-v1.5',
        model: layout.model || null,
        generator: 'scripts/build-semantic-layout.py',
        schemaVersion: layout.schemaVersion,
        seed: layout.seed ?? null,
      },
    },
    coverage: {
      chineseTitles: { count: titleCount, total: books.length, rate: Number((titleCount / books.length).toFixed(4)) },
      summaries: { count: summaryCount, total: books.length, rate: Number((summaryCount / books.length).toFixed(4)), minimumChineseCharacters: MIN_SUMMARY_CHINESE, medianChineseCharacters: summaryMedian },
      namedAuthors: { count: namedAuthorCount, total: books.length, rate: Number((namedAuthorCount / books.length).toFixed(4)), anonymousLabel: '佚名' },
      themes: { count: themeCount, total: books.length, rate: Number((themeCount / books.length).toFixed(4)), minimumPerBook: MIN_THEMES },
      sourceUrls: { count: sourceCount, total: books.length, rate: Number((sourceCount / books.length).toFixed(4)) },
      covers: { count: coverCount, total: books.length, rate: Number((coverCount / books.length).toFixed(4)), kind: 'Open Library 书籍封面；无封面时由界面使用书目牌兜底' },
      relations: {
        booksWithAtLeastThree: degreeValues.filter((value) => value >= 3).length,
        minimumDegree: Math.min(...degreeValues),
        maximumDegree: Math.max(...degreeValues),
        averageDegree: Number(averageDegree.toFixed(3)),
      },
    },
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const booksPath = pathValue(options.books || options['input-books'], DEFAULT_BOOKS)
  const layoutPath = pathValue(options.layout || options['input-layout'], DEFAULT_LAYOUT)
  const catalogPath = pathValue(options.output, DEFAULT_CATALOG)
  const manifestPath = pathValue(options.manifest, DEFAULT_MANIFEST)
  const approvedCoversPath = pathValue(options.sidecar, DEFAULT_APPROVED_COVERS)
  const minDegree = Number.parseInt(String(options['min-degree'] || DEFAULT_MIN_DEGREE), 10)
  if (!Number.isInteger(minDegree) || minDegree < 1) throw new Error(`--min-degree 必须是正整数：${minDegree}`)

  // Read both inputs before touching either output.  In particular, a missing
  // layout must never leave behind a misleading replacement for the old demo.
  const [richInput, layout, approvedCovers] = await Promise.all([
    readJson(booksPath, '富书目文件'),
    readJson(layoutPath, '语义布局文件'),
    readJson(approvedCoversPath, '已批准封面侧车'),
  ])
  const rich = applyApprovedCoversToSnapshot(richInput, approvedCovers)
  const richValidation = validateRichBooks(rich)
  const richIds = new Set((richValidation.books || []).map((book) => cleanText(book.id)))
  const richBookById = new Map(richValidation.books.map((book) => [cleanText(book.id), book]))
  const layoutValidation = validateLayout(layout, richIds, richBookById, minDegree)
  const errors = [...richValidation.errors, ...layoutValidation.errors]
  if (errors.length) {
    throw new Error(`v2 书目合并拒绝（${errors.length} 项）：\n${errors.slice(0, 60).map((item) => `- ${item}`).join('\n')}${errors.length > 60 ? `\n- 其余 ${errors.length - 60} 项省略` : ''}`)
  }

  const mergedBooks = richValidation.books.map((book) => {
    const layoutRecord = layoutValidation.byId.get(book.id)
    const merged = {
      ...book,
      position: [...layoutRecord.position],
      localDensity: layoutRecord.localDensity,
      outlierScore: layoutRecord.outlierScore,
      magnitude: layoutRecord.magnitude,
      halo: layoutRecord.halo,
      shape: layoutRecord.shape,
      temperature: layoutRecord.temperature,
      neighbors: layoutRecord.neighbors.map(cloneNeighbour),
    }
    for (const field of ['spatialNeighbors', 'spatialSemanticOverlap', 'clusterWeights']) {
      if (layoutRecord[field] !== undefined) merged[field] = Array.isArray(layoutRecord[field])
        ? [...layoutRecord[field]]
        : layoutRecord[field]
    }
    return merged
  })

  const relations = layoutValidation.relations.map((relation) => ({
    source: relation.source,
    target: relation.target,
    kind: relation.kind || relationKind(relation),
    similarity: relation.similarity,
    weight: relation.weight,
    basis: uniqueStrings(relation.basis),
    sentence: cleanText(relation.sentence),
    surprise: relation.surprise,
    surpriseByBook: { ...relation.surpriseByBook },
    bandByBook: { ...relation.bandByBook },
    confidence: relation.confidence,
    ...(isObject(relation.evidence) ? { evidence: { ...relation.evidence } } : {}),
    provenance: 'semantic',
  }))

  const snapshot = {
    schemaVersion: CATALOG_SCHEMA,
    generatedAt: rich.generatedAt || 'deterministic',
    source: '中文维基百科 / Wikidata 作品快照 + BGE 中文语义布局',
    sourceUrl: 'https://zh.wikipedia.org/',
    layoutModel: layout.model || null,
    books: mergedBooks,
    relations,
  }
  const catalogText = stableJson(snapshot)
  const catalogBuffer = Buffer.from(catalogText, 'utf8')
  const manifest = buildManifest(snapshot, rich, layout, catalogBuffer, layoutValidation.degree)
  const manifestText = stableJson(manifest)
  await writeAtomic(catalogPath, catalogText)
  await writeAtomic(manifestPath, manifestText)
  console.log(JSON.stringify({
    ok: true,
    catalog: catalogPath,
    manifest: manifestPath,
    books: snapshot.books.length,
    relations: snapshot.relations.length,
    summaries: manifest.coverage.summaries,
    covers: manifest.coverage.covers,
    sha256: manifest.catalogSha256,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
