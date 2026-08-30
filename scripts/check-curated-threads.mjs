#!/usr/bin/env node

/**
 * Gate the hand-written "冥冥书线" batches without executing their source.
 *
 * TypeScript 7 exposes its compiler scanner through unstable/ast rather than
 * the old JavaScript createSourceFile API.  The scanner is used to build a
 * literal-only AST for the direct array/object form used by the batches.  No
 * eval, module loading, or source-code execution is involved.
 */

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript/unstable/ast'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const THREAD_DIR = resolve(ROOT, 'src/data/curatedThreads')
const DEFAULT_RICH = resolve(ROOT, 'data/rich/books.json')
const LEGACY_RELATIVE = 'src/data/curatedRelations.ts'
const LEGACY_PATH = resolve(ROOT, LEGACY_RELATIVE)
const NAMED_FILES = ['chinese.ts', 'world.ts', 'ideas.ts', 'cross-domain.ts']
const EXPECTED_SHARDS = Array.from({ length: 12 }, (_, index) => `shard-${String(index).padStart(2, '0')}.ts`)
const KINDS = new Set(['回声', '镜像', '暗河', '裂隙', '余烬', '潮汐'])
const QID = /^Q\d+$/u
const CHINESE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu
const FORBIDDEN_TERMS = [
  '多维',
  '语义',
  '相似度',
  '相似',
  '模型',
  '摘要',
  '书目',
  '算法',
  '计算',
  '书目字段',
  '字段',
  '百分比',
  '可见依据',
  '可解释',
  '检索',
  '向量',
  '%',
  '％',
]
const BOUNDED_NUMERIC_FIELDS = new Set(['surprise', 'confidence', 'similarity'])
const REQUIRED_NUMERIC_FIELDS = new Set(['surprise', 'confidence'])
const MAX_ERRORS = 80

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) continue
    const [key, inline] = argument.slice(2).split('=', 2)
    const value = inline ?? argv[index + 1]
    if (inline === undefined && value && !value.startsWith('--')) index += 1
    if (value !== undefined && value !== true) values[key] = value
  }
  return values
}

function chineseCount(value) {
  return (String(value ?? '').match(CHINESE) || []).length
}

