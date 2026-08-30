import { afterEach, describe, expect, it, vi } from 'vitest'
import catalogSnapshot from '../../public/data/catalog.json'
import type { Book } from '../types'
import {
  buildCuratedRelations,
  buildCuratedRelationsWithStats,
  mapCuratedBooksToCatalog,
  mergeCuratedThreads,
  normalizeCuratedTitle,
  shippedCuratedThreads,
  type CuratedThread,
} from './curatedThreads'
import {
  loadGalaxyData,
  makeRelationResolver,
  type GalaxyData,
} from './loadGalaxy'

const curatedThreadModules = import.meta.glob('./curatedThreads/*.ts', { eager: true })

const books: Book[] = ['root', 'author', 'theme', 'era', 'language'].map((id) => ({
  id,
  title: id,
  author: `${id}-author`,
  themes: [id],
}))

describe('catalog relation resolver', () => {
  it('selects distinct evidence-backed near, bridge, and far relations', () => {
    const data: GalaxyData = {
      books,
      curated: [],
      curatedRelations: [],
      relationCount: 4,
      source: 'test',
      catalogEdges: [
        { source: 'root', target: 'author', weight: 0.92, surprise: 0.28, basis: ['多维书目语义相似度', '主题'] },
        { source: 'root', target: 'theme', weight: 0.88, surprise: 0.5, basis: ['多维书目语义相似度', '主题'] },
        { source: 'root', target: 'era', weight: 0.62, surprise: 0.7, basis: ['多维书目语义相似度', '时代'] },
        { source: 'root', target: 'language', weight: 0.3, surprise: 0.88, basis: ['多维书目语义相似度', '地域'] },
      ],
    }

    const options = makeRelationResolver(data).optionsFor('root', new Set(['root']))
    expect(options).toHaveLength(3)
    expect(options.map((relation) => relation.target)).toEqual(['author', 'era', 'language'])
    expect(options.map((relation) => relation.surprise)).toEqual([0.28, 0.7, 0.88])
  })

  it('drops a relation whose factual basis is missing instead of fabricating one', () => {
    const data: GalaxyData = {
      books,
      curated: [],
      curatedRelations: [],
      relationCount: 1,
      source: 'test',
      catalogEdges: [{ source: 'root', target: 'theme', weight: 0.9 }],
    }

    expect(makeRelationResolver(data).optionsFor('root', new Set(['root']))).toEqual([])
  })

  it('keeps editorial reading hypotheses out of the three algorithmic detour options', () => {
    const data: GalaxyData = {
      books,
      curated: [],
      curatedRelations: [{
        source: 'root',
        target: 'author',
        kind: '镜像',
        sentence: '一条人工策展的远行线',
        basis: ['人物：相似的选择'],
        surprise: 0.6,
        confidence: 0.9,
        provenance: 'reading-hypothesis',
      }],
      relationCount: 0,
      source: 'test',
      catalogEdges: [],
    }

    expect(makeRelationResolver(data).optionsFor('root', new Set(['root']))).toEqual([])
  })

  afterEach(() => vi.unstubAllGlobals())

  it('loads the complete formal snapshot and retains audited provenance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(catalogSnapshot), {
      headers: { 'content-type': 'application/json' },
    })))

    const data = await loadGalaxyData()
    const sourceBook = catalogSnapshot.books[0]
    expect(data.books.find((book) => book.id === sourceBook.id)).toMatchObject({
      instanceOf: sourceBook.instanceOf,
      eligibility: sourceBook.eligibility,
      provenance: sourceBook.provenance,
    })
    expect(data.books).toHaveLength(1_000)
    expect(data.catalogEdges).toHaveLength(5_380)
    expect(data.curated).toEqual([])
    expect(data.curatedRelations).toHaveLength(3_002)
  })

  it('rejects a partial v2 payload instead of presenting it as the formal catalog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 'bookshelf-galaxy/catalog-v2',
      relations: [],
      books: [{
        id: 'Q123',
        title: '测试作品',
        author: '测试作者',
        themes: ['文学'],
        eligibility: { accepted: true, reason: '作品类型：小说' },
      }],
    }), { headers: { 'content-type': 'application/json' } })))

    await expect(loadGalaxyData()).rejects.toThrow('真实书目快照不完整')
  })
})

