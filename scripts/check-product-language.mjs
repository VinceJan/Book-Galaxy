#!/usr/bin/env node

/**
 * Product-language gate for the public reading experience.
 *
 * This is deliberately a small, dependency-free check.  It looks only at
 * public copy (UI source literals, the README front page, and curated prose),
 * not hidden catalog sentences, implementation names, evidence arrays, or
 * URLs. Schema and generated-catalog content are checked by check-v2-catalog.
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED_SOURCE_FILES = [
  'src/components/ExperienceUI.tsx',
  'src/App.tsx',
  'src/ai/curator.ts',
]
const OPTIONAL_SOURCE_FILES = [
  'src/lib/starChart.ts',
]
const CURATED_LEGACY_SOURCE = 'src/data/curatedRelations.ts'
const CURATED_THREAD_DIRECTORY = 'src/data/curatedThreads'
const README_SOURCE = 'README.md'
const FORBIDDEN_COPY = [
  ['多维语义', /多维(?:书目)?语义/gu],
  ['语义术语', /语义/gu],
  ['语义相似度', /语义相似度/gu],
  ['模型与摘要或书目', /模型[^。！？\n]{0,28}(?:摘要|书目)|(?:摘要|书目)[^。！？\n]{0,28}模型/gu],
  ['摘要与书目字段', /摘要与书目字段/gu],
  ['书目术语', /书目/gu],
  ['书目字段', /书目字段/gu],
  ['字段术语', /字段/gu],
  ['可见依据', /可见依据/gu],
  ['向量相似', /向量相似(?:度)?/gu],
  ['相似度术语', /相似度/gu],
  ['算法计算', /算法(?:计算|生成|推断|推荐)?/gu],
  ['语义推断', /语义推断/gu],
  ['语义交界处', /语义交界处/gu],
  ['语义接近', /语义接近/gu],
  ['书目检索', /书目检索/gu],
  ['可解释偏航', /可解释(?:的)?(?:偏航|关系|连接)?/gu],
]
const PERCENT_TEMPLATE = /(?:\d+(?:\.\d+)?\s*[%％]|百分之\s*[\d一二三四五六七八九十百千万零点]+)/gu
const MAX_IDENTICAL_RELATION_COPIES = 3
const MAX_README_LINES = 140
const README_FORBIDDEN_COPY = [
  ['比赛话术', /黑客松|赛题|路演|评委|评审/gu],
]
const README_FORBIDDEN_HEADINGS = new Set([
  '技术架构',
  '数据质量硬门槛',
  '视觉编码',
  '重建正式数据',
  '静态部署',
])
const README_REQUIRED_REFERENCES = [
  'https://vincejan.github.io/Book-Galaxy/',
  'docs/hero-preview.png',
  'docs/star-chart-preview.png',
  'docs/architecture.md',
]

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

function cleanText(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

function displayPath(filePath, root = ROOT) {
  const relativePath = relative(root, filePath).replaceAll('\\', '/')
  return relativePath || filePath
}

function lineLocation(text, index) {
  const line = text.slice(0, index).split('\n').length
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  const column = index - lineStart + 1
  const lineEnd = text.indexOf('\n', index)
  const rawLine = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
  return { line, column, excerpt: cleanText(rawLine).slice(0, 240) }
}

/**
 * Return quoted literals and plain JSX text, rather than the whole source.
 * This is the important boundary: an internal regex such as
 * `/多维|语义|字段/` is not product copy and must not fail the gate, while a
 * Chinese phrase inside a JSX string or template literal is public copy.
 */
function sourceCopyRanges(source) {
  const ranges = []
  let state = 'code'
  let quote = ''
  let start = 0
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (state === 'line-comment') {
      if (character === '\n') state = 'code'
      continue
    }
    if (state === 'block-comment') {
      if (character === '*' && source[index + 1] === '/') {
        index += 1
        state = 'code'
      }
      continue
    }
    if (state === 'string') {
      if (character === '\\') {
        index += 1
        continue
      }
      if (character === quote) {
        if (index > start) ranges.push({ start, end: index, text: source.slice(start, index) })
        state = 'code'
        quote = ''
      }
      continue
    }
    if (character === '/' && source[index + 1] === '/') {
      index += 1
      state = 'line-comment'
      continue
    }
    if (character === '/' && source[index + 1] === '*') {
      index += 1
      state = 'block-comment'
      continue
    }
    if (character === '\'' || character === '"' || character === '`') {
      state = 'string'
      quote = character
      start = index + 1
    }
  }

  // JSX prose is not quoted. Restrict it to non-empty Chinese text between
  // tags so comparison operators and layout syntax stay outside this gate.
  const jsxText = />\s*([^<>{}\r\n]*[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF][^<>{}\r\n]*)\s*</gu
  for (const match of source.matchAll(jsxText)) {
    const full = match[0]
    const text = match[1]
    const offset = (match.index ?? 0) + full.indexOf(text)
    ranges.push({ start: offset, end: offset + text.length, text })
  }
  return ranges
}

