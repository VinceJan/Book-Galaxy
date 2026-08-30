import { describe, expect, it } from 'vitest'
import type { Book, BookRelation } from '../types'
import {
  chooseRelations,
  hashString,
  otherBookId,
  positionForBook,
  visualAttributesForBook,
} from './galaxyMath'

const book: Book = {
  id: 'three-body-problem',
  title: '三体',
  author: '刘慈欣',
  themes: ['文明', '宇宙'],
}

describe('galaxyMath', () => {
  it('keeps generated positions deterministic', () => {
    expect(positionForBook(book, 4, 20_000)).toEqual(positionForBook(book, 4, 20_000))
    expect(hashString('三体')).toBe(hashString('三体'))
  })

  it('trusts a valid precomputed semantic position and rejects malformed coordinates', () => {
    const positioned = { ...book, position: [-12.5, 3.25, 44] as const }
    expect(positionForBook(positioned, 4, 20_000)).toEqual([-12.5, 3.25, 44])

    const malformed = { ...book, position: [Number.NaN, 3.25, 44] as const }
    expect(positionForBook(malformed, 4, 20_000)).toEqual(positionForBook(book, 4, 20_000))
  })

  it('keeps visual attributes stable, bounded, and meaningfully varied', () => {
    const visuals = Array.from({ length: 1_000 }, (_, index) => visualAttributesForBook({
      ...book,
      id: `book-${index}`,
      themes: [`theme-${index % 17}`, '文学'],
    }, index))
    expect(visuals[17]).toEqual(visualAttributesForBook({
      ...book,
      id: 'book-17',
      themes: ['theme-0', '文学'],
    }, 17))

    visuals.forEach((visual) => {
      expect(visual.size).toBeGreaterThanOrEqual(1.24)
      expect(visual.size).toBeLessThanOrEqual(6.54)
      expect(visual.magnitude).toBeGreaterThanOrEqual(0)
      expect(visual.magnitude).toBeLessThanOrEqual(1)
      expect(visual.density).toBeGreaterThanOrEqual(0)
      expect(visual.density).toBeLessThanOrEqual(1)
      expect(visual.outlier).toBeGreaterThanOrEqual(0)
      expect(visual.outlier).toBeLessThanOrEqual(1)
      expect(visual.halo).toBeGreaterThanOrEqual(0)
      expect(visual.halo).toBeLessThanOrEqual(1)
      expect(visual.shape).toBeGreaterThanOrEqual(0)
      expect(visual.shape).toBeLessThanOrEqual(1)
      expect(visual.temperature).toBeGreaterThanOrEqual(0)
      expect(visual.temperature).toBeLessThanOrEqual(1)
    })

    const sizes = visuals.map(({ size }) => size).sort((left, right) => left - right)
    expect(sizes[Math.floor(sizes.length * 0.9)] / sizes[Math.floor(sizes.length * 0.1)]).toBeGreaterThanOrEqual(2.5)
    expect(sizes[sizes.length - 1] / sizes[0]).toBeLessThan(8)

    const shapeCounts = visuals.reduce((counts, visual) => {
      const bucket = visual.shape < 0.55 ? 'soft' : visual.shape < 0.73 ? 'cross' : visual.shape < 0.93 ? 'double' : 'ring'
      counts[bucket] += 1
      return counts
    }, { soft: 0, cross: 0, double: 0, ring: 0 })
    expect(shapeCounts.soft / visuals.length).toBeGreaterThan(0.48)
    expect(shapeCounts.soft / visuals.length).toBeLessThan(0.62)
    expect(shapeCounts.cross / visuals.length).toBeGreaterThan(0.12)
    expect(shapeCounts.cross / visuals.length).toBeLessThan(0.24)
    expect(shapeCounts.double / visuals.length).toBeGreaterThan(0.14)
    expect(shapeCounts.double / visuals.length).toBeLessThan(0.26)
    expect(shapeCounts.ring / visuals.length).toBeGreaterThan(0.03)
    expect(shapeCounts.ring / visuals.length).toBeLessThan(0.12)
  })

  it('selects distinct semantic distances and avoids visited books', () => {
    const relations: BookRelation[] = [0.35, 0.68, 0.86, 0.94].map((surprise, index) => ({
      source: 'three-body-problem',
      target: `book-${index}`,
      kind: '回声',
      sentence: '测试关系',
      basis: ['测试'],
      confidence: 0.9,
      surprise,
    }))
    relations.push({ ...relations[0], source: 'book-0', target: 'three-body-problem' })
    const selected = chooseRelations(relations, 'three-body-problem', new Set(['book-3']))
    expect(selected).toHaveLength(3)
    expect(selected.some((relation) => relation.target === 'book-3')).toBe(false)
    expect(new Set(selected.map((relation) => otherBookId(relation, 'three-body-problem'))).size).toBe(3)
    expect(selected[0].surprise).toBeGreaterThanOrEqual(0.2)
    expect(selected[0].surprise).toBeLessThanOrEqual(0.45)
    expect(selected[1].surprise).toBeGreaterThanOrEqual(0.55)
    expect(selected[1].surprise).toBeLessThanOrEqual(0.78)
    expect(selected[2].surprise).toBeGreaterThanOrEqual(0.8)
    expect(selected[2].surprise).toBeLessThanOrEqual(1)
  })
})
