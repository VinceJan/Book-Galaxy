import { describe, expect, it } from 'vitest'
import type { Book, BookRelation } from '../types'
import { chooseRelations, hashString, otherBookId, positionForBook } from './galaxyMath'

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
