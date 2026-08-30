#!/usr/bin/env node

/**
 * Validate data/rich/layout.json without loading the embedding model.
 *
 * The layout generator emits spatialNeighbors so this check can validate the
 * semantic/spatial overlap in linear time.  A bounded sample also recomputes
 * Euclidean spatial neighbours from the coordinates; it never builds an
 * N-by-N distance matrix.
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaults = {
  input: resolve(root, 'data/rich/books.json'),
  layout: resolve(root, 'data/rich/layout.json'),
}
const MODEL_NAME = 'BAAI/bge-small-zh-v1.5'
const MIN_K = 12
const MAX_K = 18
const MAX_COORDINATE = 150
const BASIS = new Set(['多维书目语义相似度', '主题', '作者', '时代', '地域'])
const FORBIDDEN_FRONTEND_SENTENCE_TERMS = [
  '模型', '摘要', '书目', '字段', '向量', '语义', '算法', '相似度', '百分比', '检索', '可解释', '多维',
]
const EXPECTED_CANDIDATE_K = 96
const SHAPES = new Set(['orb', 'ring', 'diamond', 'petal', 'seed', 'cross', 'flare'])
const GENERIC_THEMES = new Set([
  '阅读与人性', '时代与命运', '世界文学', '未分类', '主题未知', '未分类/主题未知',
  '文本叙事', '作品语境', '阅读路径',
  '閱讀與人性', '時代與命運', '世界文學', '未分類',
])
const UNKNOWN_METADATA = new Set(['', '未知', '不详', '未注明', '未詳', '无', 'n/a', 'na', 'none', 'null', 'unknown', '-'])
const UNKNOWN_AUTHORS = new Set([...UNKNOWN_METADATA, '佚名', '匿名', 'anonymous', 'unknown author'])
const SAMPLE_SIZE = 128
const MIN_RELATION_DEGREE = 3
const RECOMMENDED_RELATION_DEGREE = 6

function parseArgs(argv) {
  const values = { ...defaults }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) continue
    const [key, inline] = argument.slice(2).split('=', 2)
    const value = inline ?? argv[index + 1]
    if (inline === undefined && value && !value.startsWith('--')) index += 1
    if (value) values[key] = resolve(root, value)
  }
  return values
}

function fail(message) {
  throw new Error(message)
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be finite`)
  return value
}

function bounded(value, label, low = 0, high = 1) {
  finite(value, label)
  if (value < low || value > high) fail(`${label} must be between ${low} and ${high}`)
  return value
}

function closeEnough(actual, expected, label, tolerance = 0.02) {
  finite(actual, label)
  if (Math.abs(actual - expected) > tolerance) fail(`${label} disagrees with rich catalogue: ${actual} vs ${expected}`)
}

function quantile(values, fraction) {
  const sorted = [...values].sort((first, second) => first - second)
  if (sorted.length === 0) return NaN
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function themeKey(value) {
  return String(value ?? '').trim().toLocaleLowerCase('zh-CN')
}

function meaningfulThemes(book) {
  if (!Array.isArray(book?.themes)) return []
  const seen = new Set()
  const result = []
  for (const theme of book.themes) {
    const text = String(theme ?? '').trim()
    const key = themeKey(text)
    if (!text || GENERIC_THEMES.has(text) || GENERIC_THEMES.has(key) || seen.has(key)) continue
    seen.add(key)
    result.push(text)
  }
  return result
}

function knownMetadata(value) {
  const key = String(value ?? '').trim().toLocaleLowerCase('zh-CN')
  return !UNKNOWN_METADATA.has(key)
}

function knownAuthor(value) {
  const key = String(value ?? '').trim().toLocaleLowerCase('zh-CN')
  return !UNKNOWN_AUTHORS.has(key)
}

function metadataEvidence(first, second) {
  const firstThemes = new Set(meaningfulThemes(first).map(themeKey))
  const secondThemes = new Set(meaningfulThemes(second).map(themeKey))
  const unionSize = new Set([...firstThemes, ...secondThemes]).size
  const sharedThemes = meaningfulThemes(first).filter((theme) => secondThemes.has(themeKey(theme)))
  const themeOverlap = unionSize ? sharedThemes.length / unionSize : 0
  const eraKnown = Number.isInteger(first?.year) && Number.isInteger(second?.year)
  const eraGap = eraKnown ? Math.min(Math.abs(first.year - second.year) / 180, 1) : 0
  const firstCountry = String(first?.country ?? '').trim()
  const secondCountry = String(second?.country ?? '').trim()
  const countryKnown = knownMetadata(firstCountry) && knownMetadata(secondCountry)
  const countryGap = countryKnown && firstCountry.toLocaleLowerCase('zh-CN') === secondCountry.toLocaleLowerCase('zh-CN') ? 0 : 1
  const firstAuthor = String(first?.author ?? '').trim()
  const secondAuthor = String(second?.author ?? '').trim()
  const authorKnown = knownAuthor(firstAuthor) && firstAuthor.toLocaleLowerCase('zh-CN') === secondAuthor.toLocaleLowerCase('zh-CN')
  const authorGap = authorKnown ? 0 : 1
  const firstLanguage = String(first?.language ?? '').trim()
  const secondLanguage = String(second?.language ?? '').trim()
  const languageGap = knownMetadata(firstLanguage) && firstLanguage.toLocaleLowerCase('zh-CN') === secondLanguage.toLocaleLowerCase('zh-CN') ? 0 : 1
  const themeGap = 1 - themeOverlap
  const metadataSpan = Math.min(1, 0.35 * eraGap + 0.18 * languageGap + 0.22 * countryGap + 0.15 * authorGap + 0.1 * themeGap)
  const basis = ['多维书目语义相似度']
  if (themeOverlap >= 0.12) basis.push('主题')
  if (authorKnown) basis.push('作者')
  if (eraKnown && eraGap >= 0.2) basis.push('时代')
  if (countryKnown) basis.push('地域')
  return {
    themeOverlap,
    sharedThemes,
    eraGap,
    eraKnown,
    countryGap,
    countryKnown,
    authorGap,
    authorKnown,
    languageGap,
    metadataSpan,
    basis,
  }
}

function spearman(first, second) {
  const rank = (values) => {
    const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index)
    const ranks = Array(values.length)
    for (let start = 0; start < order.length;) {
      let end = start + 1
      while (end < order.length && order[end].value === order[start].value) end += 1
      const average = (start + 1 + end) / 2
      for (let cursor = start; cursor < end; cursor += 1) ranks[order[cursor].index] = average
      start = end
    }
    return ranks
  }
  if (first.length < 2 || second.length < 2) return 0
  const firstRank = rank(first)
  const secondRank = rank(second)
  const firstMean = firstRank.reduce((sum, value) => sum + value, 0) / firstRank.length
  const secondMean = secondRank.reduce((sum, value) => sum + value, 0) / secondRank.length
  let numerator = 0
  let firstVariance = 0
  let secondVariance = 0
  for (let index = 0; index < firstRank.length; index += 1) {
    const firstDelta = firstRank[index] - firstMean
    const secondDelta = secondRank[index] - secondMean
    numerator += firstDelta * secondDelta
    firstVariance += firstDelta ** 2
    secondVariance += secondDelta ** 2
  }
  const denominator = Math.sqrt(firstVariance * secondVariance)
  return denominator > 1e-12 ? numerator / denominator : 0
}

function connectedComponentStats(ids, relations) {
  const adjacency = new Map(ids.map((id) => [id, new Set()]))
  for (const relation of relations) {
    adjacency.get(relation.source)?.add(relation.target)
    adjacency.get(relation.target)?.add(relation.source)
  }
  const visited = new Set()
  let components = 0
  let largest = 0
  for (const id of ids) {
    if (visited.has(id)) continue
    components += 1
    visited.add(id)
    const stack = [id]
    let size = 0
    while (stack.length) {
      const current = stack.pop()
      size += 1
      for (const neighbour of adjacency.get(current) ?? []) {
        if (!visited.has(neighbour)) {
          visited.add(neighbour)
          stack.push(neighbour)
        }
      }
    }
    largest = Math.max(largest, size)
  }
  return { components, largest, ratio: largest / Math.max(1, ids.length) }
}

function estimateDensityBandCount(values) {
  if (values.length < 12) return 0
  const bins = 24
  const histogram = Array(bins).fill(0)
  for (const value of values) histogram[Math.min(bins - 1, Math.max(0, Math.floor(value * bins)))] += 1
  const floor = Math.max(1, Math.ceil(Math.max(...histogram) * 0.08))
  let peaks = 0
  for (let index = 1; index < bins - 1; index += 1) {
    if (histogram[index] >= floor && histogram[index] > histogram[index - 1] && histogram[index] >= histogram[index + 1]) peaks += 1
  }
  return peaks
}

/**
 * Estimate only macro-scale spatial density peaks.  We greedily retain the
 * densest books above the 55th percentile, then suppress candidates closer
 * than 22% of the largest coordinate span.  This intentionally ignores tiny
 * local maxima: the visual requirement is several overlapping nebulae, not a
 * count of every dense shelf inside them.
 */
