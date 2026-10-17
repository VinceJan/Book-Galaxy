import { afterEach, describe, expect, it, vi } from 'vitest'
import runtime from '../../public/data/catalog.runtime.json'
import library from '../../public/data/relations.v5.json'
import { loadGalaxyData, mapRelationsV2, makeRelationResolver } from './loadGalaxy'

const ids = new Set(runtime.books.map((book) => book.id))
afterEach(() => vi.unstubAllGlobals())

describe('v2 relation library', () => {
  it('maps every shipped record without losing prose, labels or evidence', () => {
    const edges = mapRelationsV2(library, ids)
    expect(edges).toHaveLength(1647)
    library.relations.forEach((record, index) => {
      expect(edges[index]).toMatchObject({
        source: record.s, target: record.t, sentence: record.text,
        relationType: record.type, strength: record.strength,
      })
      expect(edges[index].wd).toBe('wd' in record ? record.wd : undefined)
    })
  })
  it.each([
    { count: 0 },
    { schemaVersion: 'unknown' },
    { relations: [{ ...library.relations[0], t: 'Qmissing' }], count: 1 },
    { relations: [{ ...library.relations[0], strength: 2 }], count: 1 },
    { relations: [{ ...library.relations[0], text: '' }], count: 1 },
  ])('rejects malformed payloads: %j', (patch) => {
    expect(() => mapRelationsV2({ ...library, ...patch }, ids)).toThrow()
  })
  it('loads v2 as both the list library and navigable edges, in both directions', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith('relations.v5.json') ? library : runtime,
    ))))
    const data = await loadGalaxyData()
    expect(data.relationCount).toBe(1647)
    expect(data.curatedRelations).toHaveLength(1647)
    const first = library.relations[0]
    const reverse = makeRelationResolver(data).relationFor(first.t, first.s)
    expect(reverse).toMatchObject({ source: first.t, target: first.s, sentence: first.text, strength: first.strength, relationType: first.type })
  })
  it('leaves books without any shipped thread quietly unlinked', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith('relations.v5.json') ? library : runtime,
    ))))
    const data = await loadGalaxyData()
    const linked = new Set(library.relations.flatMap((record) => [record.s, record.t]))
    const unlinked = runtime.books.filter((book) => !linked.has(book.id))
    expect(unlinked.length).toBeGreaterThan(0)
    const resolver = makeRelationResolver(data)
    unlinked.forEach((book) => expect(resolver.optionsFor(book.id, new Set([book.id]))).toEqual([]))
  })
  it.each(['http', 'json', 'invalid'])('falls back to legacy relations after %s failure', async (failure) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (!url.endsWith('relations.v5.json')) return new Response(JSON.stringify(runtime))
      return failure === 'http' ? new Response('', { status: 404 })
        : new Response(failure === 'json' ? '{' : JSON.stringify({ schemaVersion: 'wrong' }))
    }))
    const data = await loadGalaxyData()
    expect(data.catalogEdges).toHaveLength(5385)
    expect(data.curatedRelations).toHaveLength(3002)
  })
})
