#!/usr/bin/env node

/**
 * Build and validate the field-level attribution sidecar for the v2 catalog.
 *
 * This script is intentionally fail-closed.  It refuses to read a legacy
 * catalog (for example the old Project Gutenberg snapshot), and it validates
 * every source link before touching the output file.  `--smoke` exercises the
 * same deterministic builder with an in-memory fixture, so it is safe to run
 * while public/data/catalog.json is still a v1 payload.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ATTRIBUTION_NOTICE,
  CC_BY_SA_4_URL,
  isOpenLibraryCoverUrl,
  isOpenLibrarySourceUrl,
  isWikipediaRevisionUrl,
  isWikipediaSourceUrl,
  isWikidataUrl,
  runSourceUrlSelfTest,
} from './lib/source-urls.mjs'
import { COVER_REMOVAL_CONTACT_URL, LIFECYCLE_STATUSES } from './lib/cover-policy.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CATALOG = resolve(ROOT, 'public/data/catalog.json')
const DEFAULT_OUTPUT = resolve(ROOT, 'public/data/ATTRIBUTION.json')
const CATALOG_SCHEMA = 'bookshelf-galaxy/catalog-v2'
const ATTRIBUTION_SCHEMA = 'bookshelf-galaxy/attribution-v2'

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

function cleanText(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function validateCatalog(catalog) {
  const errors = []
  if (!isObject(catalog)) return { books: [], errors: ['catalog 必须是对象'] }
  if (catalog.schemaVersion !== CATALOG_SCHEMA) {
    return {
      books: [],
      errors: [`拒绝非 v2 catalog：schemaVersion=${String(catalog.schemaVersion || '(缺失)')}；期望 ${CATALOG_SCHEMA}`],
    }
  }
  if (!Array.isArray(catalog.books) || catalog.books.length < 1) {
    errors.push('catalog.books 必须是非空数组')
    return { books: [], errors }
  }

  const ids = new Set()
  for (const [index, book] of catalog.books.entries()) {
    const prefix = `catalog.books[${index}]`
    if (!isObject(book)) {
      errors.push(`${prefix} 必须是对象`)
      continue
    }
    const id = cleanText(book.id)
    const title = cleanText(book.title)
    const sourceUrl = cleanText(book.sourceUrl)
    const wikidataUrl = cleanText(book.wikidataUrl)
    const wikipediaRevisionUrl = cleanText(book.wikipediaRevisionUrl || book.provenance?.wikipediaRevisionUrl)
    const coverSourceUrl = book.coverSourceUrl == null ? null : cleanText(book.coverSourceUrl)
    if (!id) errors.push(`${prefix}.id 缺失`)
    else if (ids.has(id)) errors.push(`${prefix}.id 重复：${id}`)
    else ids.add(id)
    if (!title) errors.push(`${prefix}.title 缺失`)
    if (!isWikipediaSourceUrl(sourceUrl)) errors.push(`${prefix}.sourceUrl 必须是中文维基百科文章 HTTPS 链接`)
    if (!isWikipediaRevisionUrl(sourceUrl, wikipediaRevisionUrl)) errors.push(`${prefix}.wikipediaRevisionUrl 必须是与 sourceUrl 对应且带纯数字 oldid 的中文维基百科固定修订链接`)
    if (!/^Q\d+$/u.test(id)) errors.push(`${prefix}.id 必须是 Wikidata Q-id：${id || '(缺失)'}`)
    else if (!isWikidataUrl(wikidataUrl, id)) {
      errors.push(`${prefix}.wikidataUrl 必须链接到该作品的 Wikidata 项：${id}`)
    }
    if (book.coverUrl !== null && book.coverUrl !== undefined && !isOpenLibraryCoverUrl(cleanText(book.coverUrl))) {
      errors.push(`${prefix}.coverUrl 必须是 covers.openlibrary.org 的固定 JPG 封面链接或 null`)
    }
    if (coverSourceUrl !== null && !isOpenLibrarySourceUrl(coverSourceUrl)) {
      errors.push(`${prefix}.coverSourceUrl 必须是 Open Library work 或 exact Edition 链接或 null`)
    }
    if (book.coverAsset !== undefined) {
      if (!isObject(book.coverAsset)) errors.push(`${prefix}.coverAsset 必须是对象`)
      else {
        if (book.coverAsset.reviewStatus !== 'approved') errors.push(`${prefix}.coverAsset.reviewStatus 必须是 approved`)
        if (!LIFECYCLE_STATUSES.has(book.coverAsset.lifecycle?.status)) errors.push(`${prefix}.coverAsset.lifecycle.status 无效`)
        if (!cleanText(book.coverAsset.lifecycle?.purgeKey)) errors.push(`${prefix}.coverAsset.lifecycle.purgeKey 缺失`)
        if (book.coverAsset.rights?.removalContactUrl !== COVER_REMOVAL_CONTACT_URL) errors.push(`${prefix}.coverAsset.rights.removalContactUrl 无效`)
        if (book.coverAsset.lifecycle?.status === 'active' && (!book.coverUrl || !coverSourceUrl)) errors.push(`${prefix} active coverAsset 缺少运行时封面或 exact Edition 回链`)
        if (book.coverAsset.lifecycle?.status !== 'active' && (book.coverUrl != null || coverSourceUrl != null)) errors.push(`${prefix} 非 active coverAsset 不得进入运行时`)
      }
    }
  }
  return { books: catalog.books, errors }
}

function buildAttribution(catalog, catalogSha256) {
  const validation = validateCatalog(catalog)
  if (validation.errors.length) {
    throw new Error(`归属文件构建拒绝（${validation.errors.length} 项）：\n${validation.errors.slice(0, 80).map((item) => `- ${item}`).join('\n')}${validation.errors.length > 80 ? `\n- 其余 ${validation.errors.length - 80} 项省略` : ''}`)
  }

  const entries = validation.books.map((book) => ({
    id: cleanText(book.id),
    title: cleanText(book.title),
    sourceUrl: cleanText(book.sourceUrl),
    wikidataUrl: cleanText(book.wikidataUrl),
    wikipediaRevisionUrl: cleanText(book.wikipediaRevisionUrl || book.provenance?.wikipediaRevisionUrl),
    coverUrl: book.coverUrl == null ? null : cleanText(book.coverUrl),
    coverSourceUrl: book.coverSourceUrl == null ? null : cleanText(book.coverSourceUrl),
    ...(book.coverAsset !== undefined ? { coverAsset: structuredClone(book.coverAsset) } : {}),
  })).sort((left, right) => left.id.localeCompare(right.id, 'en'))

  return {
    schemaVersion: ATTRIBUTION_SCHEMA,
    catalogSchemaVersion: CATALOG_SCHEMA,
    license: {
      name: 'CC BY-SA 4.0',
      url: CC_BY_SA_4_URL,
      notice: ATTRIBUTION_NOTICE,
    },
    catalogSha256,
    coverRemovalContactUrl: COVER_REMOVAL_CONTACT_URL,
    entryCount: entries.length,
    entries,
  }
}

function validateAttribution(attribution, catalog, catalogSha256) {
  if (attribution?.schemaVersion !== ATTRIBUTION_SCHEMA) throw new Error(`ATTRIBUTION.json schemaVersion 必须为 ${ATTRIBUTION_SCHEMA}`)
  if (attribution?.coverRemovalContactUrl !== COVER_REMOVAL_CONTACT_URL) throw new Error('ATTRIBUTION.json 缺少真实封面移除联系入口')
  if (!isObject(attribution?.license)
    || attribution.license.name !== 'CC BY-SA 4.0'
    || attribution.license.url !== CC_BY_SA_4_URL
    || attribution.license.notice !== ATTRIBUTION_NOTICE) {
    throw new Error('ATTRIBUTION.json 缺少明确的 CC BY-SA 4.0 license.name、license.url 或 license.notice')
  }
  const expected = buildAttribution(catalog, catalogSha256)
  const actualText = stableJson(attribution)
  const expectedText = stableJson(expected)
  if (actualText !== expectedText) {
    throw new Error('ATTRIBUTION.json 与 catalog 不一致，或不是由当前脚本按确定性格式生成')
  }
  return expected
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
  await rename(temporary, path)
}

function smokeFixture() {
  return {
    schemaVersion: CATALOG_SCHEMA,
    books: [
      {
        id: 'Q2',
        title: '乙本',
        sourceUrl: 'https://zh.wikipedia.org/wiki/%E4%B9%99%E6%9C%AC',
        wikidataUrl: 'https://www.wikidata.org/wiki/Q2',
        provenance: { wikipediaRevisionUrl: 'https://zh.wikipedia.org/wiki/%E4%B9%99%E6%9C%AC?oldid=2002' },
        coverSourceUrl: null,
      },
      {
        id: 'Q1',
        title: '甲本',
        sourceUrl: 'https://zh.wikipedia.org/wiki/%E7%94%B2%E6%9C%AC',
        wikidataUrl: 'https://www.wikidata.org/wiki/Q1',
        provenance: { wikipediaRevisionUrl: 'https://zh.wikipedia.org/wiki/%E7%94%B2%E6%9C%AC?oldid=1001' },
        coverUrl: 'https://covers.openlibrary.org/b/id/1-M.jpg',
        coverSourceUrl: 'https://openlibrary.org/works/OL1W',
      },
    ],
  }
}

async function runSmoke() {
  runSourceUrlSelfTest()
  const fixture = smokeFixture()
  const catalogBuffer = Buffer.from(stableJson(fixture), 'utf8')
  const first = buildAttribution(fixture, sha256(catalogBuffer))
  const second = buildAttribution(fixture, sha256(catalogBuffer))
  const firstText = stableJson(first)
  if (firstText !== stableJson(second)) throw new Error('smoke 失败：同一输入产生了不同输出')
  validateAttribution(JSON.parse(firstText), fixture, sha256(catalogBuffer))
  if (first.entries[0].id !== 'Q1' || first.entries[1].id !== 'Q2') {
    throw new Error('smoke 失败：entries 没有按 id 稳定排序')
  }
  if (first.entries[0].wikipediaRevisionUrl !== 'https://zh.wikipedia.org/wiki/%E7%94%B2%E6%9C%AC?oldid=1001') {
    throw new Error('smoke 失败：没有保留固定 Wikipedia 修订链接')
  }
  if (first.license?.name !== 'CC BY-SA 4.0' || first.license.url !== CC_BY_SA_4_URL || first.license.notice !== ATTRIBUTION_NOTICE) {
    throw new Error('smoke 失败：缺少明确的 CC BY-SA 4.0 许可证声明')
  }
  const invalid = structuredClone(fixture)
  delete invalid.books[0].provenance.wikipediaRevisionUrl
  try {
    buildAttribution(invalid, sha256(Buffer.from(stableJson(invalid), 'utf8')))
    throw new Error('smoke 失败：缺少 wikipediaRevisionUrl 时没有拒绝')
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('wikipediaRevisionUrl')) throw error
  }
  console.log(JSON.stringify({ ok: true, mode: 'smoke', entries: first.entryCount, writes: 0 }, null, 2))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.smoke) return runSmoke()

  const catalogPath = pathValue(options.catalog, DEFAULT_CATALOG)
  const outputPath = pathValue(options.output, DEFAULT_OUTPUT)
  const catalogBuffer = await readFile(catalogPath)
  let catalog
  try {
    catalog = JSON.parse(catalogBuffer.toString('utf8'))
  } catch (error) {
    throw new Error(`catalog 不是有效 JSON：${error instanceof Error ? error.message : error}`)
  }
  // validateCatalog is called before any output operation.  This is the guard
  // that prevents a v1 catalog from overwriting the eventual official sidecar.
  const attribution = buildAttribution(catalog, sha256(catalogBuffer))
  if (options.check) {
    const existing = await readJson(outputPath, 'ATTRIBUTION.json')
    validateAttribution(existing, catalog, sha256(catalogBuffer))
    console.log(JSON.stringify({ ok: true, mode: 'check', catalog: relative(ROOT, catalogPath), output: relative(ROOT, outputPath), entries: attribution.entryCount }, null, 2))
    return
  }

  await writeAtomic(outputPath, stableJson(attribution))
  console.log(JSON.stringify({ ok: true, mode: 'build', catalog: relative(ROOT, catalogPath), output: relative(ROOT, outputPath), entries: attribution.entryCount, catalogSha256: attribution.catalogSha256 }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
