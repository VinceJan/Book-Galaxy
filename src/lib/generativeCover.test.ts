import { describe, expect, it } from 'vitest'
import type { Book } from '../types'
import { generativeCover } from './generativeCover'

const book = (id: string, title: string, themes: string[]): Book => ({ id, title, author: '某人', themes })

describe('generative cover', () => {
  it('is deterministic per book', () => {
    expect(generativeCover(book('Q1', '古船', ['中国文学']))).toEqual(generativeCover(book('Q1', '古船', ['中国文学'])))
  })
  it('sets short Chinese titles vertically and never uses a mid-string ellipsis', () => {
    expect(generativeCover(book('Q1', '古船', [])).vertical).toBe(true)
    const long = generativeCover(book('Q2', '加密朋克：互联网的自由和未来以及更多', []))
    expect(long.vertical).toBe(false)
    expect(long.title.endsWith('…')).toBe(true)
  })
  it('skips era-only themes when naming the region', () => {
    expect(generativeCover(book('Q3', '书', ['20世纪作品', '迁徙与乡土'])).region).toBe('迁徙与乡土')
  })
})
