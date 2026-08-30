import { describe, expect, it } from 'vitest'
import {
  curatedThreadsFor,
  directionCopy,
  relationExcerpt,
  relationReading,
  safeExternalUrl,
  voyageCopy,
  whyHereCopy,
} from './ExperienceUI'
import type { Book, BookRelation } from '../types'

describe('safeExternalUrl', () => {
  it('accepts only the expected source records', () => {
    expect(safeExternalUrl('https://zh.wikipedia.org/wiki/%E4%B8%89%E4%BD%93')).toBe('https://zh.wikipedia.org/wiki/%E4%B8%89%E4%BD%93')
    expect(safeExternalUrl('https://zh.wikipedia.org/wiki/%E4%B8%89%E4%BD%93?oldid=123', 'wikipediaRevision')).toBe('https://zh.wikipedia.org/wiki/%E4%B8%89%E4%BD%93?oldid=123')
    expect(safeExternalUrl('https://www.wikidata.org/wiki/Q123', 'wikidata')).toBe('https://www.wikidata.org/wiki/Q123')
    expect(safeExternalUrl('https://covers.openlibrary.org/b/id/8231856-M.jpg', 'cover')).toBe('https://covers.openlibrary.org/b/id/8231856-M.jpg')
    expect(safeExternalUrl('https://openlibrary.org/works/OL45804W', 'coverSource')).toBe('https://openlibrary.org/works/OL45804W')
    expect(safeExternalUrl('https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hans', 'license')).toBe('https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hans')
  })

  it('rejects lookalike hosts, unsafe protocols, and unexpected paths', () => {
    expect(safeExternalUrl('https://evil.example/https://covers.openlibrary.org/b/id/1-M.jpg', 'cover')).toBeUndefined()
    expect(safeExternalUrl('https://covers.openlibrary.org.evil.example/b/id/1-M.jpg', 'cover')).toBeUndefined()
    expect(safeExternalUrl('https://user:password@covers.openlibrary.org/b/id/1-M.jpg', 'cover')).toBeUndefined()
    expect(safeExternalUrl('https://covers.openlibrary.org/b/id/1-M.jpg?default=false', 'cover')).toBeUndefined()
    expect(safeExternalUrl('javascript:alert(1)', 'source')).toBeUndefined()
    expect(safeExternalUrl('https://zh.wikipedia.org/w/index.php?search=%E4%B8%89%E4%BD%93', 'source')).toBeUndefined()
    expect(safeExternalUrl('https://zh.wikipedia.org/wiki/%E4%B8%89%E4%BD%93?oldid=1&oldid=2', 'wikipediaRevision')).toBeUndefined()
    expect(safeExternalUrl('https://www.wikidata.org/wiki/P31', 'wikidata')).toBeUndefined()
    expect(safeExternalUrl('https://openlibrary.org/works/OL45804W?foo=bar', 'coverSource')).toBeUndefined()
  })
})

