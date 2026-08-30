import { curatedBooks, type CuratedBook } from './curatedBooks'
import { curatedRelations, type CuratedRelation } from './curatedRelations'
import type { Book, BookRelation, RelationKind } from '../types'
import { chooseRelations, otherBookId } from '../lib/galaxyMath'

interface CatalogBook {
  id: string
  title: string
  author: string
  year?: number
  language?: string
  subjects?: string[]
  themes?: string[]
  downloads?: number | null
  source?: string
  sourceUrl?: string
}

export interface CatalogEdge {
  source: string
  target: string
  kind?: RelationKind
  weight?: number
  basis?: string[]
  provenance?: 'catalog'
}

interface CatalogPayload {
  generatedAt: string
  source: string
  sourceUrl: string
  books: CatalogBook[]
  relations: CatalogEdge[]
}

export interface GalaxyData {
  books: Book[]
  curated: Book[]
  curatedRelations: BookRelation[]
  catalogEdges: CatalogEdge[]
  relationCount: number
  source: string
  generatedAt?: string
}

function normalizeCuratedBook(book: CuratedBook): Book {
  return {
    ...book,
    mood: book.mood.split(/[、，,]/).map((item) => item.trim()).filter(Boolean),
    source: 'Open Library 可核查作品记录',
  }
}

function normalizeCuratedRelation(relation: CuratedRelation): BookRelation {
  return { ...relation, provenance: 'reading-hypothesis' }
}

function normalizeCatalogBook(book: CatalogBook): Book {
  return {
    id: book.id,
    title: book.title,
    author: book.author || '作者未知',
    year: book.year,
    language: book.language,
    themes: (book.themes ?? book.subjects ?? []).slice(0, 5),
    source: book.source ?? 'Project Gutenberg',
    sourceUrl: book.sourceUrl,
    downloads: book.downloads ?? undefined,
  }
}

export const initialCuratedBooks = curatedBooks.map(normalizeCuratedBook)
export const richCuratedRelations = curatedRelations.map(normalizeCuratedRelation)

export async function loadGalaxyData(signal?: AbortSignal): Promise<GalaxyData> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/catalog.json`, { signal })
  if (!response.ok) throw new Error(`真实书目载入失败（${response.status}）`)
  const payload = await response.json() as CatalogPayload
  const catalogBooks = payload.books.map(normalizeCatalogBook)
  return {
    books: [...initialCuratedBooks, ...catalogBooks],
    curated: initialCuratedBooks,
    curatedRelations: richCuratedRelations,
    catalogEdges: payload.relations,
    relationCount: payload.relations.length + richCuratedRelations.length,
    source: payload.source,
    generatedAt: payload.generatedAt,
  }
}

export function makeRelationResolver(data: GalaxyData): {
  optionsFor: (bookId: string, visited: ReadonlySet<string>) => BookRelation[]
} {
  const booksById = new Map(data.books.map((book) => [book.id, book]))
  const adjacency = new Map<string, CatalogEdge[]>()
  data.catalogEdges.forEach((edge) => {
    const sourceEdges = adjacency.get(edge.source)
    if (sourceEdges) sourceEdges.push(edge)
    else adjacency.set(edge.source, [edge])
    const targetEdges = adjacency.get(edge.target)
    if (targetEdges) targetEdges.push(edge)
    else adjacency.set(edge.target, [edge])
  })

  const enrich = (edge: CatalogEdge, bookId: string): BookRelation => {
    const targetId = otherBookId(edge, bookId)
    const sourceBook = booksById.get(bookId)
    const targetBook = booksById.get(targetId)
    const basis = edge.basis?.length ? edge.basis : ['开放书目中的主题邻接']
    const kind = edge.kind ?? '回声'
    const shared = basis[0]?.replace(/^[^:：]+[:：]/, '') || '一条尚未命名的共同线索'
    const sentences: Record<RelationKind, string> = {
      回声: `《${targetBook?.title ?? '远方作品'}》在另一页里回应了“${shared}”，相似并未让它们说出同一个答案。`,
      镜像: `它们共享“${shared}”，却像两面相背的镜子，让同一个问题显出不同轮廓。`,
      暗河: `“${shared}”是一条藏在书目之下的暗河，把${sourceBook?.author ?? '两位作者'}与${targetBook?.author ?? '另一位作者'}带到同一片水域。`,
      裂隙: `沿着“${shared}”靠近，原本稳固的分类出现了一道可以穿过的裂隙。`,
      余烬: `两本书都在“${shared}”之后留下余温；真正相连的不是情节，而是读完仍未熄灭的问题。`,
      潮汐: `“${shared}”让两本相距遥远的书在同一次潮汐里靠近。`,
    }
    const confidence = Math.min(0.98, Math.max(0.55, edge.weight ?? 0.72))
    return {
      source: bookId,
      target: targetId,
      kind,
      sentence: sentences[kind],
      basis,
      confidence,
      surprise: Math.min(0.96, Math.max(0.34, 1.08 - confidence * 0.52)),
      provenance: 'catalog',
    }
  }

  return {
    optionsFor(bookId, visited) {
      const curated = chooseRelations(data.curatedRelations, bookId, visited)
      if (curated.length >= 3) return curated
      const catalog = (adjacency.get(bookId) ?? [])
        .filter((edge) => !visited.has(otherBookId(edge, bookId)))
        .slice(0, 12)
        .map((edge) => enrich(edge, bookId))
      return [...curated, ...catalog].slice(0, 3)
    },
  }
}
