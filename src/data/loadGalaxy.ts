import type { MapRegion, Book, BookRelation, BookPosition, BookShape, RelationKind, BookEligibility, BookInstanceType } from '../types'
import { chooseRelations, otherBookId } from '../lib/galaxyMath'
import type { CuratedRelationBuildStats } from './curatedThreads'

export interface CatalogNeighbour {
  id: string
  semanticRank?: number
  similarity?: number
  surprise?: number
  navigable?: boolean
  basis?: string[]
}

/** Runtime book shape is the public Book contract plus no hidden placeholders. */
export type RuntimeBook = Book & { clusterLabels?: string[] }

interface CatalogBook {
  id: string
  title: string
  author?: string
  originalTitle?: string
  foreignTitle?: string
  wikipediaTitle?: string
  aliases?: string[]
  year?: number
  language?: string
  country?: string
  summary?: string
  hook?: string
  notes?: Book['notes']
  subjects?: string[]
  themes?: string[]
  themeProvenance?: Book['themeProvenance']
  themeEvidence?: Book['themeEvidence']
  instanceOf?: BookInstanceType[]
  eligibility?: BookEligibility
  downloads?: number | null
  source?: string
  sourceUrl?: string
  wikidataUrl?: string
  openLibraryId?: string | null
  coverUrl?: string | null
  coverSourceUrl?: string | null
  coverAsset?: Book['coverAsset']
  imageKind?: string
  popularity?: number
  contentLength?: number
  metadataCompleteness?: number
  position?: BookPosition
  localDensity?: number
  outlierScore?: number
  magnitude?: number
  halo?: number
  shape?: BookShape | number
  temperature?: number
  clusterWeights?: Record<string, number> | readonly number[]
  clusterLabels?: string[]
  neighbors?: CatalogNeighbour[]
  spatialNeighbors?: string[]
  spatialSemanticOverlap?: number
  provenance?: Book['provenance']
}

export interface CatalogEdge {
  source: string
  target: string
  kind?: RelationKind
  similarity?: number
  weight?: number
  basis?: string[]
  sentence?: string
  surprise?: number
  surpriseByBook?: Record<string, number>
  bandByBook?: Record<string, 'low' | 'middle' | 'high'>
  confidence?: number
  evidence?: Record<string, number | boolean | string | string[]>
  provenance?: 'catalog' | 'semantic' | 'semantic-layout' | string
}

interface CatalogPayload {
  schemaVersion?: string
  generatedAt?: string
  source?: string
  sourceUrl?: string
  layoutModel?: string | null
  books?: CatalogBook[]
  relations?: CatalogEdge[]
  regions?: MapRegion[]
}

const FORMAL_BOOK_COUNT = 1_000
const FORMAL_RELATION_COUNT = 5_385
const chineseCharacters = (value = '') => [...value.matchAll(/[\u3400-\u9fff]/gu)].length

function hasHonestBasis(edge: CatalogEdge): boolean {
  const basis = edge.basis?.map((item) => item.trim()).filter(Boolean) ?? []
  return basis.includes('多维书目语义相似度')
    && basis.some((item) => item === '主题' || item === '时代' || item === '地域')
}

function isCompleteFormalCatalog(books: readonly CatalogBook[], edges: readonly CatalogEdge[]): boolean {
  if (books.length !== FORMAL_BOOK_COUNT || edges.length !== FORMAL_RELATION_COUNT) return false
  const ids = new Set(books.map((book) => book.id))
  if (ids.size !== books.length || books.some((book) => {
    const themes = book.themes ?? book.subjects ?? []
    return !book.id || !/[\u3400-\u9fff]/u.test(book.title) || !book.author?.trim()
      || chineseCharacters(book.summary) < 120 || themes.filter(Boolean).length < 3
      || !book.eligibility?.accepted || !book.instanceOf?.length
      || !book.sourceUrl?.startsWith('https://')
      || !book.provenance?.wikipediaRevisionUrl?.includes('oldid=')
      || book.position?.length !== 3 || !book.position.every(Number.isFinite)
  })) return false

  const pairs = new Set<string>()
  const degree = new Map<string, number>()
  const bands = new Map<string, Set<string>>()
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target || !hasHonestBasis(edge)) return false
    const pair = [edge.source, edge.target].sort((left, right) => left.localeCompare(right)).join('::')
    if (pairs.has(pair)) return false
    pairs.add(pair)
    for (const id of [edge.source, edge.target]) {
      degree.set(id, (degree.get(id) ?? 0) + 1)
      const band = edge.bandByBook?.[id]
      if (band) {
        const values = bands.get(id) ?? new Set<string>()
        values.add(band)
        bands.set(id, values)
      }
    }
  }
  return books.every((book) => (degree.get(book.id) ?? 0) >= 6
    && ['low', 'middle', 'high'].every((band) => bands.get(book.id)?.has(band)))
}