function forbiddenLabels(text) {
  const labels = []
  for (const [label, pattern] of FORBIDDEN_COPY) {
    pattern.lastIndex = 0
    if (pattern.test(text)) labels.push(label)
    pattern.lastIndex = 0
  }
  return labels
}

function addCopyFindings(source, filePath, errors) {
  for (const range of sourceCopyRanges(source)) {
    const labels = forbiddenLabels(range.text)
    if (labels.length > 0) {
      const location = lineLocation(source, range.start)
      errors.push({
        path: `${filePath}:${location.line}:${location.column}`,
        message: `公开文案包含不应出现的技术套话（${labels.join('、')}）`,
        excerpt: location.excerpt,
      })
    }
  }
}

function readLiteral(source, index, limit = source.length) {
  const quote = source[index]
  if (quote !== '\'' && quote !== '"' && quote !== '`') return null
  for (let cursor = index + 1; cursor < limit; cursor += 1) {
    if (source[cursor] === '\\') {
      cursor += 1
      continue
    }
    if (source[cursor] === quote) {
      return {
        start: index + 1,
        end: cursor,
        next: cursor + 1,
        text: source.slice(index + 1, cursor),
      }
    }
  }
  return null
}

function maskStringsAndComments(source) {
  const chars = source.split('')
  let state = 'code'
  let quote = ''
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (state === 'line-comment') {
      if (character === '\n') state = 'code'
      else chars[index] = ' '
      continue
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        chars[index] = ' '
        chars[index + 1] = ' '
        index += 1
        state = 'code'
      } else if (character !== '\n') {
        chars[index] = ' '
      }
      continue
    }
    if (state === 'string') {
      if (character === '\\') {
        chars[index] = ' '
        if (source[index + 1] !== '\n' && source[index + 1] !== '\r') chars[index + 1] = ' '
        index += 1
      } else if (character === quote) {
        chars[index] = ' '
        state = 'code'
        quote = ''
      } else if (character !== '\n') {
        chars[index] = ' '
      }
      continue
    }
    if (character === '/' && next === '/') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 1
      state = 'line-comment'
    } else if (character === '/' && next === '*') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 1
      state = 'block-comment'
    } else if (character === '\'' || character === '"' || character === '`') {
      chars[index] = ' '
      state = 'string'
      quote = character
    }
  }
  return chars.join('')
}

function matchingDelimiter(source, openIndex, limit = source.length) {
  const expected = { '(': ')', '[': ']', '{': '}' }
  const stack = []
  let state = 'code'
  let quote = ''
  for (let index = openIndex; index < limit; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (state === 'line-comment') {
      if (character === '\n') state = 'code'
      continue
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        index += 1
        state = 'code'
      }
      continue
    }
    if (state === 'string') {
      if (character === '\\') index += 1
      else if (character === quote) {
        state = 'code'
        quote = ''
      }
      continue
    }
    if (character === '/' && next === '/') {
      index += 1
      state = 'line-comment'
    } else if (character === '/' && next === '*') {
      index += 1
      state = 'block-comment'
    } else if (character === '\'' || character === '"' || character === '`') {
      state = 'string'
      quote = character
    } else if (expected[character]) {
      stack.push(expected[character])
    } else if (character === stack.at(-1)) {
      stack.pop()
      if (stack.length === 0) return index
    }
  }
  return -1
}

