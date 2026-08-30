#!/usr/bin/env node

/** Offline acceptance check for the assembled v2 browser catalogue. */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isOpenLibraryCoverUrl,
  isOpenLibraryWorkUrl,
  isTrustedEndpointUrl,
  isWikipediaRevisionUrl,
  isWikipediaSourceUrl,
  isWikidataUrl,
} from './lib/source-urls.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CATALOG = resolve(ROOT, 'public/data/catalog.json')
const DEFAULT_MANIFEST = resolve(ROOT, 'public/data/manifest.json')
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
const RELATION_KINDS = new Set(['回声', '镜像', '暗河', '裂隙', '余烬', '潮汐'])
const DIRECTIONAL_BANDS = ['near', 'bridge', 'far']
const STORED_DIRECTIONAL_BAND = { near: 'low', bridge: 'middle', far: 'high' }
const SURPRISE_NEAR_MAX = 0.52
const SURPRISE_BRIDGE_MAX = 0.8

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

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function edgeKey(source, target) {
  return [source, target].sort().join('\u0000')
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function finite(value, label, errors, { min, max } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${label} 必须是有限数字`)
    return
  }
  if (min !== undefined && value < min) errors.push(`${label} 不能小于 ${min}`)
  if (max !== undefined && value > max) errors.push(`${label} 不能大于 ${max}`)
}

function directionalBand(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0 || value > 1) return null
  if (value < SURPRISE_NEAR_MAX) return 'near'
  if (value < SURPRISE_BRIDGE_MAX) return 'bridge'
  return 'far'
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
      // An edge may have no shared theme while retaining era/region evidence;
      // the controlled array is therefore allowed to be empty.
      if (item.some((entry) => typeof entry !== 'string' || !cleanText(entry))) errors.push(`${itemLabel} 必须是字符串数组，数组元素不得为空`)
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
    || [...actualThemeKeys].some((theme) => !expectedThemeKeys.has(theme))) errors.push(`${label}.sharedThemes 与最终书目 themes 重算结果不一致`)
  if (typeof value.eraGap !== 'number' || Math.abs(value.eraGap - expected.eraGap) > 1e-6) errors.push(`${label}.eraGap 与最终书目 year 重算结果不一致`)
  if (typeof value.countryKnown !== 'boolean' || value.countryKnown !== expected.countryKnown) errors.push(`${label}.countryKnown 与最终书目 country 重算结果不一致`)
  if (typeof value.countryGap !== 'number' || Math.abs(value.countryGap - expected.countryGap) > 1e-6) errors.push(`${label}.countryGap 与最终书目 country 重算结果不一致`)
}

function validateBasis(value, label, errors) {
  const basis = uniqueStrings(value)
  if (basis.length < 2) errors.push(`${label} 至少需要两项证据`)
  if (!basis.includes(SEMANTIC_BASIS)) errors.push(`${label} 缺少多维书目语义证据`)
  if (!basis.some((item) => METADATA_BASIS.has(item))) errors.push(`${label} 缺少主题/时代/地域证据`)
  if (basis.some((item) => /语言|年份|年代/u.test(item)) && !basis.some((item) => METADATA_BASIS.has(item))) {
    errors.push(`${label} 禁止只使用语言或年份证据`)
  }
}

async function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} 不存在：${path}`)
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${error instanceof Error ? error.message : error}`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const catalogPath = pathValue(options.input || options.catalog, DEFAULT_CATALOG)
  const manifestPath = pathValue(options.manifest, DEFAULT_MANIFEST)
  const minDegree = Number.parseInt(String(options['min-degree'] || DEFAULT_MIN_DEGREE), 10)
  if (!Number.isInteger(minDegree) || minDegree < 1) throw new Error(`--min-degree 必须是正整数：${minDegree}`)
  const [catalogBuffer, manifest] = await Promise.all([
    readFile(catalogPath),
    readJson(manifestPath, 'v2 manifest'),
  ])
  const catalog = JSON.parse(catalogBuffer.toString('utf8'))
  const catalogObject = isObject(catalog) ? catalog : {}
  const manifestObject = isObject(manifest) ? manifest : {}
  const errors = []
  if (!isObject(catalog)) errors.push('catalog 必须是对象')
  if (catalogObject.schemaVersion !== CATALOG_SCHEMA) errors.push(`schemaVersion 必须为 ${CATALOG_SCHEMA}`)
  if (!Array.isArray(catalogObject.books) || catalogObject.books.length < 2) errors.push('catalog 必须包含至少两本书')
  if (!Array.isArray(catalogObject.relations)) errors.push('catalog.relations 必须是数组')
  if (!isTrustedEndpointUrl(catalogObject.sourceUrl, 'wikipedia') || String(catalogObject.sourceUrl).replace(/\/+$/u, '') !== 'https://zh.wikipedia.org') {
    errors.push('catalog.sourceUrl 必须是中文维基百科站点根地址')
  }
  if (!isObject(manifest) || manifestObject.schemaVersion !== MANIFEST_SCHEMA) errors.push(`manifest schemaVersion 必须为 ${MANIFEST_SCHEMA}`)
  if (manifestObject.catalogSha256 !== hashBuffer(catalogBuffer)) errors.push('manifest.catalogSha256 与 catalog 内容不一致')
  if (manifestObject.bookCount !== catalogObject.books?.length) errors.push('manifest.bookCount 不一致')
  if (manifestObject.relationCount !== catalogObject.relations?.length) errors.push('manifest.relationCount 不一致')

  const books = Array.isArray(catalogObject.books) ? catalogObject.books : []
  const relations = Array.isArray(catalogObject.relations) ? catalogObject.relations : []
  const ids = new Set()
  const pageIds = new Set()
  const sourceUrls = new Set()
  const revisionUrls = new Set()
  const contentFingerprints = new Set()
  // Build the complete endpoint set before validating neighbour arrays.  This
  // keeps the checker linear in the number of records instead of repeatedly
  // scanning the whole catalogue for every neighbour.
  const allBookIds = new Set(books.filter((book) => isObject(book)).map((book) => cleanText(book.id)))
  const bookById = new Map(books.filter((book) => isObject(book)).map((book) => [cleanText(book.id), book]))
  const degree = new Map()
  const directionalCoverage = new Map()
  const navigableNeighbourKeys = new Set()
  let summaryCount = 0
  let titleCount = 0
  let themeCount = 0
  let sourceCount = 0
  let coverCount = 0
  let namedAuthorCount = 0
  let eligibilityCount = 0
  let revisionUrlCount = 0
  for (const [index, book] of books.entries()) {
    const prefix = `books[${index}]`
    if (!isObject(book)) {
      errors.push(`${prefix} 必须是对象`)
      continue
    }
    const id = cleanText(book.id)
    if (!/^Q\d+$/u.test(id)) errors.push(`${prefix}.id 必须是 Wikidata Q-id，旧 Gutenberg/curated 记录不得混入`)
    if (ids.has(id)) errors.push(`${prefix}.id 重复：${id}`)
    ids.add(id)
    degree.set(id, 0)
    const title = cleanText(book.title)
    if (!title || chineseCount(title) < 1) errors.push(`${prefix}.title 不是中文主标题`)
    else titleCount += 1
    const summary = cleanText(book.summary)
    if (!summary || chineseCount(summary) < MIN_SUMMARY_CHINESE || PLACEHOLDER.test(summary)) errors.push(`${prefix}.summary 少于 ${MIN_SUMMARY_CHINESE} 个中文字符或为占位摘要`)
    else summaryCount += 1
    const themes = uniqueStrings(book.themes)
    if (themes.length < MIN_THEMES) errors.push(`${prefix}.themes 少于 ${MIN_THEMES} 个有效主题`)
    else themeCount += 1
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
    if (!isWikipediaSourceUrl(book.sourceUrl)) errors.push(`${prefix}.sourceUrl 必须是中文维基百科文章 HTTPS 链接`)
    else sourceCount += 1
    if (!isWikidataUrl(book.wikidataUrl, id)) errors.push(`${prefix}.wikidataUrl 必须链接到该作品的 Wikidata Q 项`)
    if (!cleanText(book.author)) errors.push(`${prefix}.author 缺失`)
    if (Array.isArray(book.authors) && book.authors.some((author) => /^Q\d+$/u.test(cleanText(author?.id)) && Boolean(cleanText(author?.name)))) namedAuthorCount += 1
    if (!Array.isArray(book.instanceOf) || book.instanceOf.length === 0 || book.instanceOf.some((type) => !isObject(type) || !cleanText(type.id) || !cleanText(type.label))) errors.push(`${prefix}.instanceOf 作品类型证据缺失`)
    if (!isObject(book.eligibility) || book.eligibility.accepted !== true || !cleanText(book.eligibility.reason)) errors.push(`${prefix}.eligibility 未确认通过或缺少理由`)
    else eligibilityCount += 1
    if (!isObject(book.provenance)) errors.push(`${prefix}.provenance 缺失`)
    else {
      if (!isWikipediaRevisionUrl(book.sourceUrl, book.provenance.wikipediaRevisionUrl)) errors.push(`${prefix}.provenance.wikipediaRevisionUrl 缺失，或与 sourceUrl 不同页，或 oldid 不是纯数字`)
      else revisionUrlCount += 1
      if (!cleanText(book.provenance.variantTitleSource)) errors.push(`${prefix}.provenance.variantTitleSource 缺失`)
    }
    if (book.coverUrl !== null && book.coverUrl !== undefined) {
      if (!isOpenLibraryCoverUrl(book.coverUrl)) errors.push(`${prefix}.coverUrl 必须是 covers.openlibrary.org 的固定 JPG 封面链接`)
      else coverCount += 1
    }
    if (book.coverSourceUrl && !isOpenLibraryWorkUrl(book.coverSourceUrl)) errors.push(`${prefix}.coverSourceUrl 必须是 Open Library works 链接`)
    if (!Array.isArray(book.position) || book.position.length !== 3) errors.push(`${prefix}.position 必须包含 3 个坐标`)
    else book.position.forEach((value, axis) => finite(value, `${prefix}.position[${axis}]`, errors, { min: -150, max: 150 }))
    finite(book.localDensity, `${prefix}.localDensity`, errors, { min: 0, max: 1 })
    finite(book.outlierScore, `${prefix}.outlierScore`, errors, { min: 0, max: 1 })
    finite(book.magnitude, `${prefix}.magnitude`, errors, { min: Number.MIN_VALUE })
    finite(book.halo, `${prefix}.halo`, errors, { min: 0, max: 2 })
    if (!cleanText(book.shape)) errors.push(`${prefix}.shape 缺失`)
    finite(book.temperature, `${prefix}.temperature`, errors, { min: 0, max: 1 })
    if (!Array.isArray(book.neighbors) || book.neighbors.length < minDegree) errors.push(`${prefix}.neighbors 少于 ${minDegree} 个`)
    if (Array.isArray(book.neighbors)) {
      const seen = new Set()
      for (const [neighbourIndex, neighbour] of book.neighbors.entries()) {
        const neighbourLabel = `${prefix}.neighbors[${neighbourIndex}]`
        if (!isObject(neighbour)) {
          errors.push(`${neighbourLabel} 必须是对象`)
          continue
        }
        const target = cleanText(neighbour.id)
        if (!allBookIds.has(target)) errors.push(`${neighbourLabel} 存在悬空节点：${target}`)
        if (target === id || seen.has(target)) errors.push(`${neighbourLabel} 存在自环或重复`)
        seen.add(target)
        finite(neighbour.similarity, `${neighbourLabel}.similarity`, errors, { min: 0, max: 1 })
        finite(neighbour.surprise, `${neighbourLabel}.surprise`, errors, { min: 0, max: 1 })
        if (neighbour.navigable === true) {
          validateBasis(neighbour.basis, `${neighbourLabel}.basis`, errors)
          navigableNeighbourKeys.add(edgeKey(id, target))
        }
      }
    }
    if (Array.isArray(book.spatialNeighbors)) {
      const seen = new Set()
      for (const target of book.spatialNeighbors) {
        const value = cleanText(target)
        if (!allBookIds.has(value)) errors.push(`${prefix}.spatialNeighbors 存在悬空节点：${value}`)
        if (value === id || seen.has(value)) errors.push(`${prefix}.spatialNeighbors 存在自环或重复`)
        seen.add(value)
      }
    }
  }

  for (const id of ids) directionalCoverage.set(id, { near: 0, bridge: 0, far: 0 })

  const relationKeys = new Set()
  for (const [index, relation] of relations.entries()) {
    const prefix = `relations[${index}]`
    if (!isObject(relation)) {
      errors.push(`${prefix} 必须是对象`)
      continue
    }
    const source = cleanText(relation.source)
    const target = cleanText(relation.target)
    if (!ids.has(source) || !ids.has(target)) errors.push(`${prefix} 存在悬空端点：${source}/${target}`)
    if (!source || source === target) errors.push(`${prefix} 不能是自环`)
    const key = edgeKey(source, target)
    if (relationKeys.has(key)) errors.push(`${prefix} 存在重复无向边：${key}`)
    relationKeys.add(key)
    finite(relation.similarity, `${prefix}.similarity`, errors, { min: 0, max: 1 })
    finite(relation.weight, `${prefix}.weight`, errors, { min: 0, max: 1 })
    finite(relation.surprise, `${prefix}.surprise`, errors, { min: 0, max: 1 })
    if (!isObject(relation.surpriseByBook) || !isObject(relation.bandByBook)) {
      errors.push(`${prefix} 缺少逐出发书校准的 surpriseByBook/bandByBook`)
    } else {
      const endpointIds = [source, target]
      for (const [bookId, surprise] of Object.entries(relation.surpriseByBook)) {
        if (!endpointIds.includes(bookId)) errors.push(`${prefix}.surpriseByBook 含非端点：${bookId}`)
        finite(surprise, `${prefix}.surpriseByBook.${bookId}`, errors, { min: 0, max: 1 })
      }
      for (const bookId of Object.keys(relation.bandByBook)) {
        if (!endpointIds.includes(bookId)) errors.push(`${prefix}.bandByBook 含非端点：${bookId}`)
      }
      for (const bookId of endpointIds) {
        if (!Object.hasOwn(relation.surpriseByBook, bookId)) {
          errors.push(`${prefix}.surpriseByBook 缺少端点：${bookId}`)
          continue
        }
        const surprise = relation.surpriseByBook[bookId]
        const expectedBand = directionalBand(surprise)
        if (!Object.hasOwn(relation.bandByBook, bookId)) {
          errors.push(`${prefix}.bandByBook 缺少端点：${bookId}`)
          continue
        }
        const band = relation.bandByBook[bookId]
        if (!Object.values(STORED_DIRECTIONAL_BAND).includes(band)) {
          errors.push(`${prefix}.bandByBook.${bookId} 必须是 low、middle 或 high`)
          continue
        }
        if (expectedBand && band !== STORED_DIRECTIONAL_BAND[expectedBand]) {
          errors.push(`${prefix}.${bookId} 的 bandByBook=${band} 与 surpriseByBook=${surprise} 不一致，应为 ${STORED_DIRECTIONAL_BAND[expectedBand]}`)
          continue
        }
        const coverage = directionalCoverage.get(bookId)
        if (coverage && expectedBand) coverage[expectedBand] += 1
      }
    }
    finite(relation.confidence, `${prefix}.confidence`, errors, { min: 0, max: 1 })
    validateBasis(relation.basis, `${prefix}.basis`, errors)
    if (!RELATION_KINDS.has(String(relation.kind || ''))) errors.push(`${prefix}.kind 不是应用支持的关系类型`)
    if (cleanText(relation.sentence).length < 20) errors.push(`${prefix}.sentence 缺少具体解释`)
    if (relation.provenance !== 'semantic') errors.push(`${prefix}.provenance 必须为 semantic`)
    if (relation.evidence === undefined) errors.push(`${prefix}.evidence 缺失`)
    else {
      validateEvidence(relation.evidence, `${prefix}.evidence`, errors)
      validateRelationEvidence(relation.evidence, bookById.get(source), bookById.get(target), `${prefix}.evidence`, errors)
    }
    if (degree.has(source)) degree.set(source, degree.get(source) + 1)
    if (degree.has(target)) degree.set(target, degree.get(target) + 1)
  }
  for (const key of navigableNeighbourKeys) if (!relationKeys.has(key)) errors.push(`可漫游邻居缺少最终关系：${key}`)
  for (const [id, count] of degree) if (count < minDegree) errors.push(`书 ${id} 的关系数仅 ${count}，少于 ${minDegree}`)
  for (const [id, coverage] of directionalCoverage) {
    const missing = DIRECTIONAL_BANDS.filter((band) => coverage[band] < 1)
    if (missing.length) errors.push(`书 ${id} 的最终公开关系缺少逐出发 ${missing.join('、')} surprise 候选（near < ${SURPRISE_NEAR_MAX}，bridge < ${SURPRISE_BRIDGE_MAX}，far ≥ ${SURPRISE_BRIDGE_MAX}）`)
  }

  const summaryLengths = books.filter(isObject).map((book) => chineseCount(book.summary)).sort((left, right) => left - right)
  const summaryMedian = summaryLengths[Math.floor(summaryLengths.length / 2)] || 0
  if (manifestObject.coverage?.summaries?.count !== summaryCount) errors.push('manifest.coverage.summaries.count 不一致')
  if (manifestObject.coverage?.summaries?.medianChineseCharacters !== summaryMedian) errors.push('manifest.coverage.summaries.medianChineseCharacters 不一致')
  if (manifestObject.coverage?.namedAuthors?.count !== namedAuthorCount) errors.push('manifest.coverage.namedAuthors.count 不一致')
  if (manifestObject.coverage?.covers?.count !== coverCount) errors.push('manifest.coverage.covers.count 不一致')
  if (manifestObject.coverage?.chineseTitles?.count !== titleCount) errors.push('manifest.coverage.chineseTitles.count 不一致')
  if (manifestObject.coverage?.themes?.count !== themeCount) errors.push('manifest.coverage.themes.count 不一致')
  if (manifestObject.coverage?.sourceUrls?.count !== sourceCount) errors.push('manifest.coverage.sourceUrls.count 不一致')
  if (manifestObject.coverage?.relations?.booksWithAtLeastThree !== [...degree.values()].filter((value) => value >= 3).length) errors.push('manifest.coverage.relations.booksWithAtLeastThree 不一致')
  if (manifestObject.eligibilityCoverage?.count !== eligibilityCount || manifestObject.eligibilityCoverage?.total !== books.length || manifestObject.eligibilityCoverage?.rate !== Number((eligibilityCount / Math.max(1, books.length)).toFixed(4))) errors.push('manifest.eligibilityCoverage 不一致')
  if (manifestObject.revisionUrlCoverage?.count !== revisionUrlCount || manifestObject.revisionUrlCoverage?.total !== books.length || manifestObject.revisionUrlCoverage?.rate !== Number((revisionUrlCount / Math.max(1, books.length)).toFixed(4))) errors.push('manifest.revisionUrlCoverage 不一致')
  if (eligibilityCount !== books.length) errors.push(`eligibilityCoverage 必须为 100%，当前 ${eligibilityCount}/${books.length}`)
  if (revisionUrlCount !== books.length) errors.push(`revisionUrlCoverage 必须为 100%，当前 ${revisionUrlCount}/${books.length}`)
  const requiredSources = [
    ['works.url', manifestObject.sources?.works?.url, 'wikipedia'],
    ['works.metadataUrl', manifestObject.sources?.works?.metadataUrl, 'wikidata-api'],
    ['works.candidateUrl', manifestObject.sources?.works?.candidateUrl, 'wdqs'],
    ['summaries.url', manifestObject.sources?.summaries?.url, 'wikipedia'],
    ['covers.url', manifestObject.sources?.covers?.url, 'openlibrary-api'],
  ]
  for (const [label, url, kind] of requiredSources) {
    if (!isTrustedEndpointUrl(url, kind)) errors.push(`manifest.sources.${label} 不是受信任的固定数据源端点`)
  }

  if (errors.length) {
    console.error(`v2 书目检查失败（${errors.length} 项）：`)
    for (const error of errors.slice(0, 80)) console.error(`- ${error}`)
    if (errors.length > 80) console.error(`- 其余 ${errors.length - 80} 项省略`)
    process.exitCode = 1
    return
  }
  const degreeValues = [...degree.values()]
  const directionalCoverageValues = [...directionalCoverage.values()]
  console.log(JSON.stringify({
    ok: true,
    catalog: catalogPath,
    manifest: manifestPath,
    books: books.length,
    relations: relations.length,
    minimumDegree: Math.min(...degreeValues),
    averageDegree: Number((degreeValues.reduce((sum, value) => sum + value, 0) / degreeValues.length).toFixed(3)),
    chineseTitles: titleCount,
    summaries: summaryCount,
    themes: themeCount,
    covers: coverCount,
    eligibility: eligibilityCount,
    revisionUrls: revisionUrlCount,
    directionalSurprise: {
      booksWithNearBridgeFar: directionalCoverageValues.filter((coverage) => DIRECTIONAL_BANDS.every((band) => coverage[band] > 0)).length,
      near: directionalCoverageValues.reduce((sum, coverage) => sum + coverage.near, 0),
      bridge: directionalCoverageValues.reduce((sum, coverage) => sum + coverage.bridge, 0),
      far: directionalCoverageValues.reduce((sum, coverage) => sum + coverage.far, 0),
    },
    sha256: manifest.catalogSha256,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
