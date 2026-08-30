import type { Book, BookRelation, RelationKind } from '../types'
import { curatedBooks, type CuratedBook } from './curatedBooks'
import { curatedRelations, type CuratedRelation } from './curatedRelations'

/**
 * The small, hand-written constellation is authored with stable slugs.  The
 * public catalog, however, is keyed by Wikidata Q-ids.  Keeping this adapter
 * independent of the catalog JSON makes the mapping deterministic and easy
 * to extend with future `curatedThreads/*.ts` batches.
 */
export type CuratedCatalogBook = Omit<Pick<Book, 'id' | 'title' | 'originalTitle' | 'foreignTitle' | 'aliases'>, 'aliases'> & {
  aliases?: readonly string[]
}

export type CuratedSlugBook = Pick<CuratedBook, 'id' | 'title' | 'originalTitle'> & {
  aliases?: readonly string[]
  foreignTitle?: string
}

/** A future curated-thread module can export this shape without an `id`. */
export interface CuratedThread {
  id?: string
  source: string
  target: string
  kind: RelationKind
  sentence: string
  basis: readonly string[]
  /** Optional for prose-first shards; the adapter supplies restrained defaults. */
  surprise?: number
  confidence?: number
}

export interface CuratedRelationBuildStats {
  /** Input records whose two endpoints resolved to real catalog ids. */
  mapped: number
  /** Input records dropped for a missing endpoint, blank endpoint, or self-loop. */
  filtered: number
  /** Resolved records skipped because their undirected pair was already seen. */
  duplicates: number
  input: number
  relationCount: number
}

export interface CuratedRelationBuildResult {
  relations: BookRelation[]
  stats: CuratedRelationBuildStats
}

/**
 * NFKC plus punctuation/spacing removal gives exact matching across Chinese
 * and translated title variants (for example, full-width and ASCII colons).
 * Case is folded for Latin/Cyrillic/Greek titles; no fuzzy or substring match
 * is intentionally performed here.
 */
export function normalizeCuratedTitle(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\p{P}\p{S}\s]+/gu, '')
}

type TitleField = 'title' | 'alias' | 'originalTitle' | 'foreignTitle'

interface IndexedTitle {
  id: string
  field: TitleField
}

function titleValues(book: CuratedCatalogBook | CuratedSlugBook): Array<{ value: string; field: TitleField }> {
  const values: Array<{ value: string; field: TitleField }> = []
  if (typeof book.title === 'string') values.push({ value: book.title, field: 'title' })
  if (typeof book.originalTitle === 'string') values.push({ value: book.originalTitle, field: 'originalTitle' })
  if (typeof book.foreignTitle === 'string') values.push({ value: book.foreignTitle, field: 'foreignTitle' })
  for (const alias of book.aliases ?? []) {
    if (typeof alias === 'string') values.push({ value: alias, field: 'alias' })
  }
  return values
}

function indexCatalogTitles(catalogBooks: readonly CuratedCatalogBook[]): Map<string, IndexedTitle[]> {
  const index = new Map<string, IndexedTitle[]>()
  for (const book of catalogBooks) {
    if (!book.id.trim()) continue
    for (const { value, field } of titleValues(book)) {
      const key = normalizeCuratedTitle(value)
      if (!key) continue
      const entries = index.get(key) ?? []
      if (!entries.some((entry) => entry.id === book.id && entry.field === field)) {
        entries.push({ id: book.id, field })
      }
      index.set(key, entries)
    }
  }
  return index
}

/**
 * Map every unambiguous curated slug to one real v2 catalog id.  A title that
 * resolves to multiple catalog works is left unmapped rather than guessing.
 */
export function mapCuratedBooksToCatalog(
  catalogBooks: readonly CuratedCatalogBook[],
  sourceBooks: readonly CuratedSlugBook[] = curatedBooks,
): ReadonlyMap<string, string> {
  const index = indexCatalogTitles(catalogBooks)
  const mapped = new Map<string, string>()

  for (const sourceBook of sourceBooks) {
    const candidates = new Set<string>()
    for (const { value } of titleValues(sourceBook)) {
      const key = normalizeCuratedTitle(value)
      if (!key) continue
      for (const entry of index.get(key) ?? []) candidates.add(entry.id)
    }
    if (candidates.size === 1) mapped.set(sourceBook.id, [...candidates][0])
  }

  return mapped
}

