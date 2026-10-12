#!/usr/bin/env node
// Guards the "no fabricated facts" contract of the offline hook: every hook
// must be assembled only from sentences of its own (bracket-stripped) lead.
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { bookHook, splitSentences } from './lib/book-hook.mjs'

const sample = '《甲书》（英语：Book A）是某作家1900年出版的小说。小说讲述了一位灯塔守望者的故事。该书曾被改编为电影。'
assert.equal(bookHook(sample), '《甲书》是某作家1900年出版的小说。小说讲述了一位灯塔守望者的故事。')
assert.equal(bookHook(''), '')

const runtime = JSON.parse(await readFile(new URL('../public/data/catalog.runtime.json', import.meta.url), 'utf8'))
const strip = (text) => text.replace(/（[^（）]*[A-Za-zÀ-ɏ\u0900-\u097f\u0600-\u06ff：:][^（）]*）/gu, '').replace(/\([^()]*\)/gu, '').replace(/\s+/gu, ' ')
let failures = 0
for (const book of runtime.books) {
  const lead = strip(book.summary ?? '')
  const hook = (book.hook ?? '').replace(/……$/u, '')
  const pieces = splitSentences(hook)
  if (!book.hook || [...book.hook].length > 120 || pieces.some((piece) => !lead.includes(piece.replace(/……$/u, '')))) {
    failures += 1
    if (failures <= 5) console.error(`hook not verbatim: ${book.id} ${book.title}: ${book.hook}`)
  }
}
assert.equal(failures, 0, `${failures} hooks are not verbatim spans of their lead`)
console.log(`书页钩子检查通过：${runtime.books.length} 本，均为导语原句`)