function estimateSpatialPeakCount(records) {
  if (records.length < 12) return 0
  const spans = [0, 1, 2].map((axis) => {
    const values = records.map((record) => record.position[axis])
    return Math.max(...values) - Math.min(...values)
  })
  const minimumSeparation = Math.max(...spans) * 0.22
  const densityFloor = quantile(records.map((record) => record.spatialDensity), 0.55)
  const selected = []
  const candidates = [...records].sort((left, right) => (
    right.spatialDensity - left.spatialDensity || left.id.localeCompare(right.id)
  ))
  for (const candidate of candidates) {
    if (candidate.spatialDensity < densityFloor) break
    const sufficientlyDistant = selected.every((peak) => (
      Math.sqrt(distanceSquared(candidate.position, peak.position)) >= minimumSeparation
    ))
    if (sufficientlyDistant) selected.push(candidate)
  }
  return selected.length
}

function edgeKey(source, target) {
  return [source, target].sort().join('\u0000')
}

function distanceSquared(first, second) {
  return (first[0] - second[0]) ** 2
    + (first[1] - second[1]) ** 2
    + (first[2] - second[2]) ** 2
}

function exactSpatialNeighbours(records, index, count) {
  const source = records[index]
  return records
    .map((candidate, candidateIndex) => ({
      id: candidate.id,
      index: candidateIndex,
      distance: candidateIndex === index ? Infinity : distanceSquared(source.position, candidate.position),
    }))
    .sort((first, second) => first.distance - second.distance || (first.id < second.id ? -1 : first.id > second.id ? 1 : 0))
    .slice(0, count)
    .map((candidate) => candidate.id)
}

