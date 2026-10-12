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
    const text = [offlineTransitionNote(relation, from, to).lead, ...offlineTransitionNote(relation, from, to).lines].join('')
    expect(text).toContain('阶级与贫困')
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

describe('regionSpeaksTo', () => {
  it('only when the book is in the region and shares vocabulary', async () => {
    const { regionSpeaksTo } = await import('./offlineCurator')
    const region = { name: '贫穷街区', subtitle: '阶级与城市', question: '谁在底层？', bookIds: ['b'] }
    expect(regionSpeaksTo(to, region)).toBe(true)
    expect(regionSpeaksTo(to, { ...region, subtitle: '星舰', name: '远港' })).toBe(false)
    expect(regionSpeaksTo(to, { ...region, bookIds: [] })).toBe(false)
  })
})
