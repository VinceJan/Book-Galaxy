import type { Book, BookRelation, BookShape } from '../types'

export type Point3 = readonly [number, number, number]

export interface BookVisualAttributes {
  size: number
  seed: number
  magnitude: number
  density: number
  outlier: number
  halo: number
  shape: number
  temperature: number
}

const TAU = Math.PI * 2

export function hashString(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function seededRandom(seed: number): () => number {
  let state = seed || 1
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let result = Math.imul(state ^ (state >>> 15), 1 | state)
    result = (result + Math.imul(result ^ (result >>> 7), 61 | result)) ^ result
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296
  }
}

export function gaussianRandom(random: () => number): number {
  const first = Math.max(random(), Number.EPSILON)
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(TAU * random())
}

function normalizedMetric(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  if ((value as number) <= 0) return 0
  if ((value as number) <= 1) return value as number
  return (value as number) / ((value as number) + 1)
}

function metadataRandom(book: Book, salt: string): number {
  return seededRandom(hashString(`${book.id}:visual:${salt}`))()
}

function shapeFromValue(value: BookShape | number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value) && value >= 0 && value <= 3) {
      return [0.18, 0.63, 0.83, 0.96][value]
    }
    return Math.max(0, Math.min(1, value))
  }
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    if (normalized === 'soft' || normalized === 'core' || normalized === 'point') return 0.18
    if (normalized === 'cross' || normalized === 'spike' || normalized === 'cross-star') return 0.63
    if (normalized === 'double' || normalized === 'double-halo' || normalized === 'halo') return 0.83
    if (normalized === 'ring' || normalized === 'eccentric' || normalized === 'orbit') return 0.96
  }
  return fallback
}

function clusterSignature(book: Book): string {
  if (!book.clusterWeights) return ''
  if (Array.isArray(book.clusterWeights)) {
    return book.clusterWeights
      .slice(0, 5)
      .map((weight) => (Number.isFinite(weight) ? Number(weight).toFixed(3) : '0'))
      .join(',')
  }
  return Object.entries(book.clusterWeights)
    .filter(([, weight]) => Number.isFinite(weight))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([key, weight]) => `${key}:${Number(weight).toFixed(3)}`)
    .join('|')
}

export function hasValidPosition(book: Pick<Book, 'position'>): book is Pick<Book, 'position'> & { position: Point3 } {
  return Boolean(book.position && book.position.length === 3 && book.position.every((value) => Number.isFinite(value)))
}

export function positionForBook(book: Book, index: number, total: number): Point3 {
  if (hasValidPosition(book)) return [book.position[0], book.position[1], book.position[2]]

  const random = seededRandom(hashString(`${book.id}:${index}`))
  const theme = book.themes.slice(0, 4).join('|') || book.language || '未分类'
  const cluster = hashString(`${theme}|${book.language ?? ''}|${clusterSignature(book)}`) % 17
  const clusterAngle = (cluster / 17) * TAU + (cluster % 2 ? 0.18 : -0.12)
  const density = normalizedMetric(book.localDensity, 0.28 + metadataRandom(book, 'density') * 0.62)
  const outlier = normalizedMetric(book.outlierScore, metadataRandom(book, 'outlier') * 0.22)
  const clusterRadius = 30 + (cluster % 6) * 16 + outlier * 54
  const populationRadius = 20 + Math.sqrt(Math.max(total, 1)) * 0.24
  const spread = Math.min(42, populationRadius * (0.34 + (1 - density) * 0.5) + outlier * 14)

  const centerX = Math.cos(clusterAngle) * clusterRadius
  const centerZ = Math.sin(clusterAngle) * clusterRadius * 0.76
  const x = centerX + gaussianRandom(random) * spread
  const z = centerZ + gaussianRandom(random) * spread * 0.76
  const arch = Math.sin((x + z) * 0.026 + cluster) * 7.5
  const y = gaussianRandom(random) * (5.5 + spread * 0.32) + arch + (outlier - 0.2) * 15

  return [x, y, z]
}

/**
 * Map optional semantic signals to stable shader attributes. The fallback
 * variation is intentional: an old catalog still reads as a living field,
 * while precomputed values remain authoritative when present.
 */
export function visualAttributesForBook(book: Book, index = 0): BookVisualAttributes {
  const seed = metadataRandom(book, `seed:${index}`)
  const magnitude = normalizedMetric(book.magnitude, 0.2 + metadataRandom(book, 'magnitude') * 0.72)
  const density = normalizedMetric(book.localDensity, 0.18 + metadataRandom(book, 'density') * 0.76)
  const outlier = normalizedMetric(book.outlierScore, metadataRandom(book, 'outlier') * 0.24)
  const halo = normalizedMetric(book.halo, 0.16 + magnitude * 0.48 + density * 0.24 + metadataRandom(book, 'halo') * 0.14)
  const shape = shapeFromValue(
    book.shape,
    seed < 0.55 ? 0.18 : seed < 0.73 ? 0.63 : seed < 0.93 ? 0.83 : 0.96,
  )
  const temperature = normalizedMetric(book.temperature, metadataRandom(book, 'temperature'))
  const rarity = 0.12 + metadataRandom(book, 'size') * 0.88
  const sizeSignal = Math.max(
    0,
    Math.min(1, magnitude * 0.43 + density * 0.27 + rarity * 0.2 + (1 - outlier) * 0.1),
  )
  const contrastedSize = Math.max(0, Math.min(1, (sizeSignal - 0.36) / 0.5))

  return {
    size: 1.24 + contrastedSize * 5.3,
    seed,
    magnitude,
    density,
    outlier,
    halo,
    shape,
    temperature,
  }
}

export function scoreRelation(relation: BookRelation, desiredSurprise = 0.72): number {
  const distancePenalty = Math.abs(relation.surprise - desiredSurprise)
  return relation.confidence * 0.58 + relation.surprise * 0.12 - distancePenalty * 1.1
}

export function chooseRelations(
  relations: BookRelation[],
  bookId: string,
  visited: ReadonlySet<string>,
  limit = 3,
): BookRelation[] {
  const directions = [0.32, 0.67, 0.86]
  const candidates = relations.filter((relation) => {
    if (relation.source !== bookId && relation.target !== bookId) return false
    const otherId = relation.source === bookId ? relation.target : relation.source
    return !visited.has(otherId)
  })

  const selected: BookRelation[] = []
  const selectedTargets = new Set<string>()
  for (const desired of directions) {
    const next = candidates
      .filter((candidate) => !selected.includes(candidate) && !selectedTargets.has(otherBookId(candidate, bookId)))
      .sort((left, right) => scoreRelation(right, desired) - scoreRelation(left, desired))[0]
    if (next) {
      selected.push(next)
      selectedTargets.add(otherBookId(next, bookId))
    }
    if (selected.length >= limit) break
  }
  return selected
}

export function otherBookId(relation: Pick<BookRelation, 'source' | 'target'>, bookId: string): string {
  return relation.source === bookId ? relation.target : relation.source
}
