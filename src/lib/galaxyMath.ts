import type { Book, BookRelation } from '../types'

export type Point3 = readonly [number, number, number]

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

function gaussian(random: () => number): number {
  const first = Math.max(random(), Number.EPSILON)
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(TAU * random())
}

export function positionForBook(book: Book, index: number, total: number): Point3 {
  const random = seededRandom(hashString(`${book.id}:${index}`))
  const theme = book.themes[0] ?? book.language ?? '未分类'
  const cluster = hashString(theme) % 13
  const clusterAngle = (cluster / 13) * TAU + (cluster % 2 ? 0.18 : -0.12)
  const clusterRadius = 38 + (cluster % 5) * 21
  const populationRadius = 24 + Math.sqrt(Math.max(total, 1)) * 0.22
  const spread = Math.min(38, populationRadius)

  const centerX = Math.cos(clusterAngle) * clusterRadius
  const centerZ = Math.sin(clusterAngle) * clusterRadius * 0.76
  const x = centerX + gaussian(random) * spread
  const z = centerZ + gaussian(random) * spread * 0.76
  const arch = Math.sin((x + z) * 0.026 + cluster) * 7.5
  const y = gaussian(random) * 13 + arch

  return [x, y, z]
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
  for (const desired of directions) {
    const next = candidates
      .filter((candidate) => !selected.includes(candidate))
      .sort((left, right) => scoreRelation(right, desired) - scoreRelation(left, desired))[0]
    if (next) selected.push(next)
    if (selected.length >= limit) break
  }
  return selected
}

export function otherBookId(relation: Pick<BookRelation, 'source' | 'target'>, bookId: string): string {
  return relation.source === bookId ? relation.target : relation.source
}