function relationKey(source: string, target: string): string {
  return source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`
}

function uniqueBasis(basis: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of basis) {
    const normalized = item.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function defaultSurprise(kind: RelationKind): number {
  switch (kind) {
    case '回声': return 0.38
    case '镜像': return 0.52
    case '暗河': return 0.66
    case '裂隙': return 0.8
    case '余烬': return 0.7
    case '潮汐': return 0.58
  }
}

/**
 * Merge hand-authored batches while preserving the first editorial route for
 * each undirected pair.  This is the extension point for future
 * `curatedThreads/*.ts` modules.
 */
export function mergeCuratedThreads(
  ...batches: ReadonlyArray<readonly CuratedThread[]>
): CuratedThread[] {
  const seen = new Set<string>()
  const merged: CuratedThread[] = []
  for (const batch of batches) {
    for (const thread of batch) {
      const source = thread.source.trim()
      const target = thread.target.trim()
      if (!source || !target || source === target) continue
      const key = relationKey(source, target)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push({
        ...thread,
        id: thread.id?.trim() || `${source}--${target}`,
        source,
        target,
        basis: uniqueBasis(thread.basis),
      })
    }
  }
  return merged
}

/**
 * Convert slug-authored reading hypotheses to real catalog relations.  A
 * missing/ambiguous endpoint, self-loop, or duplicate pair is omitted; no
 * placeholder book or synthetic relation is created.
 */
export function buildCuratedRelations(
  catalogBooks: readonly CuratedCatalogBook[],
  sourceBooks: readonly CuratedSlugBook[] = curatedBooks,
  sourceThreads: readonly CuratedThread[] = shippedCuratedThreads,
): BookRelation[] {
  return buildCuratedRelationsWithStats(catalogBooks, sourceBooks, sourceThreads).relations
}

export function buildCuratedRelationsWithStats(
  catalogBooks: readonly CuratedCatalogBook[],
  sourceBooks: readonly CuratedSlugBook[] = curatedBooks,
  sourceThreads: readonly CuratedThread[] = shippedCuratedThreads,
): CuratedRelationBuildResult {
  const mapped = mapCuratedBooksToCatalog(catalogBooks, sourceBooks)
  const catalogIds = new Set(catalogBooks.map((book) => book.id))
  const seen = new Set<string>()
  const relations: BookRelation[] = []
  const stats: CuratedRelationBuildStats = {
    mapped: 0,
    filtered: 0,
    duplicates: 0,
    input: sourceThreads.length,
    relationCount: 0,
  }

  // New editorial shards can reference the v2 catalog directly.  Preserve
  // that Q-id when it exists; legacy hero relations continue through the
  // exact slug/title map above.
  const resolveEndpoint = (value: string): string | undefined =>
    catalogIds.has(value) ? value : mapped.get(value)

  for (const thread of sourceThreads) {
    const sourceSlug = thread.source.trim()
    const targetSlug = thread.target.trim()
    const source = resolveEndpoint(sourceSlug)
    const target = resolveEndpoint(targetSlug)
    if (!sourceSlug || !targetSlug || sourceSlug === targetSlug || !source || !target || source === target || !catalogIds.has(source) || !catalogIds.has(target)) {
      stats.filtered += 1
      continue
    }
    stats.mapped += 1
    const key = relationKey(source, target)
    if (seen.has(key)) {
      stats.duplicates += 1
      continue
    }
    seen.add(key)
    const surprise = typeof thread.surprise === 'number' && Number.isFinite(thread.surprise)
      ? thread.surprise
      : defaultSurprise(thread.kind)
    const confidence = typeof thread.confidence === 'number' && Number.isFinite(thread.confidence)
      ? thread.confidence
      : 0.86
    relations.push({
      source,
      target,
      kind: thread.kind,
      sentence: thread.sentence.trim(),
      basis: uniqueBasis(thread.basis),
      surprise,
      confidence,
      provenance: 'reading-hypothesis',
    })
  }

  stats.relationCount = relations.length
  return { relations, stats }
}

function isCuratedThread(value: unknown): value is CuratedThread {
  if (!value || typeof value !== 'object') return false
  const thread = value as Partial<CuratedThread>
  return typeof thread.source === 'string'
    && typeof thread.target === 'string'
    && typeof thread.kind === 'string'
    && typeof thread.sentence === 'string'
    && Array.isArray(thread.basis)
}

/**
 * Discover all array exports from `curatedThreads/*.ts` without coupling the
 * adapter to a fixed shard count or export name.  This must remain a direct
 * Vite glob expression: Vite statically rewrites the call into imports in the
 * production bundle.  Keeping it behind a runtime feature check makes the
 * expression invisible to that transform and silently ships only the hero
 * relations.
 */
function discoverCuratedThreadBatches(): CuratedThread[][] {
  const modules = import.meta.glob('./curatedThreads/*.ts', { eager: true }) as Record<string, Record<string, unknown>>
  const batches: CuratedThread[][] = []
  const seenArrays = new Set<unknown>([curatedRelations])
  for (const module of Object.values(modules)) {
    for (const value of Object.values(module)) {
      if (!Array.isArray(value) || seenArrays.has(value)) continue
      seenArrays.add(value)
      const batch = value.filter(isCuratedThread)
      if (batch.length > 0) batches.push(batch)
    }
  }
  return batches
}

/** The currently shipped hand-curated reading hypotheses, including shards. */
export const shippedCuratedThreads: readonly CuratedThread[] = mergeCuratedThreads(
  [
    ...curatedRelations,
    ...discoverCuratedThreadBatches().flat(),
  ],
)

export type { CuratedBook, CuratedRelation }