export interface GalaxyData {
  books: RuntimeBook[]
  curated: RuntimeBook[]
  curatedRelations: BookRelation[]
  /** Counts from the editorial adapter; absent only for pre-v2 fixtures. */
  curatedRelationStats?: CuratedRelationBuildStats
  catalogEdges: CatalogEdge[]
  /** Named map regions; empty for snapshots built before regions existed. */
  regions?: MapRegion[]
  relationCount: number
  source: string
  generatedAt?: string
}

function normalizeCatalogBook(book: CatalogBook): RuntimeBook {
  return {
    id: book.id,
    title: book.title || book.originalTitle || '未命名作品',
    author: book.author || '作者未知',
    year: book.year,
    language: book.language,
    themes: (book.themes ?? book.subjects ?? []).filter((theme): theme is string => typeof theme === 'string' && theme.trim().length > 0),
    themeProvenance: book.themeProvenance,
    themeEvidence: book.themeEvidence,
    originalTitle: book.originalTitle ?? book.foreignTitle,
    aliases: book.aliases,
    summary: book.summary?.trim(),
    hook: book.hook?.trim() || undefined,
    notes: book.notes,
    instanceOf: book.instanceOf,
    eligibility: book.eligibility,
    wikipediaTitle: book.wikipediaTitle,
    foreignTitle: book.foreignTitle,
    country: book.country,
    wikidataUrl: book.wikidataUrl,
    openLibraryId: book.openLibraryId ?? undefined,
    coverUrl: book.coverUrl ?? undefined,
    coverSourceUrl: book.coverSourceUrl,
    coverAsset: book.coverAsset,
    imageKind: book.imageKind,
    popularity: book.popularity,
    contentLength: book.contentLength,
    metadataCompleteness: book.metadataCompleteness,
    position: book.position,
    localDensity: book.localDensity,
    outlierScore: book.outlierScore,
    magnitude: book.magnitude,
    halo: book.halo,
    shape: book.shape,
    temperature: book.temperature,
    clusterWeights: book.clusterWeights,
    clusterLabels: book.clusterLabels,
    neighbors: book.neighbors,
    spatialNeighbors: book.spatialNeighbors,
    spatialSemanticOverlap: book.spatialSemanticOverlap,
    provenance: book.provenance,
    source: book.source ?? '中文维基百科 / Wikidata',
    sourceUrl: book.sourceUrl,
    downloads: book.downloads ?? undefined,
  }
}

interface CorePayload {
  schemaVersion?: string
  source?: string
  regions?: MapRegion[]
  books?: Array<CatalogBook & { summaryChars?: number }>
}

/**
 * First paint: a ~190 KB slice (positions, titles, search fields) so the star
 * field and the intro search come alive long before the full catalog lands.
 * Books are partial until {@link loadGalaxyData} is given this result and
 * fills the same objects in place (the renderer never rebuilds).
 */
