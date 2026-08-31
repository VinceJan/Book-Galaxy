import { afterEach, describe, expect, it, vi } from 'vitest'
import { chartJourneyHops, chartRelationLine, renderStarChart, type StarChartInput } from './starChart'
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

function renderedText(input: StarChartInput): string[] {
  const drawn: string[] = []
  const context = {
    font: '',
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    fillRect: () => undefined,
    strokeRect: () => undefined,
    measureText: (text: string) => ({ width: [...text].length * 12 }),
    fillText: (text: string) => drawn.push(text),
    save: () => undefined,
    restore: () => undefined,
    setLineDash: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    bezierCurveTo: () => undefined,
    stroke: () => undefined,
    arc: () => undefined,
    fill: () => undefined,
    roundRect: () => undefined,
  } as unknown as CanvasRenderingContext2D
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toDataURL: () => 'data:image/png;base64,test',
  }
  vi.stubGlobal('document', { createElement: () => canvas })
  renderStarChart(input)
  return drawn
}

afterEach(() => vi.unstubAllGlobals())

describe('chartRelationLine', () => {
  const departure = book('departure', '出发星')
  const arrival = book('arrival', '远方书星')

  it.each(['semantic', 'catalog'] as const)('records %s hops without exposing generated prose', (provenance) => {
    const sentinel = '禁止泄露的算法模板句 SENTINEL-CHART-9182'
    const hop = relation(provenance, sentinel)
    hop.kind = '回声'
    hop.basis = ['人物命运']
    const line = chartRelationLine(hop, departure, arrival)

    expect(line).toBe('从《出发星》抵达《远方书星》。')
    expect(line).not.toContain(sentinel)
    expect(line).not.toContain(hop.kind)
    expect(line).not.toContain(hop.basis[0])
  })

  it('keeps an authored reading hypothesis byte-for-byte intact', () => {
    const sentence = '  《出发星》把旧日的火交给《远方书星》，两页在夜色里彼此照见。  '

    expect(chartRelationLine(relation('reading-hypothesis', sentence), departure, arrival)).toBe(sentence)
  })
})

describe('chartJourneyHops', () => {
  it('maps only same-index adjacent endpoints, accepting either direction and omitting mismatches', () => {
    const books = [book('a', '甲'), book('b', '乙'), book('c', '丙'), book('d', '丁')]
    const authored = '  原句保留首尾空格。  '
    const reversedAuthored = { ...relation('reading-hypothesis', authored), source: 'b', target: 'a' }
    const reversedSemantic = { ...relation('semantic', 'SENTINEL-SEMANTIC'), source: 'c', target: 'b' }
    reversedSemantic.kind = '裂隙'
    reversedSemantic.basis = ['SENTINEL-BASIS']
    const misalignedCatalog = { ...relation('catalog', 'SENTINEL-MISALIGNED'), source: 'a', target: 'd' }
    const relations = [reversedAuthored, reversedSemantic, misalignedCatalog]

    const hops = chartJourneyHops(books, relations)

    expect(hops).toEqual([
      { relation: reversedAuthored, departure: books[0], arrival: books[1] },
      { relation: reversedSemantic, departure: books[1], arrival: books[2] },
    ])

    const drawn = renderedText({ books, relations, title: '混合航迹', date: new Date('2026-01-02') })
    expect(drawn).toContain(authored)
    expect(drawn).toContain('从《乙》抵达《丙》。')
    expect(drawn).toContain('引力书线 · 02 段航迹')
    expect(drawn.join('')).not.toContain('SENTINEL')
    expect(drawn.join('')).not.toContain('裂隙')
  })

  it('renders every valid hop in the dense long-journey fallback', () => {
    const books = Array.from({ length: 7 }, (_, index) => book(`book-${index}`, `书${index}`))
    const relations = books.slice(0, -1).map((_, index) => {
      const authored = `第${index + 1}段原句。`
      const hop = relation(index % 2 === 0 ? 'reading-hypothesis' : 'semantic', authored)
      hop.source = `book-${index + 1}`
      hop.target = `book-${index}`
      if (index === 3) {
        hop.source = 'book-0'
        hop.target = 'book-6'
        hop.sentence = 'SENTINEL-LONG-MISMATCH'
      }
      return hop
    })

    const drawn = renderedText({ books, relations, title: '长途航迹', date: new Date('2026-01-02') })

    expect(drawn).toContain('第1段原句。')
    expect(drawn).toContain('从《书1》抵达《书2》。')
    expect(drawn).toContain('第3段原句。')
    expect(drawn).toContain('第5段原句。')
    expect(drawn).toContain('从《书5》抵达《书6》。')
    expect(drawn).toContain('引力书线 · 05 段航迹')
    expect(drawn.join('')).not.toContain('SENTINEL-LONG-MISMATCH')
  })
})