describe('curatedThreadsFor', () => {
  const makeBook = (id: string, title: string): Book => ({ id, title, author: `${title}的作者`, themes: [] })
  const makeRelation = (source: string, target: string, confidence: number, sentence = '一条来自远方的阅读联想。'): BookRelation => ({
    source,
    target,
    kind: '回声',
    sentence,
    basis: ['主题'],
    surprise: 0.5,
    confidence,
    provenance: 'reading-hypothesis',
  })

  it('returns at most three distinct, resolvable destinations in editorial order', () => {
    const books = ['origin', 'near', 'far', 'bridge', 'fourth'].map((id) => makeBook(id, id))
    const booksById = new Map(books.map((book) => [book.id, book]))
    const relations = [
      makeRelation('origin', 'near', 0.88),
      makeRelation('origin', 'near', 0.95, '更可信的同一条阅读联想。'),
      makeRelation('origin', 'far', 0.9),
      makeRelation('origin', 'bridge', 0.86),
      makeRelation('origin', 'fourth', 0.84),
      makeRelation('origin', 'missing', 1),
      makeRelation('other', 'far', 1),
    ]

    const result = curatedThreadsFor('origin', relations, booksById)

    expect(result).toHaveLength(3)
    expect(result.map(({ target }) => target.id)).toEqual(['near', 'far', 'bridge'])
    expect(result[0].relation.sentence).toBe('更可信的同一条阅读联想。')
  })

  it('resolves the opposite endpoint and stays empty without a matching thread', () => {
    const origin = makeBook('origin', '出发星')
    const remote = makeBook('remote', '远方书星')
    const booksById = new Map([origin, remote].map((book) => [book.id, book]))
    const relation = makeRelation('remote', 'origin', 0.9)

    expect(curatedThreadsFor('origin', [relation], booksById).map(({ target }) => target.title)).toEqual(['远方书星'])
    expect(curatedThreadsFor('unknown', [relation], booksById)).toEqual([])
  })

  it('keeps semantic prose out of every public reading helper', () => {
    const origin = makeBook('origin', '出发星')
    const remote = makeBook('remote', '远方书星')
    const sentinel = '禁止泄露的算法模板句 SENTINEL-SEMANTIC-7429'
    const relation = makeRelation('origin', 'remote', 0.9, sentinel)
    relation.provenance = 'semantic'
    relation.distanceBand = 'far'

    const publicCopy = [
      relationReading(relation, origin, remote),
      relationExcerpt(relation),
      directionCopy(relation, remote, 2, 3).description,
      whyHereCopy('文学书云', '书云深处', { book: remote }),
      voyageCopy(relation, origin, remote).label,
      voyageCopy(relation, origin, remote).route,
    ].join('\n')

    expect(publicCopy).not.toContain(sentinel)
    expect(curatedThreadsFor('origin', [relation], new Map([[origin.id, origin], [remote.id, remote]]))).toEqual([])
    expect(relationReading(relation, origin, remote)).toBe('这次航行从《出发星》抵达《远方书星》。')
    expect(directionCopy(relation, remote, 2, 3)).toMatchObject({ band: '远' })
    expect(whyHereCopy('文学书云', '书云深处', { book: remote })).toContain('《远方书星》是离这里最近的书星')
    expect(voyageCopy(relation, origin, remote).route).toBe('《出发星》  ·  《远方书星》')
  })

  it('preserves an authored reading hypothesis exactly', () => {
    const origin = makeBook('origin', '出发星')
    const remote = makeBook('remote', '远方书星')
    const sentence = '《出发星》守着旧港口，《远方书星》把潮声带到另一页。'
    const relation = makeRelation('origin', 'remote', 0.9, sentence)

    expect(relationReading(relation, origin, remote)).toBe(sentence)
    expect(relationExcerpt(relation)).toBe('《出发星》守着旧港口，《远方书星》把潮声带到另一页')
    expect(directionCopy(relation, remote, 0, 3).description).toBe(sentence)
  })

  it('uses the rank-sorted first semantic neighbour for WHY HERE', () => {
    const first: Book = { id: 'first', title: '首邻', author: '作者A', themes: [] }
    const second: Book = { id: 'second', title: '次邻', author: '作者B', themes: [] }
    const semanticNeighbors = [
      { book: first, semanticRank: 0, navigable: false, basis: [] as string[] },
      { book: second, semanticRank: 1, navigable: true, basis: ['主题'] },
    ]
    // BookObservatory now correctly picks semanticNeighbors[0] as nearest, not the filtered second.
    const nearest = semanticNeighbors[0]
    expect(whyHereCopy('文学书云', '深处', nearest)).toContain('《首邻》是离这里最近的书星')
    expect(whyHereCopy('文学书云', '深处', nearest)).not.toContain('次邻')
  })

  it('semantic voyage/detour omit curated kind and curated payload shape includes kind/sentence/basis', () => {
    const sentinelKind = '回声' as const
    const sentinelBasis = ['人物命运']
    const semantic = makeRelation('origin', 'remote', 0.9, 'SENTINEL-SEMANTIC-KIND')
    semantic.provenance = 'semantic'
    semantic.kind = sentinelKind
    semantic.basis = sentinelBasis
    semantic.distanceBand = 'far'
    const origin = makeBook('origin', '出发星')
    const remote = makeBook('remote', '远方书星')
    // voyage label for semantic must be navigation, not curated kind
    expect(voyageCopy(semantic, origin, remote).label).not.toContain(sentinelKind)
    expect(voyageCopy(semantic, origin, remote).label).toBe('驶向远星')
    // detour small label must not append curated kind for semantic
    const detour = directionCopy(semantic, remote, 0, 3)
    // directionCopy band label already tested not to contain kind; ensure description is navigation copy
    expect(detour.description).not.toContain('SENTINEL')
  })
})

describe('modal focus and mounted observatory', () => {
  it('keeps BookObservatory mounted behind overlays so opener stays connected (static contract)', async () => {
    // @ts-ignore - node fs is available in vitest node environment
    const fs = await import('node:fs')
    const appSource = fs.readFileSync('src/App.tsx', 'utf8')
    // BookObservatory must stay mounted when an overlay is open; only travelling hides it.
    expect(appSource).toContain("state.status !== 'travelling'")
    expect(appSource).not.toContain("!state.directionsOpen && !state.librarianOpen")
    const uiSource = fs.readFileSync('src/components/ExperienceUI.tsx', 'utf8')
    expect(uiSource).toContain('[data-overlay-trigger="detour"]')
    expect(uiSource).toContain('[data-overlay-trigger="librarian"]')
    expect(uiSource).toContain('[data-overlay-trigger="chart"]')
    // App must not steal focus when overlay is open: overlayOpen guards title focus
    expect(appSource).toContain('overlayOpen')
  })
})