function inspectReadme(readme, errors, stats) {
  stats.readmeLines = readme.split('\n').length
  if (stats.readmeLines > MAX_README_LINES) {
    errors.push({
      path: README_SOURCE,
      message: `README 共 ${stats.readmeLines} 行，超过门面文档 ${MAX_README_LINES} 行上限`,
      excerpt: '技术细节应链接到 docs/architecture.md 或 data-sources.md',
    })
  }

  for (const [label, pattern] of README_FORBIDDEN_COPY) {
    pattern.lastIndex = 0
    for (const match of readme.matchAll(pattern)) {
      const location = lineLocation(readme, match.index ?? 0)
      errors.push({
        path: `${README_SOURCE}:${location.line}:${location.column}`,
        message: `README 仍包含不属于长期产品门面的${label}`,
        excerpt: location.excerpt,
      })
    }
    pattern.lastIndex = 0
  }

  for (const match of readme.matchAll(/^##\s+(.+?)\s*$/gmu)) {
    const heading = cleanText(match[1])
    if (!README_FORBIDDEN_HEADINGS.has(heading)) continue
    const location = lineLocation(readme, match.index ?? 0)
    errors.push({
      path: `${README_SOURCE}:${location.line}:${location.column}`,
      message: `README 不应内联“${heading}”，请放入专题文档`,
      excerpt: location.excerpt,
    })
  }

  for (const reference of README_REQUIRED_REFERENCES) {
    if (readme.includes(reference)) continue
    errors.push({
      path: README_SOURCE,
      message: `README 缺少必要的体验或视觉引用：${reference}`,
      excerpt: reference,
    })
  }
}

function splitArguments(source, start, end) {
  const args = []
  const stack = []
  let state = 'code'
  let quote = ''
  let argumentStart = start
  for (let index = start; index < end; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (state === 'line-comment') {
      if (character === '\n') state = 'code'
      continue
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        index += 1
        state = 'code'
      }
      continue
    }
    if (state === 'string') {
      if (character === '\\') index += 1
      else if (character === quote) {
        state = 'code'
        quote = ''
      }
      continue
    }
    if (character === '/' && next === '/') {
      index += 1
      state = 'line-comment'
    } else if (character === '/' && next === '*') {
      index += 1
      state = 'block-comment'
    } else if (character === '\'' || character === '"' || character === '`') {
      state = 'string'
      quote = character
    } else if (character === '(' || character === '[' || character === '{') {
      stack.push(character)
    } else if (character === ')' || character === ']' || character === '}') {
      if (stack.at(-1) && { ')': '(', ']': '[', '}': '{' }[character] === stack.at(-1)) stack.pop()
    } else if (character === ',' && stack.length === 0) {
      args.push({ start: argumentStart, end: index })
      argumentStart = index + 1
    }
  }
  if (argumentStart < end) args.push({ start: argumentStart, end })
  return args
}

function skipWhitespace(source, index, limit = source.length) {
  let cursor = index
  while (cursor < limit && /\s/u.test(source[cursor])) cursor += 1
  return cursor
}

function literalRecordsInRange(source, start, end) {
  const records = []
  let state = 'code'
  for (let index = start; index < end; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (state === 'line-comment') {
      if (character === '\n') state = 'code'
      continue
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        index += 1
        state = 'code'
      }
      continue
    }
    if (character === '/' && next === '/') {
      index += 1
      state = 'line-comment'
      continue
    }
    if (character === '/' && next === '*') {
      index += 1
      state = 'block-comment'
      continue
    }
    if (character !== '\'' && character !== '"' && character !== '`') continue
    const literal = readLiteral(source, index, end)
    if (!literal) continue
    records.push({ start: literal.start, text: literal.text })
    index = literal.next - 1
  }
  return records
}

/**
 * Extract only relation prose from TypeScript data modules.  It understands
 * the shipped `sentence: ...`, `basis: [...]`, and legacy `rel(...)` shapes;
 * it never imports or executes the module.
 */
