import { describe, expect, it } from 'vitest'
import type { Book, BookRelation } from '../types'
import { isSleepingStar, pickSleepingStar, rankSleepingStars } from './sleepingStars'

const summary = '书'.repeat(130)
const book = (id: string, popularity: number): Book => ({ id, title: id, author: '某人', themes: [], summary, popularity })
const books = [book('loud', 0.95), book('quiet', 0.05), book('mid', 0.5)]
const threads = [{ source: 'loud', target: 'mid' }] as BookRelation[]

describe('sleeping stars', () => {
  it('ranks low-attention, rarely linked books first', () => {
    expect(rankSleepingStars(books, threads).map((star) => star.book.id)).toEqual(['quiet', 'mid', 'loud'])
  })
  it('skips books whose lead is too short to wake', () => {
    const short = { ...book('short', 0), summary: '短' }
    expect(rankSleepingStars([...books, short], threads).some((star) => star.book.id === 'short')).toBe(false)
  })
  it('picks deterministically from the sleepy pool and honours exclusions', () => {
    expect(pickSleepingStar(books, threads, () => 0, { pool: 1 })?.id).toBe('quiet')
    expect(pickSleepingStar(books, threads, () => 0, { pool: 1, exclude: new Set(['quiet']) })?.id).toBe('mid')
  })
  it('marks the sleepiest third', () => {
    const ranked = rankSleepingStars(books, threads)
    expect(isSleepingStar(books[1], ranked)).toBe(true)
    expect(isSleepingStar(books[0], ranked)).toBe(false)
  })
})