async function readJson(path, label) {
  if (!existsSync(path)) fail(`${label} not found: ${path}`)
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    fail(`invalid JSON in ${path}: ${error instanceof Error ? error.message : error}`)
  }
}

async function main() {
  const paths = parseArgs(process.argv.slice(2))
  const layout = await readJson(paths.layout, 'semantic layout')
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) fail('layout must be a JSON object')
  if (layout.schemaVersion !== 'bookshelf-galaxy/semantic-layout-v1') fail('unexpected semantic layout schema')
  if (layout.model !== MODEL_NAME) fail(`layout model must be ${MODEL_NAME}`)
  if (layout.dimensions !== 3) fail('layout dimensions must be 3')
  if (layout.generatedAt !== 'deterministic') fail('layout generatedAt must be the deterministic marker')
  if (!Array.isArray(layout.books) || layout.books.length < 2) fail('layout must contain at least two books')
  if (!Array.isArray(layout.relations)) fail('layout relations must be an array')

  // Re-read the rich source snapshot so relationship claims are checked
  // against actual themes, years and countries rather than only against
  // values copied into layout.json.
  const sourcePayload = await readJson(paths.input, 'rich catalogue')
  const source = Array.isArray(sourcePayload)
    ? sourcePayload
    : sourcePayload && typeof sourcePayload === 'object' && Array.isArray(sourcePayload.books)
      ? sourcePayload.books
      : null
  if (!source) fail('rich catalogue must be a snapshot object with books or an array')
  const sourceById = new Map()
  for (const [index, book] of source.entries()) {
    if (!book || typeof book !== 'object' || typeof book.id !== 'string' || !book.id) fail(`rich catalogue book ${index} has an invalid id`)
    if (sourceById.has(book.id)) fail(`duplicate rich catalogue book id: ${book.id}`)
    sourceById.set(book.id, book)
  }

  const records = layout.books
  const ids = new Set()
  const byId = new Map()
  const shapeCounts = new Map()
  for (const [index, record] of records.entries()) {
    if (!record || typeof record !== 'object') fail(`book ${index} must be an object`)
    if (typeof record.id !== 'string' || !record.id) fail(`book ${index} has an invalid id`)
    if (ids.has(record.id)) fail(`duplicate layout book id: ${record.id}`)
    ids.add(record.id)
    byId.set(record.id, record)
    if (!Array.isArray(record.position) || record.position.length !== 3) fail(`book ${record.id} position must have 3 coordinates`)
    record.position.forEach((value, axis) => {
      finite(value, `book ${record.id} position[${axis}]`)
      if (Math.abs(value) > MAX_COORDINATE + 1e-6) fail(`book ${record.id} position exceeds ±${MAX_COORDINATE}`)
    })
    bounded(record.localDensity, `book ${record.id} localDensity`)
    bounded(record.semanticDensity, `book ${record.id} semanticDensity`)
    bounded(record.spatialDensity, `book ${record.id} spatialDensity`)
    bounded(record.outlierScore, `book ${record.id} outlierScore`)
    finite(record.magnitude, `book ${record.id} magnitude`)
    if (record.magnitude <= 0) fail(`book ${record.id} magnitude must be positive`)
    bounded(record.halo, `book ${record.id} halo`, 0, 2)
    if (!SHAPES.has(record.shape)) fail(`book ${record.id} shape is missing or unknown`)
    shapeCounts.set(record.shape, (shapeCounts.get(record.shape) || 0) + 1)
    bounded(record.temperature, `book ${record.id} temperature`)
    if (!Array.isArray(record.neighbors)) fail(`book ${record.id} neighbors must be an array`)
    if (!Array.isArray(record.spatialNeighbors)) fail(`book ${record.id} spatialNeighbors must be an array`)
    if (!record.relationCoverage || typeof record.relationCoverage !== 'object') fail(`book ${record.id} relation coverage is missing`)
    for (const field of ['candidate', 'eligible', 'low', 'middle', 'high', 'selected']) {
      const count = record.relationCoverage[field]
      if (!Number.isInteger(count) || count < 0) fail(`book ${record.id} relation coverage ${field} must be a non-negative integer`)
    }
    if (record.relationCoverage.eligible > record.relationCoverage.candidate) fail(`book ${record.id} relation coverage exceeds candidate pool`)
    if (record.relationCoverage.low + record.relationCoverage.middle + record.relationCoverage.high !== record.relationCoverage.selected) fail(`book ${record.id} relation coverage bands do not add up to selected count`)
    if (record.relationCoverage.low > record.relationCoverage.eligible || record.relationCoverage.middle > record.relationCoverage.eligible || record.relationCoverage.high > record.relationCoverage.eligible) fail(`book ${record.id} relation coverage band exceeds eligible candidates`)
    if (record.relationCoverage.selected < Math.min(3, record.relationCoverage.eligible)) fail(`book ${record.id} relation coverage selected count is inconsistent`)
  }
  if (sourceById.size !== records.length || [...ids].some((id) => !sourceById.has(id))) fail('layout book ids do not match rich catalogue')
  if (records.length >= 100) {
    if (shapeCounts.size < 4) fail(`star morphology has only ${shapeCounts.size} families`)
    const crossLike = (shapeCounts.get('diamond') || 0) + (shapeCounts.get('cross') || 0) + (shapeCounts.get('flare') || 0)
    if (crossLike / records.length > 0.22) fail(`cross-like star share ${(crossLike / records.length).toFixed(3)} exceeds 0.22`)
  }

  const requestedK = layout.neighborCount
  finite(requestedK, 'neighborCount')
  if (!Number.isInteger(requestedK) || requestedK < 1 || requestedK > MAX_K) fail('neighborCount must be an integer between 1 and 18')
  const expectedK = Math.min(requestedK, records.length - 1)
  if (records.length >= MIN_K + 1 && (requestedK < MIN_K || requestedK > MAX_K)) fail('catalogues of this size require 12-18 neighbours per book')
  const candidateK = layout.candidateNeighborCount
  finite(candidateK, 'candidateNeighborCount')
  if (!Number.isInteger(candidateK) || candidateK < expectedK || candidateK > records.length - 1) fail('candidateNeighborCount must cover the layout neighbours and catalogue size')
  const expectedCandidateK = Math.min(EXPECTED_CANDIDATE_K, records.length - 1)
  if (candidateK !== expectedCandidateK) fail(`candidateNeighborCount must be ${expectedCandidateK} (96, clamped to catalogue size)`)
  for (const record of records) {
    if (record.relationCoverage.candidate !== candidateK) fail(`book ${record.id} relation coverage candidate count is inconsistent`)
  }

  const overlaps = []
  const densities = []
  const navigableEdges = new Set()
  for (const record of records) {
    if (record.neighbors.length !== expectedK) fail(`book ${record.id} must have exactly ${expectedK} semantic neighbours`)
    if (record.spatialNeighbors.length !== expectedK) fail(`book ${record.id} must have exactly ${expectedK} spatial neighbours`)
    const semanticIds = new Set()
    for (const neighbour of record.neighbors) {
      if (!neighbour || typeof neighbour !== 'object') fail(`book ${record.id} contains an invalid neighbour`)
      if (typeof neighbour.id !== 'string' || !ids.has(neighbour.id)) fail(`book ${record.id} has a dangling semantic neighbour`)
      if (neighbour.id === record.id || semanticIds.has(neighbour.id)) fail(`book ${record.id} has a duplicate/self semantic neighbour`)
      semanticIds.add(neighbour.id)
      bounded(neighbour.similarity, `semantic similarity ${record.id}/${neighbour.id}`)
      bounded(neighbour.surprise, `semantic surprise ${record.id}/${neighbour.id}`)
      if (typeof neighbour.navigable !== 'boolean') fail(`book ${record.id} neighbour navigable flag is missing`)
      if (neighbour.navigable) {
        if (!Array.isArray(neighbour.basis) || neighbour.basis.length < 2) fail(`navigable neighbour ${record.id}/${neighbour.id} needs semantic and metadata basis`)
        if (neighbour.basis[0] !== '多维书目语义相似度' || !neighbour.basis.slice(1).some((item) => BASIS.has(item))) fail(`navigable neighbour ${record.id}/${neighbour.id} has insufficient basis`)
        if (typeof neighbour.relationKey !== 'string' || !neighbour.relationKey.includes('\u0000')) fail(`navigable neighbour ${record.id}/${neighbour.id} lacks a relation mapping`)
        if (neighbour.relationKey !== edgeKey(record.id, neighbour.id)) fail(`navigable neighbour ${record.id}/${neighbour.id} relation mapping is inconsistent`)
        navigableEdges.add(edgeKey(record.id, neighbour.id))
      }
    }
    const spatialIds = new Set()
    for (const neighbourId of record.spatialNeighbors) {
      if (typeof neighbourId !== 'string' || !ids.has(neighbourId)) fail(`book ${record.id} has a dangling spatial neighbour`)
      if (neighbourId === record.id || spatialIds.has(neighbourId)) fail(`book ${record.id} has a duplicate/self spatial neighbour`)
      spatialIds.add(neighbourId)
    }
    const overlap = [...semanticIds].filter((id) => spatialIds.has(id)).length / Math.max(1, semanticIds.size)
    bounded(record.spatialSemanticOverlap, `book ${record.id} spatialSemanticOverlap`)
    if (Math.abs(record.spatialSemanticOverlap - overlap) > 0.015) fail(`book ${record.id} spatialSemanticOverlap is inconsistent`)
    overlaps.push(overlap)
    densities.push(record.localDensity)
  }

  const duplicateCheck = new Set()
  const surpriseValues = []
  const surpriseByBook = new Map([...ids].map((id) => [id, []]))
  for (const [index, relation] of layout.relations.entries()) {
    if (!relation || typeof relation !== 'object') fail(`relation ${index} must be an object`)
    if (typeof relation.source !== 'string' || typeof relation.target !== 'string') fail(`relation ${index} endpoints are invalid`)
    if (!ids.has(relation.source) || !ids.has(relation.target)) fail(`relation ${index} has a dangling endpoint`)
    if (relation.source === relation.target) fail(`relation ${index} is a self edge`)
    const key = edgeKey(relation.source, relation.target)
    if (duplicateCheck.has(key)) fail(`duplicate undirected relation: ${key}`)
    duplicateCheck.add(key)
    bounded(relation.similarity, `relation ${key} similarity`)
    bounded(relation.surprise, `relation ${key} surprise`)
    surpriseValues.push(relation.surprise)
    if (!relation.surpriseByBook || typeof relation.surpriseByBook !== 'object' || Array.isArray(relation.surpriseByBook)) fail(`relation ${key} surpriseByBook is missing`)
    if (!relation.bandByBook || typeof relation.bandByBook !== 'object' || Array.isArray(relation.bandByBook)) fail(`relation ${key} bandByBook is missing`)
    for (const bookId of [relation.source, relation.target]) {
      if (!Object.hasOwn(relation.surpriseByBook, bookId)) fail(`relation ${key} surpriseByBook is missing endpoint ${bookId}`)
      if (!Object.hasOwn(relation.bandByBook, bookId)) fail(`relation ${key} bandByBook is missing endpoint ${bookId}`)
    }
    for (const [bookId, localSurprise] of Object.entries(relation.surpriseByBook)) {
      if (bookId !== relation.source && bookId !== relation.target) fail(`relation ${key} surpriseByBook contains a non-endpoint`)
      bounded(localSurprise, `relation ${key} surpriseByBook/${bookId}`)
      const band = relation.bandByBook[bookId]
      if (!['low', 'middle', 'high'].includes(band)) fail(`relation ${key} bandByBook/${bookId} is invalid`)
      if (band === 'low' && !(localSurprise < 0.52)) fail(`relation ${key} low endpoint surprise crosses near threshold`)
      if (band === 'middle' && !(localSurprise >= 0.52 && localSurprise < 0.8)) fail(`relation ${key} middle endpoint surprise crosses bridge threshold`)
      if (band === 'high' && !(localSurprise >= 0.8)) fail(`relation ${key} high endpoint surprise misses far threshold`)
      surpriseByBook.get(bookId).push(localSurprise)
    }
    bounded(relation.confidence, `relation ${key} confidence`)
    finite(relation.weight, `relation ${key} weight`)
    if (!Array.isArray(relation.basis) || relation.basis.length < 2) fail(`relation ${key} needs semantic and metadata basis`)
    if (relation.basis[0] !== '多维书目语义相似度') fail(`relation ${key} must lead with multidimensional bibliographic semantic basis`)
    if (!relation.basis.some((item) => item === '主题' || item === '时代' || item === '地域')) fail(`relation ${key} lacks a contextual theme, era, or region basis`)
    for (const item of relation.basis) {
      if (!BASIS.has(item)) fail(`relation ${key} has unknown basis: ${item}`)
    }
    if (new Set(relation.basis).size !== relation.basis.length) fail(`relation ${key} basis contains duplicates`)
    const firstBook = sourceById.get(relation.source)
    const secondBook = sourceById.get(relation.target)
    const expectedEvidence = metadataEvidence(firstBook, secondBook)
    if (relation.basis.length !== expectedEvidence.basis.length || relation.basis.some((item, basisIndex) => item !== expectedEvidence.basis[basisIndex])) fail(`relation ${key} basis disagrees with rich catalogue metadata`)
    if (!relation.evidence || typeof relation.evidence !== 'object') fail(`relation ${key} evidence is missing`)
    closeEnough(relation.evidence.themeOverlap, expectedEvidence.themeOverlap, `relation ${key} themeOverlap`)
    closeEnough(relation.evidence.eraGap, expectedEvidence.eraGap, `relation ${key} eraGap`)
    closeEnough(relation.evidence.countryGap, expectedEvidence.countryGap, `relation ${key} countryGap`)
    closeEnough(relation.evidence.authorGap, expectedEvidence.authorGap, `relation ${key} authorGap`)
    closeEnough(relation.evidence.languageGap, expectedEvidence.languageGap, `relation ${key} languageGap`)
    closeEnough(relation.evidence.metadataSpan, expectedEvidence.metadataSpan, `relation ${key} metadataSpan`)
    bounded(relation.evidence.rawSurprise, `relation ${key} rawSurprise`, 0.05, 0.98)
    bounded(relation.evidence.surprisePercentile, `relation ${key} surprisePercentile`)
    if (relation.evidence.eraKnown !== expectedEvidence.eraKnown) fail(`relation ${key} eraKnown disagrees with rich catalogue`)
    if (relation.evidence.countryKnown !== expectedEvidence.countryKnown) fail(`relation ${key} countryKnown disagrees with rich catalogue`)
    if (relation.evidence.authorKnown !== expectedEvidence.authorKnown) fail(`relation ${key} authorKnown disagrees with rich catalogue`)
    const actualShared = Array.isArray(relation.evidence.sharedThemes) ? relation.evidence.sharedThemes.map(String) : null
    const expectedSharedKeys = new Set(expectedEvidence.sharedThemes.map(themeKey))
    const actualSharedKeys = new Set((actualShared || []).map(themeKey))
    if (!actualShared
      || actualShared.length !== actualSharedKeys.size
      || actualSharedKeys.size !== expectedSharedKeys.size
      || [...actualSharedKeys].some((item) => !expectedSharedKeys.has(item))) fail(`relation ${key} sharedThemes disagrees with rich catalogue`)
    if (relation.basis.includes('主题')) {
      const sharedThemes = relation.evidence?.sharedThemes
      if (!Array.isArray(sharedThemes) || sharedThemes.length === 0) fail(`relation ${key} theme basis lacks shared theme evidence`)
      if (sharedThemes.some((theme) => GENERIC_THEMES.has(String(theme).trim()) || GENERIC_THEMES.has(themeKey(theme)))) fail(`relation ${key} uses a generic fallback theme as evidence`)
    }
    if (relation.basis.includes('时代')) {
      if (relation.evidence?.eraKnown !== true || typeof relation.evidence?.eraGap !== 'number' || relation.evidence.eraGap < 0.20) fail(`relation ${key} era basis lacks an explicit historical span`)
    }
    if (relation.basis.includes('地域') && relation.evidence?.countryKnown !== true) fail(`relation ${key} geographic basis lacks two known countries`)
    if (relation.basis.includes('作者') && relation.evidence?.authorKnown !== true) fail(`relation ${key} author basis lacks a shared known author`)
    if (typeof relation.sentence !== 'string' || relation.sentence.length < 35 || relation.sentence.length > 100) fail(`relation ${key} needs a 35-100 character reader-facing sentence`)
    if (relation.sentence.includes('并非同一本书')) fail(`relation ${key} contains the obsolete mechanical sentence template`)
    if (relation.sentence.includes('中文摘要中反复出现')) fail(`relation ${key} contains the obsolete theme-in-summary sentence template`)
    const forbiddenTerm = FORBIDDEN_FRONTEND_SENTENCE_TERMS.find((term) => relation.sentence.includes(term))
    if (forbiddenTerm) fail(`relation ${key} frontend sentence contains technical term: ${forbiddenTerm}`)
    if (!relation.sentence.includes(String(firstBook.title)) || !relation.sentence.includes(String(secondBook.title))) fail(`relation ${key} sentence does not name both concrete books`)
    if (!Array.isArray(relation.bands) || relation.bands.length === 0 || relation.bands.some((band) => !['low', 'middle', 'high'].includes(band))) fail(`relation ${key} surprise bands are invalid`)
  }
  for (const key of navigableEdges) if (!duplicateCheck.has(key)) fail(`navigable semantic relation is missing: ${key}`)

  const relationDegrees = new Map([...ids].map((id) => [id, 0]))
  for (const relation of layout.relations) {
    relationDegrees.set(relation.source, relationDegrees.get(relation.source) + 1)
    relationDegrees.set(relation.target, relationDegrees.get(relation.target) + 1)
  }
  const degreeValues = [...relationDegrees.values()]
  const relationMinDegree = Math.min(...degreeValues)
  if (records.length >= 4 && relationMinDegree < MIN_RELATION_DEGREE) fail(`minimum honest relation degree is ${relationMinDegree}, expected at least ${MIN_RELATION_DEGREE}`)
  if (records.length >= 20) {
    const surpriseMin = Math.min(...surpriseValues)
    const surpriseMax = Math.max(...surpriseValues)
    const nearCount = surpriseValues.filter((value) => value < 0.52).length
    const bridgeCount = surpriseValues.filter((value) => value >= 0.52 && value < 0.8).length
    const farCount = surpriseValues.filter((value) => value >= 0.8).length
    if (surpriseMin > 0.2 || surpriseMax < 0.9) fail(`calibrated surprise range is ${surpriseMin.toFixed(4)}..${surpriseMax.toFixed(4)}, expected near and distant tails`)
    if (!nearCount || !bridgeCount || !farCount) fail(`calibrated surprise bands are empty: near=${nearCount}, bridge=${bridgeCount}, far=${farCount}`)
    for (const [bookId, values] of surpriseByBook) {
      if (!values.some((value) => value < 0.52)) fail(`book ${bookId} lacks a viewpoint-calibrated near detour`)
      if (!values.some((value) => value >= 0.52 && value < 0.8)) fail(`book ${bookId} lacks a viewpoint-calibrated bridge detour`)
      if (!values.some((value) => value >= 0.8)) fail(`book ${bookId} lacks a viewpoint-calibrated far detour`)
    }
  }
  const recommendedCoverage = degreeValues.filter((degree) => degree >= RECOMMENDED_RELATION_DEGREE).length / records.length

  const components = connectedComponentStats([...ids], layout.relations)
  const minimumComponentRatio = records.length >= 20 ? 0.97 : 0.8
  if (components.ratio < minimumComponentRatio) fail(`largest relation component is only ${(components.ratio * 100).toFixed(2)}%`)

  const semanticDensities = records.map((record) => record.semanticDensity)
  const spatialDensities = records.map((record) => record.spatialDensity)
  const densityP10 = quantile(semanticDensities, 0.1)
  const densityP90 = quantile(semanticDensities, 0.9)
  const spatialDensityP10 = quantile(spatialDensities, 0.1)
  const spatialDensityP90 = quantile(spatialDensities, 0.9)
  if (!(densityP90 - densityP10 >= 0.08)) fail(`semantic density has insufficient contrast: P10=${densityP10.toFixed(4)} P90=${densityP90.toFixed(4)}`)
  if (!(spatialDensityP90 - spatialDensityP10 >= 0.08)) fail(`spatial density has insufficient contrast: P10=${spatialDensityP10.toFixed(4)} P90=${spatialDensityP90.toFixed(4)}`)
  const densityCorrelation = spearman(semanticDensities, spatialDensities)
  const minimumDensityCorrelation = records.length >= 20 ? 0.5 : 0.25
  if (densityCorrelation < minimumDensityCorrelation) fail(`semantic/spatial density Spearman correlation is ${densityCorrelation.toFixed(4)}`)

  const outliers = records.map((record) => record.outlierScore)
  const outlierP10 = quantile(outliers, 0.1)
  const outlierP90 = quantile(outliers, 0.9)
  if (outlierP90 < 0.6 || outlierP90 - outlierP10 < 0.08) fail(`outlier score lacks a visible high-sparsity tail: P10=${outlierP10.toFixed(4)} P90=${outlierP90.toFixed(4)}`)
  const recallMean = overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length
  const recallP10 = quantile(overlaps, 0.1)
  // Three dimensions cannot preserve every exact neighbour from the original
  // 384-dimensional embedding. Require at least four of the sixteen nearest
  // semantic books on average (25%) while separately enforcing strong density
  // rank preservation; this guards both local meaning and the macro nebula.
  const minimumMeanRecall = records.length >= 20 ? 0.25 : 0.2
  if (recallMean < minimumMeanRecall) fail(`spatial/semantic kNN retention is too low: mean=${recallMean.toFixed(4)}`)

  // Independent spatial sanity check on a bounded deterministic sample. This
  // catches stale/misaligned spatial neighbour lists without O(n^2) work.
  const sampleCount = Math.min(SAMPLE_SIZE, records.length)
  let sampleRecall = 0
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const index = Math.floor((sample * records.length) / sampleCount)
    const expected = new Set(exactSpatialNeighbours(records, index, expectedK))
    const actual = new Set(records[index].spatialNeighbors)
    sampleRecall += [...expected].filter((id) => actual.has(id)).length / Math.max(1, expected.size)
  }
  sampleRecall /= sampleCount
  if (sampleRecall < 0.65) fail(`spatial neighbour lists disagree with coordinate sample: mean=${sampleRecall.toFixed(4)}`)

  const coverageAllBands = records.filter((record) => record.relationCoverage.low > 0 && record.relationCoverage.middle > 0 && record.relationCoverage.high > 0).length
  const densityBandCount = estimateDensityBandCount(semanticDensities)
  const spatialPeakCount = estimateSpatialPeakCount(records)
  const warnings = []
  if (records.length < 20 && requestedK < MIN_K) warnings.push(`small catalogue uses ${requestedK} neighbours; final rich map should use 12-18`)
  if (recommendedCoverage < 0.75) warnings.push(`only ${(recommendedCoverage * 100).toFixed(1)}% of books reach the recommended degree ${RECOMMENDED_RELATION_DEGREE}`)
  if (coverageAllBands < records.length) warnings.push(`${records.length - coverageAllBands} books lack one selected surprise band; coverage is reported rather than fabricated`)
  if (spatialPeakCount < 6 || spatialPeakCount > 12) warnings.push(`estimated spatial density peaks=${spatialPeakCount}; expected visual range is 6-12`)

  console.log(JSON.stringify({
    ok: true,
    inputPresent: true,
    books: records.length,
    relations: layout.relations.length,
    neighborCount: expectedK,
    candidateNeighborCount: candidateK,
    relationMinDegree,
    recommendedDegreeCoverage: Number(recommendedCoverage.toFixed(6)),
    largestComponentRatio: Number(components.ratio.toFixed(6)),
    densityP10: Number(densityP10.toFixed(6)),
    densityP90: Number(densityP90.toFixed(6)),
    spatialDensityP10: Number(spatialDensityP10.toFixed(6)),
    spatialDensityP90: Number(spatialDensityP90.toFixed(6)),
    semanticSpatialDensitySpearman: Number(densityCorrelation.toFixed(6)),
    outlierP10: Number(outlierP10.toFixed(6)),
    outlierP90: Number(outlierP90.toFixed(6)),
    spatialSemanticRecallMean: Number(recallMean.toFixed(6)),
    spatialSemanticRecallP10: Number(recallP10.toFixed(6)),
    sampledSpatialRecall: Number(sampleRecall.toFixed(6)),
    starMorphologies: Object.fromEntries([...shapeCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    relationCoverageAllBands: coverageAllBands,
    relationCoverageAllBandsFraction: Number((coverageAllBands / records.length).toFixed(6)),
    surpriseMin: Number(Math.min(...surpriseValues).toFixed(6)),
    surpriseMax: Number(Math.max(...surpriseValues).toFixed(6)),
    surpriseBands: {
      near: surpriseValues.filter((value) => value < 0.52).length,
      bridge: surpriseValues.filter((value) => value >= 0.52 && value < 0.8).length,
      far: surpriseValues.filter((value) => value >= 0.8).length,
    },
    estimatedSemanticDensityBands: densityBandCount,
    estimatedSpatialDensityPeaks: spatialPeakCount,
    warnings,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
