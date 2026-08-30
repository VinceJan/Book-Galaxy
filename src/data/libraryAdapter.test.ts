import { describe, expect, it } from 'vitest'
import { normalizeLibraryRecord } from './libraryAdapter'

describe('normalizeLibraryRecord', () => {
  it('normalizes common Chinese library fields', () => {
    const result = normalizeLibraryRecord({
      题名: '百年孤独',
      作者: '加西亚·马尔克斯',
      ISBN: '978-7-02-000872-7',
      主题词: ['魔幻现实主义', '家族史'],
      语种: '中文',
      馆藏号: 'I775.45/1',
      来源链接: 'https://library.example.org/record/1001',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.book.title).toBe('百年孤独')
    expect(result.book.author).toBe('加西亚·马尔克斯')
    expect(result.book.themes).toEqual(['魔幻现实主义', '家族史'])
    expect(result.book.language).toBe('中文')
    expect(result.book.collectionNumber).toBe('I775.45/1')
    expect(result.book.callNumber).toBe('I775.45/1')
    expect(result.book.sourceUrl).toBe('https://library.example.org/record/1001')
  })

  it('accepts English aliases and keeps a stable ISBN id', () => {
    const first = normalizeLibraryRecord({
      title: 'Pride and Prejudice',
      author: 'Jane Austen',
      isbn13: '978 014 143951 8',
      subjects: 'marriage; society',
      language: 'en',
      call_no: 'PR4034.A2',
      source_url: 'https://catalog.example.org/books/42',
    })
    const reordered = normalizeLibraryRecord({
      author: 'Jane Austen',
      title: 'Pride and Prejudice',
      ISBN: '978-0141439518',
    })

    expect(first.ok).toBe(true)
    expect(reordered.ok).toBe(true)
    if (!first.ok || !reordered.ok) return
    expect(first.book.id).toBe('library-isbn-9780141439518')
    expect(reordered.book.id).toBe(first.book.id)
    expect(first.book.themes).toEqual(['marriage', 'society'])
    expect(first.book.callNumber).toBe('PR4034.A2')
  })

  it('prefers an explicit stable record id when ISBN is absent', () => {
    const first = normalizeLibraryRecord({ title: '书', author: '甲', recordId: 'bib-009' })
    const second = normalizeLibraryRecord({ title: '换个写法', author: '乙', record_id: 'bib-009' })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.book.id).toBe(second.book.id)
    expect(first.book.recordId).toBe('bib-009')
  })

  it('returns explicit errors for incomplete records', () => {
    const missingTitle = normalizeLibraryRecord({ author: '作者' })
    const missingAuthor = normalizeLibraryRecord({ title: '书名' })

    expect(missingTitle).toEqual({ ok: false, error: '缺少书名或题名（title）', field: 'title' })
    expect(missingAuthor).toEqual({ ok: false, error: '缺少作者或著者（author）', field: 'author' })
  })

  it('rejects dangerous or non-HTTPS source URLs', () => {
    for (const sourceUrl of ['javascript:alert(1)', 'http://catalog.example.org/book/1', 'data:text/plain,book', 'https://user:secret@catalog.example.org/book/1']) {
      const result = normalizeLibraryRecord({ title: '书', author: '作者', sourceUrl })
      expect(result).toEqual({ ok: false, error: '来源链接必须是有效的 HTTPS 地址', field: 'sourceUrl' })
    }
  })
})
