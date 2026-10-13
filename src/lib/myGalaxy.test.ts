import { describe, expect, it } from 'vitest'
import { galaxyStats, parseMyGalaxy, upsertTrail } from './myGalaxy'

describe('my galaxy storage', () => {
  it('ignores corrupt or foreign data', () => {
    expect(parseMyGalaxy('{oops').trails).toEqual([])
    expect(parseMyGalaxy(JSON.stringify({ version: 9, trails: [] })).trails).toEqual([])
  })
  it('upserts the current trail instead of duplicating it', () => {
    let galaxy = parseMyGalaxy(null)
    galaxy = upsertTrail(galaxy, { id: 't1', bookIds: ['a'] })
    expect(galaxy.trails).toHaveLength(0)
    galaxy = upsertTrail(galaxy, { id: 't1', bookIds: ['a', 'b'] })
    galaxy = upsertTrail(galaxy, { id: 't1', bookIds: ['a', 'b', 'c'] })
    galaxy = upsertTrail(galaxy, { id: 't2', bookIds: ['c', 'd'] })
    expect(galaxy.trails.map((trail) => trail.bookIds.length)).toEqual([3, 2])
    expect(galaxyStats(galaxy)).toEqual({ trails: 2, stars: 4 })
  })
  it('drops ids that are no longer in the catalog', () => {
    const raw = JSON.stringify({ version: 1, trails: [{ id: 't', startedAt: '', updatedAt: '', bookIds: ['a', 'gone', 'b'] }] })
    expect(parseMyGalaxy(raw, new Set(['a', 'b'])).trails[0].bookIds).toEqual(['a', 'b'])
  })
})
