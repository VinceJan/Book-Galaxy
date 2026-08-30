import { afterEach, describe, expect, it, vi } from 'vitest'
import { askOnlineCurator, publicRelationContext } from './curator'
import type { Book, BookRelation } from '../types'

const relation = (provenance: BookRelation['provenance'], sentence: string): BookRelation => ({
  source: 'departure',
  target: 'arrival',
  kind: '回声',
  sentence,
  basis: ['人物命运', '叙事结构'],
  surprise: 0.8,
  confidence: 0.9,
  distanceBand: 'far',
  provenance,
})

const book = (index: number): Book => ({
  id: `book-${index}`,
  title: `书${index}`,
  author: `作者${index}`,
  themes: [`主题${index}`],
  summary: `不应发送的简介${index}`,
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('publicRelationContext', () => {
  it('does not send generated semantic prose to the online curator', () => {
    const sentinel = '禁止泄露的算法模板句 SENTINEL-CURATOR-3157'
    const payload = publicRelationContext(relation('semantic', sentinel))

    expect(JSON.stringify(payload)).not.toContain(sentinel)
    expect(payload).toEqual({ provenance: 'semantic', distanceBand: 'far' })
  })

  it('semantic payload omits curated kind/basis and curated payload keeps exact shape', () => {
    const semantic = relation('semantic', 'SENTINEL-KIND-OMIT')
    semantic.kind = '回声'
    semantic.basis = ['人物命运']
    const semanticPayload = publicRelationContext(semantic) as Record<string, unknown>
    expect(semanticPayload).not.toHaveProperty('kind')
    expect(semanticPayload).not.toHaveProperty('basis')
    expect(semanticPayload).not.toHaveProperty('sentence')
    expect(semanticPayload).toEqual({ provenance: 'semantic', distanceBand: 'far' })
    const sentence = '两部作品在人物选择与叙事结构上彼此照见。'
    const curated = relation('reading-hypothesis', sentence)
    curated.kind = '回声'
    curated.basis = ['人物命运', '叙事结构']
    const curatedPayload = publicRelationContext(curated) as Record<string, unknown>
    expect(curatedPayload).toMatchObject({ provenance: 'reading-hypothesis', kind: '回声', sentence, basis: ['人物命运', '叙事结构'] })
  })

  it('preserves an authored reading hypothesis', () => {
    const sentence = '两部作品在人物选择与叙事结构上彼此照见。'

    expect(publicRelationContext(relation('reading-hypothesis', sentence))).toMatchObject({
      provenance: 'reading-hypothesis',
      sentence,
      basis: ['人物命运', '叙事结构'],
    })
  })
})

describe('askOnlineCurator', () => {
  it('serializes only public semantic context and the last five journey stops', async () => {
    const sentinel = '禁止发送的语义关系句 SENTINEL-REQUEST-8841'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ answer: '馆员回信' }),
    })
    vi.stubEnv('VITE_AI_ENDPOINT', 'https://curator.example/ask')
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { setTimeout: () => 1, clearTimeout: () => undefined })

    const answer = await askOnlineCurator({
      question: '它们为什么会在这里相遇？',
      from: book(0),
      to: book(6),
      relation: relation('semantic', sentinel),
      journey: [1, 2, 3, 4, 5, 6].map(book),
    })

    expect(answer).toBe('馆员回信')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const serialized = String(init.body)
    expect(serialized).not.toContain(sentinel)
    expect(JSON.parse(serialized)).toEqual({
      question: '它们为什么会在这里相遇？',
      from: { title: '书0', author: '作者0', themes: ['主题0'] },
      to: { title: '书6', author: '作者6', themes: ['主题6'] },
      relation: { provenance: 'semantic', distanceBand: 'far' },
      journey: [2, 3, 4, 5, 6].map((index) => ({ title: `书${index}`, author: `作者${index}` })),
    })
  })
})