function curatedCopyRecords(source) {
  const masked = maskStringsAndComments(source)
  const records = []
  const seen = new Set()
  const add = (record, field) => {
    const key = `${field}:${record.start}`
    if (seen.has(key)) return
    seen.add(key)
    records.push({ ...record, field })
  }

  for (const field of ['sentence', 'reason', 'description']) {
    const propertyPattern = new RegExp(`\\b${field}\\s*:\\s*`, 'gu')
    for (const match of masked.matchAll(propertyPattern)) {
      const valueIndex = skipWhitespace(source, (match.index ?? 0) + match[0].length)
      const literal = readLiteral(source, valueIndex)
      if (literal) add({ start: literal.start, text: literal.text }, field)
    }
  }

  const basisPattern = /\bbasis\s*:\s*/gu
  for (const match of masked.matchAll(basisPattern)) {
    const valueIndex = skipWhitespace(source, (match.index ?? 0) + match[0].length)
    if (source[valueIndex] !== '[') continue
    const end = matchingDelimiter(source, valueIndex)
    if (end < 0) continue
    for (const literal of literalRecordsInRange(source, valueIndex + 1, end)) add(literal, 'basis')
  }

  const relPattern = /\b(?:rel|makeThread)\s*\(/gu
  for (const match of masked.matchAll(relPattern)) {
    const openIndex = (match.index ?? 0) + match[0].lastIndexOf('(')
    const end = matchingDelimiter(source, openIndex)
    if (end < 0) continue
    const args = splitArguments(source, openIndex + 1, end)
    const sentenceArgument = args[3]
    if (sentenceArgument) {
      const sentenceIndex = skipWhitespace(source, sentenceArgument.start, sentenceArgument.end)
      const literal = readLiteral(source, sentenceIndex, sentenceArgument.end)
      if (literal) add({ start: literal.start, text: literal.text }, 'sentence')
    }
    const basisArgument = args[4]
    if (basisArgument) {
      const basisIndex = skipWhitespace(source, basisArgument.start, basisArgument.end)
      if (source[basisIndex] === '[') {
        const basisEnd = matchingDelimiter(source, basisIndex, basisArgument.end)
        if (basisEnd >= 0) {
          for (const literal of literalRecordsInRange(source, basisIndex + 1, basisEnd)) add(literal, 'basis')
        }
      }
    }
  }
  return records
}

function canonicalText(value) {
  return cleanText(value)
    .toLocaleLowerCase('zh-CN')
    .replace(/\s+/gu, '')
}

function relationTemplate(value) {
  return canonicalText(value)
    .replace(/《[^》]+》/gu, '《书》')
    .replace(/“[^”]+”/gu, '“线索”')
    .replace(/「[^」]+」/gu, '「线索」')
    .replace(/\d+(?:\.\d+)?/gu, '#')
}

function inspectCuratedRecords(records, errors, stats) {
  stats.curatedTexts = records.length
  const exactCounts = new Map()
  const templateCounts = new Map()
  for (const record of records) {
    const text = cleanText(record.text)
    if (!text) {
      errors.push({
        path: record.path,
        message: `策展 ${record.field} 文案为空`,
        excerpt: '请补充真实的阅读联想，或移除这个空字段',
      })
      continue
    }
    const labels = forbiddenLabels(text)
    if (labels.length > 0) {
      errors.push({
        path: record.path,
        message: `策展文案包含不应出现的技术套话（${labels.join('、')}）`,
        excerpt: text.slice(0, 240),
      })
    }
    if (PERCENT_TEMPLATE.test(text)) {
      errors.push({
        path: record.path,
        message: '策展文案不得使用百分比或相似度数值模板',
        excerpt: text.slice(0, 240),
      })
    }
    PERCENT_TEMPLATE.lastIndex = 0
    // Basis labels are short editorial tags and may intentionally recur
    // across many routes; duplicate-prose checks apply to the sentence-like
    // copy while basis still goes through the forbidden/percent checks above.
    if (record.field !== 'basis') {
      const exactKey = canonicalText(text)
      const exact = exactCounts.get(exactKey) ?? []
      exact.push({ path: record.path, text })
      exactCounts.set(exactKey, exact)
      const templateKey = relationTemplate(text)
      const template = templateCounts.get(templateKey) ?? []
      template.push({ path: record.path, text })
      templateCounts.set(templateKey, template)
    }
  }

  for (const [text, copies] of exactCounts) {
    if (text && copies.length > MAX_IDENTICAL_RELATION_COPIES) {
      errors.push({
        path: copies[0].path,
        message: `策展文案完全重复 ${copies.length} 次，超过 ${MAX_IDENTICAL_RELATION_COPIES} 次上限`,
        excerpt: `${copies[0].text.slice(0, 180)}（示例：${copies.slice(0, 3).map((copy) => copy.path).join('、')}）`,
      })
    }
  }
  const templateLimit = Math.max(8, Math.ceil(Math.max(stats.curatedTexts, 1) * 0.01))
  for (const [template, copies] of templateCounts) {
    if (template && copies.length > templateLimit) {
      errors.push({
        path: copies[0].path,
        message: `策展文案骨架重复 ${copies.length} 次，超过 ${templateLimit} 次上限`,
        excerpt: `${copies[0].text.slice(0, 180)}（模板化重复示例：${copies.slice(0, 3).map((copy) => copy.path).join('、')}）`,
      })
    }
  }
  stats.uniqueCuratedTexts = exactCounts.size
  stats.maxCuratedExactCopies = Math.max(0, ...[...exactCounts.values()].map((copies) => copies.length))
  stats.maxCuratedTemplateCopies = Math.max(0, ...[...templateCounts.values()].map((copies) => copies.length))
}

async function discoverCuratedSources(root, errors) {
  const files = [resolve(root, CURATED_LEGACY_SOURCE)]
  const directory = resolve(root, CURATED_THREAD_DIRECTORY)
  if (!existsSync(directory)) return files
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    files.push(...entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => resolve(directory, entry.name))
      .sort())
  } catch (error) {
    errors.push({
      path: CURATED_THREAD_DIRECTORY,
      message: `策展目录无法读取：${error instanceof Error ? error.message : String(error)}`,
      excerpt: directory,
    })
  }
  return files
}