describe('curated reading-thread adapter', () => {
  const sourceBooks = [
    { id: 'alpha', title: 'Alpha：Book', originalTitle: 'Alpha Book' },
    { id: 'beta', title: 'Beta' },
    { id: 'missing', title: 'Not in the catalog' },
  ] as const
  const catalogBooks = [
    { id: 'Q1', title: 'Ａｌｐｈａ: Book', aliases: ['Alpha Book'] },
    { id: 'Q2', title: 'Beta' },
  ] as const

  const thread = (source: string, target: string, sentence = '一条阅读联想') : CuratedThread => ({
    source,
    target,
    kind: '回声',
    sentence,
    basis: ['主题：共同命运', '主题：共同命运', '意象：远行'],
    surprise: 0.42,
    confidence: 0.9,
  })

  it('matches NFKC title variants after punctuation removal, without fuzzy matches', () => {
    expect(normalizeCuratedTitle('Alpha：Book')).toBe(normalizeCuratedTitle('Ａｌｐｈａ: Book'))
    expect(mapCuratedBooksToCatalog(catalogBooks, sourceBooks)).toEqual(new Map([
      ['alpha', 'Q1'],
      ['beta', 'Q2'],
    ]))
  })

  it('filters missing endpoints, self-loops, and reversed duplicates while preserving evidence', () => {
    const relations = buildCuratedRelations(catalogBooks, sourceBooks, [
      thread('alpha', 'beta'),
      thread('beta', 'alpha', '重复的反向联想'),
      thread('alpha', 'alpha', '自环'),
      thread('alpha', 'missing', '缺失端点'),
    ])

    expect(relations).toHaveLength(1)
    expect(relations[0]).toMatchObject({
      source: 'Q1',
      target: 'Q2',
      provenance: 'reading-hypothesis',
      basis: ['主题：共同命运', '意象：远行'],
    })
    expect(relations[0].sentence).toBe('一条阅读联想')
  })

  it('accepts direct catalog Q-id endpoints from future shards and reports build counts', () => {
    const relations = buildCuratedRelationsWithStats(catalogBooks, sourceBooks, [
      { ...thread('alpha', 'beta'), source: 'Q1', target: 'Q2' },
      { ...thread('alpha', 'beta'), source: 'Q2', target: 'Q1' },
      { ...thread('alpha', 'missing'), source: 'Q1', target: 'Q404' },
    ])

    expect(relations.relations).toHaveLength(1)
    expect(relations.stats).toMatchObject({
      input: 3,
      mapped: 2,
      filtered: 1,
      duplicates: 1,
      relationCount: 1,
    })
    expect(relations.relations[0].provenance).toBe('reading-hypothesis')
  })

  it('offers a pure merge seam for future curated-thread batches', () => {
    const merged = mergeCuratedThreads(
      [thread('alpha', 'beta')],
      [thread('beta', 'alpha', '不会覆盖先来的策展线')],
      [thread('alpha', 'alpha', '不会产生自环')],
    )

    expect(merged).toHaveLength(1)
    expect(merged[0].sentence).toBe('一条阅读联想')
    expect(merged[0].id).toBe('alpha--beta')
    expect(merged[0].basis).toEqual(['主题：共同命运', '意象：远行'])
  })

  it('loads the complete shipped thread constellation through Vite glob', () => {
    const snapshot = catalogSnapshot as unknown as { books: Book[]; relations?: GalaxyData['catalogEdges'] }
    expect(snapshot.books).toHaveLength(1000)
    expect(Object.keys(curatedThreadModules)).toHaveLength(17)
    expect(shippedCuratedThreads.length).toBeGreaterThanOrEqual(3000)

    const result = buildCuratedRelationsWithStats(snapshot.books, undefined, shippedCuratedThreads)
    expect(result.stats.relationCount).toBeGreaterThanOrEqual(3000)
    expect(result.relations.every((relation) => relation.provenance === 'reading-hypothesis')).toBe(true)

    const directQidThreads = shippedCuratedThreads.filter((thread) => /^Q\d+$/u.test(thread.source) && /^Q\d+$/u.test(thread.target))
    const directResult = buildCuratedRelationsWithStats(snapshot.books, [], directQidThreads)
    expect(directResult.stats.filtered).toBe(0)
    expect(directResult.stats.duplicates).toBe(0)

    const catalogIds = new Set(snapshot.books.map((book) => book.id))
    expect(result.relations.every((relation) => catalogIds.has(relation.source) && catalogIds.has(relation.target))).toBe(true)

    const runtime: GalaxyData = {
      books: snapshot.books,
      curated: [],
      curatedRelations: result.relations,
      catalogEdges: snapshot.relations ?? [],
      relationCount: (snapshot.relations ?? []).length,
      source: 'effective-thread-test',
    }
    const resolver = makeRelationResolver(runtime)
    for (const book of snapshot.books) {
      expect(resolver.optionsFor(book.id, new Set([book.id])).every((relation) => relation.provenance !== 'reading-hypothesis')).toBe(true)
    }
  })
})