function quantile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  if (!sorted.length) return 0
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function relationKey(source, target) {
  return source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`
}

function lineNumber(text, position) {
  const end = Math.max(0, Math.min(Number(position) || 0, text.length))
  let line = 1
  for (let index = 0; index < end; index += 1) if (text.charCodeAt(index) === 10) line += 1
  return line
}

class ParseFailure extends Error {
  constructor(message, position) {
    super(message)
    this.position = position
  }
}

function tokenKind(name) {
  return ts.SyntaxKind[name]
}

function isToken(token, name) {
  return token?.kind === tokenKind(name)
}

/** A literal-only parser. Its output is an AST-shaped tree, never executable. */
class LiteralAstParser {
  constructor(text, fileName) {
    this.text = text
    this.fileName = fileName
    this.tokens = []
    const scanner = ts.createScanner(true, ts.LanguageVariant.Standard, text)
    let templateInterpolationDepth = 0
    while (true) {
      let kind = scanner.scan()
      if (kind === tokenKind('TemplateHead')) templateInterpolationDepth = 1
      else if (templateInterpolationDepth > 0 && kind === tokenKind('OpenBraceToken')) templateInterpolationDepth += 1
      else if (templateInterpolationDepth > 0 && kind === tokenKind('CloseBraceToken')) {
        templateInterpolationDepth -= 1
        if (templateInterpolationDepth === 0) {
          kind = scanner.reScanTemplateToken()
          if (kind === tokenKind('TemplateMiddle')) templateInterpolationDepth = 1
        }
      }
      const token = {
        kind,
        text: scanner.getTokenText(),
        value: scanner.getTokenValue(),
        start: scanner.getTokenStart(),
        end: scanner.getTokenEnd(),
      }
      this.tokens.push(token)
      if (kind === tokenKind('EndOfFileToken') || kind === tokenKind('EndOfFile')) break
    }
  }

  fail(message, token = this.tokens[0]) {
    throw new ParseFailure(`${this.fileName}:${lineNumber(this.text, token?.start ?? 0)} ${message}`, token?.start ?? 0)
  }

  expect(index, name) {
    const token = this.tokens[index]
    if (!isToken(token, name)) this.fail(`期待 ${name}，实际为 ${token?.text || 'EOF'}`, token)
    return index + 1
  }

  parseString(index) {
    const token = this.tokens[index]
    if (!isToken(token, 'StringLiteral') && !isToken(token, 'NoSubstitutionTemplateLiteral')) return null
    return { node: { type: 'string', value: String(token.value ?? '') }, next: index + 1 }
  }

  parseNumber(index) {
    const token = this.tokens[index]
    if (!isToken(token, 'NumericLiteral')) return null
    const value = Number(token.value ?? token.text)
    if (!Number.isFinite(value)) this.fail('数值字面量不是有限数', token)
    return { node: { type: 'number', value }, next: index + 1 }
  }

  parseValue(index) {
    const token = this.tokens[index]
    const stringValue = this.parseString(index)
    if (stringValue) return stringValue
    const numberValue = this.parseNumber(index)
    if (numberValue) return numberValue
    if (isToken(token, 'TrueKeyword') || isToken(token, 'FalseKeyword')) {
      return { node: { type: 'boolean', value: isToken(token, 'TrueKeyword') }, next: index + 1 }
    }
    if (isToken(token, 'NullKeyword')) return { node: { type: 'null', value: null }, next: index + 1 }
    if (isToken(token, 'MinusToken') || isToken(token, 'PlusToken')) {
      const numeric = this.parseNumber(index + 1)
      if (!numeric) this.fail('一元符号后必须是数值字面量', token)
      return {
        node: { type: 'number', value: isToken(token, 'MinusToken') ? -numeric.node.value : numeric.node.value },
        next: numeric.next,
      }
    }
    if (isToken(token, 'OpenParenToken')) {
      const wrapped = this.parseValue(index + 1)
      return { node: wrapped.node, next: this.expect(wrapped.next, 'CloseParenToken') }
    }
    if (isToken(token, 'OpenBracketToken')) return this.parseArray(index)
    if (isToken(token, 'OpenBraceToken')) return this.parseObject(index)
    // A few batches keep the five literal arguments in a local makeThread
    // helper.  Read that whitelisted call as data; never evaluate the helper.
    if (token?.kind === tokenKind('Identifier') && token.text === 'makeThread') return this.parseMakeThread(index)
    if (token?.kind === tokenKind('Identifier') && token.text === 'rel') return this.parseRel(index)
    this.fail(`只允许字面量，不能解析 ${token?.text || 'EOF'}`, token)
  }

  parseMakeThread(index) {
    let cursor = this.expect(index + 1, 'OpenParenToken')
    const args = []
    for (let argument = 0; argument < 5; argument += 1) {
      const value = this.parseValue(cursor)
      args.push(value.node)
      cursor = value.next
      if (argument < 4) cursor = this.expect(cursor, 'CommaToken')
    }
    cursor = this.expect(cursor, 'CloseParenToken')
    const [source, target, kind, sentence, basis] = args
    return {
      node: {
        type: 'object',
        properties: new Map([
          ['source', source],
          ['target', target],
          ['kind', kind],
          ['sentence', sentence],
          ['basis', basis],
        ]),
        start: this.tokens[index]?.start ?? 0,
      },
      next: cursor,
    }
  }

  parseRel(index) {
    let cursor = this.expect(index + 1, 'OpenParenToken')
    const args = []
    for (let argument = 0; argument < 7; argument += 1) {
      const value = this.parseValue(cursor)
      args.push(value.node)
      cursor = value.next
      if (argument < 6) cursor = this.expect(cursor, 'CommaToken')
    }
    cursor = this.expect(cursor, 'CloseParenToken')
    const [source, target, kind, sentence, basis, surprise, confidence] = args
    const sourceValue = asString(source) || ''
    const targetValue = asString(target) || ''
    return {
      node: {
        type: 'object',
        properties: new Map([
          ['id', { type: 'string', value: `${sourceValue}--${targetValue}` }],
          ['source', source],
          ['target', target],
          ['kind', kind],
          ['sentence', sentence],
          ['basis', basis],
          ['surprise', surprise],
          ['confidence', confidence],
        ]),
        start: this.tokens[index]?.start ?? 0,
      },
      next: cursor,
    }
  }

  parseArray(index) {
    let cursor = this.expect(index, 'OpenBracketToken')
    const elements = []
    while (!isToken(this.tokens[cursor], 'CloseBracketToken')) {
      if (isToken(this.tokens[cursor], 'CommaToken')) {
        cursor += 1
        continue
      }
      if (isToken(this.tokens[cursor], 'DotDotDotToken')) this.fail('不允许展开表达式', this.tokens[cursor])
      const value = this.parseValue(cursor)
      elements.push(value.node)
      cursor = value.next
      if (isToken(this.tokens[cursor], 'CommaToken')) cursor += 1
      else if (!isToken(this.tokens[cursor], 'CloseBracketToken')) this.fail('数组元素之间缺少逗号', this.tokens[cursor])
    }
    return { node: { type: 'array', elements }, next: this.expect(cursor, 'CloseBracketToken') }
  }

  parseObject(index) {
    let cursor = this.expect(index, 'OpenBraceToken')
    const properties = new Map()
    while (!isToken(this.tokens[cursor], 'CloseBraceToken')) {
      const keyToken = this.tokens[cursor]
      const keyKind = keyToken?.kind
      if (![tokenKind('Identifier'), tokenKind('StringLiteral'), tokenKind('NumericLiteral')].includes(keyKind)) {
        this.fail('对象只允许简单属性名', keyToken)
      }
      const key = String(keyToken.value ?? keyToken.text)
      cursor = this.expect(cursor + 1, 'ColonToken')
      const value = this.parseValue(cursor)
      if (properties.has(key)) this.fail(`对象属性重复：${key}`, keyToken)
      properties.set(key, value.node)
      cursor = value.next
      if (isToken(this.tokens[cursor], 'CommaToken')) cursor += 1
      else if (!isToken(this.tokens[cursor], 'CloseBraceToken')) this.fail('对象属性之间缺少逗号', this.tokens[cursor])
    }
    return { node: { type: 'object', properties, start: this.tokens[index]?.start ?? 0 }, next: this.expect(cursor, 'CloseBraceToken') }
  }

  collectArrays() {
    const depths = []
    let depth = 0
    for (const token of this.tokens) {
      depths.push(depth)
      if (['OpenBraceToken', 'OpenBracketToken', 'OpenParenToken'].some((name) => isToken(token, name))) depth += 1
      if (['CloseBraceToken', 'CloseBracketToken', 'CloseParenToken'].some((name) => isToken(token, name))) depth = Math.max(0, depth - 1)
    }

    const arrays = []
    for (let index = 0; index < this.tokens.length; index += 1) {
      const token = this.tokens[index]
      if (depths[index] !== 0 || !isToken(token, 'ConstKeyword')) continue
      let equals = index + 1
      while (equals < this.tokens.length && !isToken(this.tokens[equals], 'EqualsToken') && !isToken(this.tokens[equals], 'SemicolonToken')) equals += 1
      if (!isToken(this.tokens[equals], 'EqualsToken') || !isToken(this.tokens[equals + 1], 'OpenBracketToken')) continue
      const name = this.tokens[index + 1]?.text || `const@${lineNumber(this.text, token.start)}`
      const parsed = this.parseArray(equals + 1)
      arrays.push({ name, node: parsed.node, start: token.start })
      index = parsed.next - 1
    }
    return arrays
  }
}

function findForbidden(value) {
  const text = String(value ?? '')
  return FORBIDDEN_TERMS.find((term) => text.includes(term))
}

function asString(node) {
  return node?.type === 'string' ? node.value : undefined
}

function asNumber(node) {
  return node?.type === 'number' ? node.value : undefined
}

function asArray(node) {
  return node?.type === 'array' ? node.elements : undefined
}

function property(record, key) {
  return record.properties.get(key)
}

function fileLabel(filePath) {
  return filePath.replace(`${ROOT}${process.platform === 'win32' ? '\\' : '/'}`, '').replaceAll('\\', '/')
}

function displayRecord(record) {
  return `${record.file}:${record.line}`
}

function templateKey(sentence, sourceTitle, targetTitle) {
  let normalized = sentence.normalize('NFKC')
  for (const title of [sourceTitle, targetTitle]) {
    if (title) normalized = normalized.replaceAll(title, '书')
  }
  return normalized
    .replace(/《[^》]*》/gu, '书')
    .replace(/“[^”]*”/gu, '书')
    .replace(/‘[^’]*’/gu, '书')
    .replace(/「[^」]*」/gu, '书')
    .replace(/『[^』]*』/gu, '书')
    .replace(/"[^"]*"/gu, '书')
    .replace(/[A-Za-z][A-Za-z0-9'’.-]*/gu, '字母')
    .replace(/\d+/gu, '数字')
    .replace(/\s+/gu, '')
}

function openingKey(sentence, sourceTitle, targetTitle) {
  const normalized = templateKey(sentence, sourceTitle, targetTitle)
  return normalized.split(/[，。！？；：、,.!?;:]/u)[0].slice(0, 16)
}

function collectCounts(records, field) {
  const counts = new Map()
  for (const record of records) {
    const value = field(record)
    counts.set(value, (counts.get(value) || 0) + 1)
  }
  return counts
}

function collectOccurrences(records, field) {
  const occurrences = new Map()
  for (const record of records) {
    for (const value of field(record)) {
      const entries = occurrences.get(value) || []
      entries.push(record)
      occurrences.set(value, entries)
    }
  }
  return occurrences
}

function normalizedChinese(value) {
  return String(value ?? '').match(CHINESE) || []
}

/**
 * Return the long tail windows plus shorter windows inside the final clause.
 * The latter catches a repeated six-character sign-off even when each
 * sentence has a different preceding clause.  Five characters are excluded
 * deliberately so ordinary short words do not become a false alarm.
 */
function tailKeys(sentence, sourceTitle, targetTitle) {
  const normalized = templateKey(sentence, sourceTitle, targetTitle)
  const keys = new Set()
  const whole = normalizedChinese(normalized)
  for (let length = 8; length <= 18 && whole.length >= length; length += 1) {
    keys.add(`末${length}字：${whole.slice(-length).join('')}`)
  }
  const clauses = normalized.split(/[，。！？；：、,.!?;:]/u).filter(Boolean)
  const finalClause = normalizedChinese(clauses.at(-1) || normalized)
  for (let length = 6; length <= 18 && finalClause.length >= length; length += 1) {
    keys.add(`末分句${length}字：${finalClause.slice(-length).join('')}`)
  }
  return [...keys]
}

const GENERIC_GALAXY_CLOSURE = /(?:星海中?相遇|书海中?相遇|星河中?相遇|星云中?相遇|银河中?相遇|在(?:星海|书海|星河|星云|银河)中?(?:相遇|相连|汇流|照亮)|书星|星光|同一片(?:天空|星空)|彼此(?:照亮|相望|相遇|相连)|在此(?:相遇|相认|汇流|靠岸)|(?:遥遥|互相)(?:相望|照见)|留下回声|汇入星|照亮彼此|相遇|相连)$/u
const TITLE_SPAN = /《[^》]*》/gu

function weakParallelTitleSentence(sentence, sourceTitle, targetTitle) {
  const titleSpans = String(sentence).match(TITLE_SPAN) || []
  const quotedPair = titleSpans.length === 2
  const plainPair = sourceTitle && targetTitle && sourceTitle !== targetTitle
    && String(sentence).includes(sourceTitle)
    && String(sentence).includes(targetTitle)
  if ((!quotedPair && !plainPair) || !GENERIC_GALAXY_CLOSURE.test(String(sentence).trim())) return false
  let withoutTitles = String(sentence)
    .replace(TITLE_SPAN, '')
  if (plainPair) withoutTitles = withoutTitles.replaceAll(sourceTitle, '').replaceAll(targetTitle, '')
  withoutTitles = withoutTitles
    .replace(/[\s\dA-Za-z“”‘’「」『』，。！？；：、,.!?;:（）()【】\[\]—–-]/gu, '')
  return normalizedChinese(withoutTitles).length <= 18
}

async function sourceFiles() {
  const required = [...NAMED_FILES, ...EXPECTED_SHARDS]
  const discovered = existsSync(THREAD_DIR)
    ? (await readdir(THREAD_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
    : []
  // Keep required names in the returned list so the caller emits an explicit
  // missing-file error, while every future topical .ts batch is also scanned.
  return [...new Set([...required, ...discovered])].sort()
}

function addError(errors, message) {
  errors.push(message)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const richPath = resolve(ROOT, String(options.input || DEFAULT_RICH))
  const errors = []
  const threadFiles = await sourceFiles()
  const sources = [
    ...threadFiles.map((file) => ({ relative: `src/data/curatedThreads/${file}`, path: resolve(THREAD_DIR, file) })),
    { relative: LEGACY_RELATIVE, path: LEGACY_PATH },
  ]
  const expectedMissing = sources.filter(({ path }) => !existsSync(path))
  for (const { relative } of expectedMissing) addError(errors, `缺少书线文件：${relative}`)

  let richBooks = []
  if (!existsSync(richPath)) {
    addError(errors, `找不到端点真源：${richPath}`)
  } else {
    try {
      const snapshot = JSON.parse(await readFile(richPath, 'utf8'))
      richBooks = Array.isArray(snapshot.books) ? snapshot.books : []
      if (!richBooks.length) addError(errors, '端点真源 books 为空')
    } catch (error) {
      addError(errors, `端点真源不是有效 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const bookIds = new Set(richBooks.map((book) => book?.id).filter((id) => QID.test(String(id))))
  const bookTitles = new Map(richBooks.map((book) => [book?.id, String(book?.title || '')]))

  const records = []
  const fileStats = {}
  for (const { relative, path } of sources) {
    if (!existsSync(path)) {
      fileStats[relative] = { present: false, arrays: 0, records: 0, fieldValidRecords: 0, uniquePairs: 0, uniqueTargets: 0, maxTargetDegree: 0 }
      continue
    }
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      addError(errors, `${relative} 无法读取：${error instanceof Error ? error.message : String(error)}`)
      fileStats[relative] = { present: false, arrays: 0, records: 0, fieldValidRecords: 0, uniquePairs: 0, uniqueTargets: 0, maxTargetDegree: 0 }
      continue
    }
    let arrays
    try {
      arrays = new LiteralAstParser(text, relative).collectArrays()
    } catch (error) {
      addError(errors, `${relative} AST 解析失败：${error instanceof Error ? error.message : String(error)}`)
      fileStats[relative] = { present: true, arrays: 0, records: 0, fieldValidRecords: 0, uniquePairs: 0, uniqueTargets: 0, maxTargetDegree: 0 }
      continue
    }
    const fileRecords = []
    for (const array of arrays) {
      for (const node of array.node.elements) {
        if (node.type !== 'object') {
          addError(errors, `${relative}:${lineNumber(text, array.start)} ${array.name} 含有非对象元素`)
          continue
        }
        fileRecords.push({ node, file: relative, line: lineNumber(text, node.start), array: array.name })
      }
    }
    fileStats[relative] = { present: true, arrays: arrays.length, records: fileRecords.length, fieldValidRecords: 0, uniquePairs: 0, uniqueTargets: 0, maxTargetDegree: 0 }
    records.push(...fileRecords)
  }

  const pairOccurrences = new Map()
  const sentenceOccurrences = new Map()
  const validRecords = []
  const allRecordIds = new Map()
  for (const record of records) {
    const prefix = displayRecord(record)
    const source = asString(property(record.node, 'source'))
    const target = asString(property(record.node, 'target'))
    const kind = asString(property(record.node, 'kind'))
    const sentence = asString(property(record.node, 'sentence'))
    const basisNodes = asArray(property(record.node, 'basis'))
    let valid = true

    const id = asString(property(record.node, 'id'))
    if (property(record.node, 'id') !== undefined && (!id || !id.trim())) {
      addError(errors, `${prefix}.id 必须是非空字符串`)
      valid = false
    } else if (id) {
      if (allRecordIds.has(id)) addError(errors, `${prefix}.id 与 ${allRecordIds.get(id)} 重复`)
      else allRecordIds.set(id, prefix)
    }

    if (!QID.test(String(source || ''))) {
      addError(errors, `${prefix}.source 不是 Wikidata Q-id`)
      valid = false
    }
    if (!QID.test(String(target || ''))) {
      addError(errors, `${prefix}.target 不是 Wikidata Q-id`)
      valid = false
    }
    if (QID.test(String(source || '')) && QID.test(String(target || ''))) {
      if (source === target) {
        addError(errors, `${prefix} 存在自环：${source}`)
        valid = false
      }
      const key = relationKey(source, target)
      const occurrences = pairOccurrences.get(key) || []
      occurrences.push(prefix)
      pairOccurrences.set(key, occurrences)
      if (!bookIds.has(source)) {
        addError(errors, `${prefix}.source 悬空：${source}`)
        valid = false
      }
      if (!bookIds.has(target)) {
        addError(errors, `${prefix}.target 悬空：${target}`)
        valid = false
      }
    }
    if (!KINDS.has(String(kind || ''))) {
      addError(errors, `${prefix}.kind 不是六种书线类型之一`)
      valid = false
    }
    if (typeof sentence !== 'string' || chineseCount(sentence) < 22 || chineseCount(sentence) > 100) {
      addError(errors, `${prefix}.sentence 必须含 22–100 个中文字符，当前 ${chineseCount(sentence)}`)
      valid = false
    } else {
      const normalizedSentence = sentence.trim()
      const occurrences = sentenceOccurrences.get(normalizedSentence) || []
      occurrences.push(prefix)
      sentenceOccurrences.set(normalizedSentence, occurrences)
      const forbidden = findForbidden(sentence)
      if (forbidden) {
        addError(errors, `${prefix}.sentence 含禁用技术词：${forbidden}`)
        valid = false
      }
    }
    if (!Array.isArray(basisNodes) || basisNodes.length < 2 || basisNodes.length > 3) {
      addError(errors, `${prefix}.basis 必须有 2–3 项`)
      valid = false
    } else {
      const basis = []
      for (const node of basisNodes) {
        const item = asString(node)
        if (!item || !item.trim()) {
          addError(errors, `${prefix}.basis 含空项或非字符串`)
          valid = false
        } else {
          basis.push(item)
          const forbidden = findForbidden(item)
          if (forbidden) {
            addError(errors, `${prefix}.basis 含禁用技术词：${forbidden}`)
            valid = false
          }
        }
      }
      if (new Set(basis).size !== basis.length) {
        addError(errors, `${prefix}.basis 不应有重复项`)
        valid = false
      }
    }

    for (const [field, node] of record.node.properties) {
      if (node.type !== 'number') continue
      if (!Number.isFinite(node.value)) {
        addError(errors, `${prefix}.${field} 必须是有限数`)
        valid = false
      }
      if (BOUNDED_NUMERIC_FIELDS.has(field) && (node.value < 0 || node.value > 1)) {
        addError(errors, `${prefix}.${field} 必须在 0..1 之间`)
        valid = false
      }
      if (field === 'weight' && node.value < 0) {
        addError(errors, `${prefix}.weight 不能为负数`)
        valid = false
      }
    }
    for (const field of REQUIRED_NUMERIC_FIELDS) {
      const node = property(record.node, field)
      if (node !== undefined && node.type !== 'number') {
        addError(errors, `${prefix}.${field} 必须是数值字面量`)
        valid = false
      }
    }
    if (source && target && sentence && valid) {
      const normalizedSentence = sentence.trim()
      validRecords.push({ ...record, source, target, kind, sentence: normalizedSentence, basis: basisNodes.map((node) => asString(node)), sourceTitle: bookTitles.get(source), targetTitle: bookTitles.get(target) })
    } else {
    }
  }

  for (const [key, occurrences] of pairOccurrences) {
    if (occurrences.length > 1) addError(errors, `无向书线重复 ${occurrences.length} 次：${key.replace('\u0000', ' ↔ ')}`)
  }
  for (const [sentence, occurrences] of sentenceOccurrences) {
    if (occurrences.length > 1) addError(errors, `关系文案完全重复 ${occurrences.length} 次：${sentence.slice(0, 80)}`)
  }

  const uniqueRecords = []
  const uniquePairs = new Set()
  for (const record of validRecords) {
    fileStats[record.file].fieldValidRecords += 1
    const key = relationKey(record.source, record.target)
    if (uniquePairs.has(key)) continue
    uniquePairs.add(key)
    uniqueRecords.push(record)
    fileStats[record.file].uniquePairs += 1
  }

  for (const [file, stats] of Object.entries(fileStats)) {
    const targetCounts = collectCounts(validRecords.filter((record) => record.file === file), (record) => record.target)
    stats.uniqueTargets = targetCounts.size
    stats.maxTargetDegree = Math.max(0, ...targetCounts.values())
    if (stats.records >= 200 && /\/shard-\d+\.ts$/u.test(file)) {
      if (stats.uniqueTargets < 80) {
        addError(errors, `${file} 目标过度集中：records ${stats.records} 条，仅 ${stats.uniqueTargets} 个 uniqueTargets，至少需要 80 个`)
      }
      if (stats.maxTargetDegree > 12) {
        const [target, count] = [...targetCounts.entries()].sort(([leftTarget, leftCount], [rightTarget, rightCount]) => rightCount - leftCount || leftTarget.localeCompare(rightTarget))[0] || []
        addError(errors, `${file} 单一 target 过度集中：${target || '未知'} 出现 ${count || stats.maxTargetDegree} 次，最多允许 12 次`)
      }
    }
  }

  const degree = new Map([...bookIds].map((id) => [id, 0]))
  for (const record of uniqueRecords) {
    degree.set(record.source, degree.get(record.source) + 1)
    degree.set(record.target, degree.get(record.target) + 1)
  }
  const degreeValues = [...degree.values()]
  const missingBooks = [...degree].filter(([, count]) => count < 1).map(([id]) => id)
  if (missingBooks.length) addError(errors, `${missingBooks.length} 本书没有任何冥冥书线：${missingBooks.slice(0, 20).join('、')}${missingBooks.length > 20 ? '……' : ''}`)
  if (uniquePairs.size < 3000) addError(errors, `有效无向书线仅 ${uniquePairs.size} 条，至少需要 3000 条`)

  const top10Hubs = [...degree.entries()]
    .filter(([, count]) => count > 0)
    .sort(([leftId, leftCount], [rightId, rightCount]) => rightCount - leftCount || leftId.localeCompare(rightId))
    .slice(0, 10)
    .map(([id, count]) => ({
      id,
      title: bookTitles.get(id) || '',
      degree: count,
      uniquePairShare: uniquePairs.size ? Number((count / uniquePairs.size).toFixed(4)) : 0,
    }))
  const hubViolations = [...degree.entries()]
    .filter(([, count]) => uniquePairs.size > 0 && count / uniquePairs.size > 0.02)
    .sort(([leftId, leftCount], [rightId, rightCount]) => rightCount - leftCount || leftId.localeCompare(rightId))
  if (hubViolations.length) {
    addError(errors, `全局书线 hub 过度集中：${hubViolations.map(([id, count]) => `${id} ${count}/${uniquePairs.size}（${(count / uniquePairs.size * 100).toFixed(2)}%）`).join('、')}，单书占比不得超过 2%`)
  }

  const openingCounts = collectCounts(uniqueRecords, (record) => openingKey(record.sentence, record.sourceTitle, record.targetTitle))
  const skeletonCounts = collectCounts(uniqueRecords, (record) => templateKey(record.sentence, record.sourceTitle, record.targetTitle))
  const openingLimit = Math.max(24, Math.ceil(Math.max(uniqueRecords.length, 1) * 0.015))
  const skeletonLimit = Math.max(12, Math.ceil(Math.max(uniqueRecords.length, 1) * 0.01))
  const maxOpeningCopies = Math.max(0, ...openingCounts.values())
  const maxSkeletonCopies = Math.max(0, ...skeletonCounts.values())
  if (maxOpeningCopies > openingLimit) addError(errors, `书线开头高度模板化：最高重复 ${maxOpeningCopies} 次，超过 ${openingLimit} 次`)
  if (maxSkeletonCopies > skeletonLimit) addError(errors, `书线句式高度模板化：最高重复 ${maxSkeletonCopies} 次，超过 ${skeletonLimit} 次`)

  const tailOccurrences = collectOccurrences(uniqueRecords, (record) => tailKeys(record.sentence, record.sourceTitle, record.targetTitle))
  const tailLimit = Math.max(12, Math.ceil(Math.max(uniqueRecords.length, 1) * 0.005))
  const repeatedTailCandidates = [...tailOccurrences.entries()]
    .filter(([, occurrences]) => occurrences.length > tailLimit)
    .sort(([, left], [, right]) => right.length - left.length)
  const tailPhrase = (key) => key.slice(key.indexOf('：') + 1)
  // A repeated 6-character suffix also makes every longer suffix repeat when
  // the preceding words happen to match. Report the shortest suffix in each
  // family once, keeping the gate readable and avoiding duplicate alarms.
  const repeatedTails = repeatedTailCandidates.filter(([key]) => {
    const phrase = tailPhrase(key)
    return !repeatedTailCandidates.some(([otherKey]) => {
      const other = tailPhrase(otherKey)
      return other.length < phrase.length && phrase.endsWith(other)
    })
  })
  for (const [tail, occurrences] of repeatedTails) {
    const files = [...new Set(occurrences.map((record) => record.file))].sort()
    addError(errors, `书线收尾高度重复 ${occurrences.length} 次（${tail}，上限 ${tailLimit}），涉及 ${files.join('、')}；示例 ${occurrences.slice(0, 3).map(displayRecord).join('、')}`)
  }

  const weakParallelTitles = uniqueRecords.filter((record) => weakParallelTitleSentence(record.sentence, record.sourceTitle, record.targetTitle))
  if (weakParallelTitles.length) {
    const byFile = new Map()
    for (const record of weakParallelTitles) {
      const entries = byFile.get(record.file) || []
      entries.push(record)
      byFile.set(record.file, entries)
    }
    const summary = [...byFile.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, entries]) => `${file} ${entries.length} 条（${entries.slice(0, 2).map(displayRecord).join('、')}）`)
      .join('；')
    addError(errors, `弱书线句式 ${weakParallelTitles.length} 条：仅并列两个题名并以泛化星海收束；${summary}`)
  }

  const kindCounts = Object.fromEntries([...KINDS].map((kind) => [kind, 0]))
  for (const record of uniqueRecords) kindCounts[record.kind] += 1
  const stats = {
    ok: errors.length === 0,
    richCatalog: fileLabel(richPath),
    sourceFiles: sources.length,
    presentFiles: sources.length - expectedMissing.length,
    records: records.length,
    fieldValidRecords: validRecords.length,
    uniquePairs: uniquePairs.size,
    minimumUniquePairs: 3000,
    books: bookIds.size,
    booksWithLine: degreeValues.filter((count) => count > 0).length,
    degree: {
      p10: Number(quantile(degreeValues, 0.1).toFixed(3)),
      median: Number(quantile(degreeValues, 0.5).toFixed(3)),
      max: Math.max(0, ...degreeValues),
    },
    top10Hubs,
    kinds: kindCounts,
    templates: {
      uniqueSentences: sentenceOccurrences.size,
      maxOpeningCopies,
      maxSkeletonCopies,
      openingLimit,
      skeletonLimit,
      tailLimit,
      repeatedTailKinds: repeatedTails.length,
      maxTailCopies: Math.max(0, ...[...tailOccurrences.values()].map((occurrences) => occurrences.length)),
      weakParallelTitleSentences: weakParallelTitles.length,
    },
    files: fileStats,
    errors: errors.slice(0, MAX_ERRORS),
    errorCount: errors.length,
  }

  if (errors.length) {
    console.error(`冥冥书线门禁失败：${errors.length} 项`)
    console.log(JSON.stringify(stats, null, 2))
    process.exitCode = 1
    return
  }
  console.log(JSON.stringify(stats, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exitCode = 1
})