async function readText(filePath, label, errors) {
  if (!existsSync(filePath)) {
    errors.push({ path: label, message: '文件不存在', excerpt: filePath })
    return null
  }
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    errors.push({ path: label, message: `文件无法读取：${error instanceof Error ? error.message : String(error)}`, excerpt: filePath })
    return null
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const root = options.root ? resolve(String(options.root)) : ROOT
  const errors = []
  const sourceByPath = new Map()
  const stats = {
    sourceFiles: 0,
    curatedSourceFiles: 0,
    readmeLines: 0,
    curatedTexts: 0,
    uniqueCuratedTexts: 0,
    maxCuratedExactCopies: 0,
    maxCuratedTemplateCopies: 0,
  }

  for (const relativePath of REQUIRED_SOURCE_FILES) {
    const filePath = resolve(root, relativePath)
    const source = await readText(filePath, relativePath, errors)
    if (source === null) continue
    stats.sourceFiles += 1
    sourceByPath.set(relativePath, source)
    addCopyFindings(source, displayPath(filePath, root), errors)
  }
  for (const relativePath of OPTIONAL_SOURCE_FILES) {
    const filePath = resolve(root, relativePath)
    if (!existsSync(filePath)) continue
    const source = await readText(filePath, relativePath, errors)
    if (source === null) continue
    stats.sourceFiles += 1
    sourceByPath.set(relativePath, source)
    addCopyFindings(source, displayPath(filePath, root), errors)
  }

  const readmeText = await readText(resolve(root, README_SOURCE), README_SOURCE, errors)
  if (readmeText !== null) inspectReadme(readmeText, errors, stats)

  const curatedRecords = []
  for (const filePath of await discoverCuratedSources(root, errors)) {
    const relativePath = displayPath(filePath, root)
    const source = await readText(filePath, relativePath, errors)
    if (source === null) continue
    stats.curatedSourceFiles += 1
    const records = curatedCopyRecords(source)
    if (records.length === 0 && /\b(?:sentence|basis|rel)\b/u.test(maskStringsAndComments(source))) {
      errors.push({
        path: relativePath,
        message: '策展文案未能由受限静态扫描解析，请检查 sentence/basis/rel 的数据形状',
        excerpt: '门禁拒绝在无法确认用户可见文案时放行',
      })
    }
    for (const record of records) {
      const location = lineLocation(source, record.start)
      curatedRecords.push({
        ...record,
        path: `${relativePath}:${location.line}:${location.column}`,
      })
    }
  }
  inspectCuratedRecords(curatedRecords, errors, stats)

  if (errors.length > 0) {
    console.error(`产品文案门禁失败：${errors.length} 项`)
    for (const error of errors.slice(0, 80)) {
      console.error(`- ${error.path}：${error.message}`)
      if (error.excerpt) console.error(`  片段：${error.excerpt}`)
    }
    if (errors.length > 80) console.error(`- 其余 ${errors.length - 80} 项省略`)
    console.error(`扫描统计：${stats.sourceFiles} 个界面源码文件，${stats.curatedSourceFiles} 个策展源码文件，${stats.curatedTexts} 段策展文案；未扫描隐藏目录句`)
    process.exitCode = 1
    return
  }

  console.log(`产品文案门禁通过：${stats.sourceFiles} 个界面源码文件，${stats.curatedSourceFiles} 个策展源码文件，${stats.curatedTexts} 段策展文案；未扫描隐藏目录句`)
  console.log(`策展重复度：${stats.uniqueCuratedTexts} 段独立文案，同文案最高 ${stats.maxCuratedExactCopies} 次、骨架最高 ${stats.maxCuratedTemplateCopies} 次`)
  console.log(`README 门面检查通过：${stats.readmeLines} 行，视觉入口与专题文档引用完整`)
}

await main()