export async function loadGalaxyCore(signal?: AbortSignal): Promise<GalaxyData> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/catalog.core.json`, { signal })
  if (!response.ok) throw new Error(`书目索引载入失败（${response.status}）`)
  const payload = await response.json() as CorePayload
  if (payload.schemaVersion !== 'bookshelf-galaxy/catalog-core-v1' || !payload.books?.length) {
    throw new Error('书目索引格式不符')
  }
  const books = payload.books.map((book) => ({ ...normalizeCatalogBook(book), summaryChars: book.summaryChars }))
  return {
    ...emptyGalaxyData(),
    books,
    regions: (payload.regions ?? []).filter((region) => region.id && region.name && Array.isArray(region.bookIds)),
    source: payload.source ?? '中文富书目快照',
  }
}

function emptyGalaxyData(): GalaxyData {
  return { books: [], curated: [], curatedRelations: [], catalogEdges: [], regions: [], relationCount: 0, source: '' }
}

export async function loadGalaxyData(signal?: AbortSignal, core?: GalaxyData): Promise<GalaxyData> {
  // Hand-written threads are ~0.9 MB of source in their own chunk; fetch it in
  // parallel with the catalog rather than after it.
  const curatedModule = import('./curatedThreads')
  curatedModule.catch(() => undefined)
  const response = await fetch(`${import.meta.env.BASE_URL}data/catalog.runtime.json`, { signal })
  if (!response.ok) throw new Error(`真实书目载入失败（${response.status}）`)
  const payload = await response.json() as CatalogPayload
  if (payload.schemaVersion !== 'bookshelf-galaxy/catalog-v2') {
    throw new Error('真实书目不是中文富内容 v2 快照')
  }
  const catalogSourceBooks = payload.books ?? []
  const catalogEdges = payload.relations ?? []
  if (!isCompleteFormalCatalog(catalogSourceBooks, catalogEdges)) {
    throw new Error('真实书目快照不完整')
  }
  let catalogBooks = catalogSourceBooks.map(normalizeCatalogBook)
  if (core) {
    // Fill the partial core books in place so array and object identity hold.
    const full = new Map(catalogBooks.map((book) => [book.id, book]))
    if (core.books.length !== catalogBooks.length || core.books.some((book) => !full.has(book.id))) {
      throw new Error('书目索引与完整书目不一致')
    }
    core.books.forEach((book) => Object.assign(book, full.get(book.id)))
    catalogBooks = core.books
  }
  const { buildCuratedRelationsWithStats } = await curatedModule
  const curatedBuild = buildCuratedRelationsWithStats(catalogBooks)
  return {
    books: catalogBooks,
    curated: [],
    // Hand-authored routes are mapped to the real catalog Q-ids at load time.
    // They stay separate from the three algorithmic detour options below.
    curatedRelations: curatedBuild.relations,
    curatedRelationStats: curatedBuild.stats,
    catalogEdges,
    regions: core?.regions ?? (payload.regions ?? []).filter((region) => region.id && region.name && Array.isArray(region.bookIds)),
    relationCount: catalogEdges.length,
    source: payload.source ?? '中文富书目快照',
    generatedAt: payload.generatedAt,
  }
}

export function makeRelationResolver(data: GalaxyData): {
  optionsFor: (bookId: string, visited: ReadonlySet<string>) => BookRelation[]
} {
  const booksById = new Map(data.books.map((book) => [book.id, book]))
  const adjacency = new Map<string, CatalogEdge[]>()
  data.catalogEdges.forEach((edge) => {
    if (!hasHonestBasis(edge)) return
    const sourceEdges = adjacency.get(edge.source)
    if (sourceEdges) sourceEdges.push(edge)
    else adjacency.set(edge.source, [edge])
    const targetEdges = adjacency.get(edge.target)
    if (targetEdges) targetEdges.push(edge)
    else adjacency.set(edge.target, [edge])
  })

  const relationKinds: RelationKind[] = ['回声', '镜像', '暗河', '裂隙', '余烬', '潮汐']
  const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value))

  const enrich = (edge: CatalogEdge, bookId: string): BookRelation => {
    const targetId = otherBookId(edge, bookId)
    const sourceBook = booksById.get(bookId)
    const targetBook = booksById.get(targetId)
    const basis = edge.basis?.map((item) => item.trim()).filter(Boolean) ?? []
    // Invalid evidence is filtered while building the adjacency index.  The
    // runtime never invents a theme or historical fact for a malformed edge.
    const shared = basis[0]?.replace(/^[^:：]+[:：]/, '') || '一条尚未命名的共同线索'
    const confidence = Number.isFinite(edge.confidence)
      ? clamp(edge.confidence as number, 0, 1)
      : clamp(0.55 + (edge.weight ?? 0.72) * 0.4, 0, 0.98)
    const localSurprise = edge.surpriseByBook?.[bookId]
    const surprise = Number.isFinite(localSurprise)
      ? clamp(localSurprise as number, 0, 1)
      : Number.isFinite(edge.surprise)
        ? clamp(edge.surprise as number, 0, 1)
      : basis.some((item) => item.startsWith('作者'))
      ? 0.28
      : basis.some((item) => item.startsWith('主题'))
        ? 0.46
        : basis.some((item) => item.startsWith('年代'))
          ? 0.7
          : basis.some((item) => item.startsWith('语言'))
            ? 0.88
            : 0.66
    const kind = edge.kind && relationKinds.includes(edge.kind) ? edge.kind : relationKind({ ...edge, surprise })
    return {
      source: bookId,
      target: targetId,
      kind,
      // Valid v2 edges carry their own sentence.  The fallback names both
      // real endpoints and the surviving clue rather than choosing a generic
      // kind-based template, so an incomplete fixture cannot masquerade as
      // editorial prose in the observatory.
      sentence: edge.sentence?.trim()
        || `《${sourceBook?.title ?? '这本书'}》与《${targetBook?.title ?? '远方作品'}》在“${shared}”处相遇。`,
      basis,
      similarity: edge.similarity,
      weight: edge.weight,
      confidence,
      surprise,
      evidence: edge.evidence,
      distanceBand: surprise < 0.52 ? 'near' : surprise < 0.8 ? 'mid' : surprise >= 0.92 ? 'distant' : 'far',
      provenance: edge.provenance === 'catalog' ? 'catalog' : 'semantic',
    }
  }

  function relationKind(edge: CatalogEdge): RelationKind {
    const surprise = edge.surprise ?? (edge.weight === undefined ? 0.62 : 1 - edge.weight)
    if (surprise >= 0.82) return '裂隙'
    if (surprise >= 0.66) return '暗河'
    if (surprise >= 0.5) return '余烬'
    if ((edge.similarity ?? edge.weight ?? 0) >= 0.84) return '回声'
    return '潮汐'
  }

  return {
    optionsFor(bookId, visited) {
      const catalog = (adjacency.get(bookId) ?? [])
        .filter((edge) => booksById.has(otherBookId(edge, bookId)) && !visited.has(otherBookId(edge, bookId)))
        .map((edge) => enrich(edge, bookId))
      return chooseRelations(catalog, bookId, visited)
    },
  }
}
