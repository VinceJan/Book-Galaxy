import { describe, expect, it } from 'vitest'
import { chartRelationLine } from './starChart'
import type { Book, BookRelation } from '../types'

const book = (id: string, title: string): Book => ({ id, title, author: '作者', themes: [] })

const relation = (provenance: BookRelation['provenance'], sentence: string): BookRelation => ({
  source: 'departure',
  target: 'arrival',
  kind: '暗河',
  sentence,
  basis: ['主题'],
  surprise: 0.7,
  confidence: 0.8,
  provenance,
})

describe('chartRelationLine', () => {
  const departure = book('departure', '出发星')
  const arrival = book('arrival', '远方书星')

  it('records semantic hops without exposing generated prose', () => {
    const sentinel = '禁止泄露的算法模板句 SENTINEL-CHART-9182'
    const line = chartRelationLine(relation('semantic', sentinel), departure, arrival)

    expect(line).toBe('从《出发星》抵达《远方书星》。')
    expect(line).not.toContain(sentinel)
  })

  it('keeps an authored reading hypothesis intact', () => {
    const sentence = '《出发星》把旧日的火交给《远方书星》，两页在夜色里彼此照见。'

    expect(chartRelationLine(relation('reading-hypothesis', sentence), departure, arrival)).toBe(sentence)
  })

  it('semantic chart output omits curated kind/basis and curated payload keeps exact shape', () => {
    const semanticKind = '回声' as const
    const semantic = relation('semantic', 'SENTINEL-CHART-KIND')
    semantic.kind = semanticKind
    semantic.basis = ['人物命运']
    // chartRelationLine for semantic must not leak sentence/basis/kind; it returns navigation route
    const line = chartRelationLine(semantic, departure, arrival)
    expect(line).not.toContain(semanticKind)
    expect(line).not.toContain('人物命运')
    expect(line).not.toContain('SENTINEL')
    const curatedSentence = '《出发星》在旧港口等潮汐，《远方书星》把同一个问题推向另一片夜色。'
    const curated = relation('reading-hypothesis', curatedSentence)
    curated.kind = '暗河'
    curated.basis = ['主题', '叙事结构']
    expect(chartRelationLine(curated, departure, arrival)).toBe(curatedSentence)
  })
})
