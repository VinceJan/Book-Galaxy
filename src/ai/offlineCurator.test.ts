import { describe, expect, it } from 'vitest'
import type { Book, BookRelation } from '../types'
import { meaningfulThemes, offlineAnswer, offlineBookNote, offlineTransitionNote } from './offlineCurator'

const from: Book = { id: 'a', title: '甲', author: '甲作者', year: 1900, country: '法国', themes: ['阶级与贫困', '19世纪作品'], hook: '甲讲述了一座城。' }
const to: Book = { id: 'b', title: '乙', author: '乙作者', year: 1960, country: '美国', themes: ['阶级与贫困', '美国文学'], hook: '乙讲述了一条河。' }
const relation = { source: 'a', target: 'b', kind: '暗河', basis: [], provenance: 'semantic', distanceBand: 'far', evidence: { sharedThemes: ['阶级与贫困'] } } as unknown as BookRelation

describe('offline librarian', () => {
  it('drops metadata-only themes', () => {
    expect(meaningfulThemes(to)).toEqual(['阶级与贫困'])
  })
  it('builds a book note only from catalog values and the verbatim hook', () => {
    const note = offlineBookNote(to, { sleeping: true, nearest: from })
    expect([note.lead, ...note.lines].join('')).not.toContain('乙讲述了一条河')
    expect(note.lines.join('')).toContain('美国，1960 年')
    expect(note.lines.join('')).toContain('《甲》')
  })
  it('names shared themes, era gap and places for a transition', () => {
    const mid = { ...relation, distanceBand: 'mid' } as BookRelation
    expect(offlineTransitionNote(mid, from, to).lines.join('')).toContain('阶级与贫困')
    // A far jump never claims a shared bridge, nor does an umbrella tag.
    const text = [offlineTransitionNote(relation, from, to).lead, ...offlineTransitionNote(relation, from, to).lines].join('')
    expect(text).not.toContain('共同经过')
    const broad = { ...mid, evidence: { sharedThemes: ['科学与技术'] } } as unknown as BookRelation
    expect(offlineTransitionNote(broad, from, to).lines.join('')).not.toContain('科学与技术')
    expect(text).toContain('相隔约 60 年')
    expect(text).toContain('从法国到美国')
    expect(text).not.toContain('乙讲述了一条河。')
  })
  it('never names an unknown country', () => {
    const unknown = { ...to, country: '未注明' }
    expect(offlineTransitionNote(relation, from, unknown).lines.join('')).not.toContain('未注明')
    expect(offlineBookNote(unknown).lines.join('')).not.toContain('未注明')
  })
  it('quotes verbatim lead notes for one book and side by side for a jump', () => {
    const a = { ...from, notes: { idea: '甲探讨了城市。' } }
    const b = { ...to, notes: { story: '乙的主人公是渡船人。' } }
    expect(offlineBookNote(b).lines.join('')).toContain('「乙的主人公是渡船人」')
    expect(offlineTransitionNote(relation, a, b).lines.join('')).toContain('对读：「甲探讨了城市」——「乙的主人公是渡船人」')
    expect(offlineAnswer('about', { to: b })).toContain('再往下读')
  })
  it('answers preset questions without a server', () => {
    expect(offlineAnswer('about', { to })).not.toContain('乙讲述了一条河')
    expect(offlineAnswer('why', { to })).toContain('还没有前一站')
    expect(offlineAnswer('next', { to, nearest: from })).toContain('《甲》')
  })
})

describe('far drift note', () => {
  const regionA = { name: '忏悔谷', question: '人能被救赎吗？', bookIds: ['a'] }
  const regionB = { name: '机械群岛', question: '机器会做梦吗？', bookIds: ['b'] }
  const a: Book = { ...from, themes: ['城市生活', '阶级与贫困'], instanceOf: [{ id: 'Q1', label: '佛经' }] } as Book
  const b: Book = { ...to, themes: ['太空探索', '阶级与贫困'], instanceOf: [{ id: 'Q2', label: '文学作品' }], outlierScore: 0.9 } as Book

  it('names what was crossed and why it is far, from data only', () => {
    const note = offlineTransitionNote(relation, a, b, { fromRegion: regionA, toRegion: regionB })
    const text = [note.lead, ...note.lines].join('')
    expect(note.lead).toMatch(/忏悔谷.*机械群岛/u)
    expect(text).toContain('「城市生活」')
    expect(text).toContain('「太空探索」')
    expect(text).toContain('只剩一根细线：「阶级与贫困」')
    expect(text).toContain('一部是佛经，一部是文学作品')
    expect(text).toMatch(/边缘|很空/u)
    expect(text).not.toContain('共同经过')
    expect(text).not.toContain('乙讲述了一条河')
  })

  it('is honest when the only overlap is an umbrella tag, and in the same region', () => {
    const broad = { ...relation, evidence: { sharedThemes: ['科学与技术'] } } as unknown as BookRelation
    const same = offlineTransitionNote(broad, { ...from, themes: ['城市生活'] }, { ...to, themes: ['太空探索'] }, { fromRegion: regionB, toRegion: regionB })
    expect(same.lead).toBe('同在「机械群岛」，内容上却离得很远。')
    expect(same.lines.join('')).toContain('宽到不足以解释这一跳')
  })

  it('reads differently for different pairs and never edits the relation', () => {
    const frozen = Object.freeze({ ...relation, sentence: '原有书线文本。' }) as BookRelation
    const pairs = ['c', 'd', 'e', 'f', 'g', 'h'].map((id, index) => offlineTransitionNote(frozen, { ...from, id: `${id}1` }, { ...to, id, year: 1900 + index * 90 }, { fromRegion: regionA, toRegion: regionB }))
    expect(new Set(pairs.map((note) => note.lead)).size).toBeGreaterThan(1)
    expect(new Set(pairs.map((note) => note.lines.at(-1))).size).toBeGreaterThan(1)
    expect(frozen.sentence).toBe('原有书线文本。')
  })
})

describe('regionSpeaksTo', () => {
  it('only when the book is in the region and shares vocabulary', async () => {
    const { regionSpeaksTo } = await import('./offlineCurator')
    const region = { name: '贫穷街区', subtitle: '阶级与城市', question: '谁在底层？', bookIds: ['b'] }
    expect(regionSpeaksTo(to, region)).toBe(true)
    expect(regionSpeaksTo(to, { ...region, subtitle: '星舰', name: '远港' })).toBe(false)
    expect(regionSpeaksTo(to, { ...region, bookIds: [] })).toBe(false)
  })
})
