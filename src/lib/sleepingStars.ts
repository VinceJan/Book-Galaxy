import type { Book, BookRelation } from '../types'

/**
 * "Sleeping stars" are real books that receive little attention: low
 * popularity, few hand-written reading threads, and a quiet position on the
 * edge of their cloud.  Waking one is the opposite of a recommendation feed.
 */
export interface SleepingStar {
  book: Book
  sleepiness: number
}

const MIN_SUMMARY_CHINESE = 120
const chineseCount = (value = '') => [...value.matchAll(/[\u3400-\u9fff]/gu)].length

export function rankSleepingStars(books: readonly Book[], curatedRelations: readonly BookRelation[]): SleepingStar[] {
  const threadDegree = new Map<string, number>()
  curatedRelations.forEach((relation) => {
    threadDegree.set(relation.source, (threadDegree.get(relation.source) ?? 0) + 1)
    threadDegree.set(relation.target, (threadDegree.get(relation.target) ?? 0) + 1)
  })
  const maxDegree = Math.max(1, ...threadDegree.values())
  return books
    .filter((book) => chineseCount(book.summary) >= MIN_SUMMARY_CHINESE)
    .map((book) => {
      const popularity = Number.isFinite(book.popularity) ? Math.min(1, Math.max(0, book.popularity as number)) : 0.5
      const linked = (threadDegree.get(book.id) ?? 0) / maxDegree
      const edge = Number.isFinite(book.outlierScore) ? Math.min(1, Math.max(0, book.outlierScore as number)) : 0
      const sparse = Number.isFinite(book.localDensity) ? 1 - Math.min(1, Math.max(0, book.localDensity as number)) : 0.5
      const sleepiness = (1 - popularity) * 0.45 + (1 - linked) * 0.3 + edge * 0.15 + sparse * 0.1
      return { book, sleepiness }
    })
    .sort((left, right) => right.sleepiness - left.sleepiness || left.book.id.localeCompare(right.book.id))
}

/** Pick uniformly among the sleepiest slice so every wake feels like a find. */
export function pickSleepingStar(
  books: readonly Book[],
  curatedRelations: readonly BookRelation[],
  random: () => number = Math.random,
  options: { pool?: number; exclude?: ReadonlySet<string> } = {},
): Book | undefined {
  const pool = rankSleepingStars(books, curatedRelations)
    .filter(({ book }) => !options.exclude?.has(book.id))
    .slice(0, options.pool ?? 160)
  if (pool.length === 0) return undefined
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))].book
}

/** Books in the sleepiest third get a quiet marker in the librarian's note. */
export function isSleepingStar(book: Book, ranked: readonly SleepingStar[]): boolean {
  const index = ranked.findIndex((star) => star.book.id === book.id)
  return index >= 0 && index < Math.ceil(ranked.length / 3)
}
