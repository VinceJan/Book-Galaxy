import { describe, expect, it } from 'vitest'
import {
  buildVoyageShareUrl,
  encodeVoyageRoute,
  parseVoyageRoute,
  readVoyageRouteFromSearch,
  resolveVoyageRoute,
} from './voyageRoute'

describe('voyageRoute', () => {
  it('encodes and parses comma-separated book ids', () => {
    expect(encodeVoyageRoute(['Q1', 'Q2', 'Q3'])).toBe('Q1,Q2,Q3')
    expect(parseVoyageRoute('Q1,Q2,Q3')).toEqual(['Q1', 'Q2', 'Q3'])
    expect(parseVoyageRoute('Q1, bad, Q1, Q2')).toEqual(['Q1', 'Q2'])
    expect(parseVoyageRoute('')).toEqual([])
  })

  it('reads ?route from a search string', () => {
    expect(readVoyageRouteFromSearch('?route=Q11,Q22')).toEqual(['Q11', 'Q22'])
    expect(readVoyageRouteFromSearch('foo=1&route=Q9')).toEqual(['Q9'])
    expect(readVoyageRouteFromSearch('')).toEqual([])
  })

  it('builds a shareable path without mechanical metadata', () => {
    expect(buildVoyageShareUrl(['Q1', 'Q2'], { origin: 'https://example.com', pathname: '/Book-Galaxy/' }))
      .toBe('/Book-Galaxy/?route=Q1,Q2')
    expect(buildVoyageShareUrl([], { origin: 'https://example.com', pathname: '/' })).toBeUndefined()
  })

  it('drops unknown ids when resolving against the catalog', () => {
    expect(resolveVoyageRoute(['Q1', 'Qx', 'Q2'], new Set(['Q1', 'Q2']))).toEqual(['Q1', 'Q2'])
  })
})
