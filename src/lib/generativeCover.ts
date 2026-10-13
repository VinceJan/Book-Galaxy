import type { CSSProperties } from 'react'
import type { Book } from '../types'

/**
 * Generative bookplate for books without an approved cover image.
 *
 * Deterministic from the book's id and its first meaningful theme, so a book
 * always wears the same plate and books of one cloud share a hue family.
 */

const GENERIC_THEME = /^(?:\d+世纪作品|文本叙事|作品语境)$/u

function hash(value: string): number {
  let result = 2166136261
  for (const character of value) result = Math.imul(result ^ character.codePointAt(0)!, 16777619)
  return result >>> 0
}

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface GenerativeCover {
  title: string
  vertical: boolean
  region: string
  hue: number
  constellation: Array<[number, number, number]>
  style: CSSProperties
}

export function coverRegion(book: Book): string {
  return book.themes.find((theme) => theme.trim() && !GENERIC_THEME.test(theme.trim()))?.trim()
    ?? book.themes[0]?.trim()
    ?? '书页'
}

export function generativeCover(book: Book): GenerativeCover {
  const region = coverRegion(book)
  // Hue family by region (cool teal → amber band keeps the plates on-brand),
  // with a small per-book drift so neighbours are not identical.
  const base = 150 + (hash(region) % 7) * 26
  const hue = (base + (hash(book.id) % 17) - 8 + 360) % 360
  const random = mulberry32(hash(`${book.id}:sky`))
  const constellation: Array<[number, number, number]> = Array.from({ length: 5 + Math.floor(random() * 3) }, () => [
    Math.round(14 + random() * 72),
    Math.round(12 + random() * 52),
    Number((0.7 + random() * 1.4).toFixed(2)),
  ])
  const cleaned = book.title.replace(/[（(][^）)]*[）)]/gu, '').replace(/[《》「」]/gu, '').trim() || book.title
  const characters = [...cleaned]
  const vertical = characters.length <= 4 && /^[\u3400-\u9fff]+$/u.test(cleaned)
  const title = characters.length > 14 ? `${characters.slice(0, 13).join('')}…` : cleaned
  return {
    title,
    vertical,
    region,
    hue,
    constellation,
    style: {
      '--plate-hue': String(hue),
      '--plate-title-size': characters.length <= 3 ? '1.5rem' : characters.length <= 6 ? '1.2rem' : '0.95rem',
    } as CSSProperties,
  }
}
