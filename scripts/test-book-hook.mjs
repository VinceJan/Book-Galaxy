#!/usr/bin/env node
// Guards the "no fabricated facts" contract of the offline hook: every hook
// must be assembled only from sentences of its own (bracket-stripped) lead.
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { bookHook, isRejectedSentence, splitSentences, stripBrackets } from './lib/book-hook.mjs'

const sample = '《甲书》（英语：Book A）是某作家1900年出版的小说。小说讲述了一位灯塔守望者的故事。该书曾被改编为电影。'
assert.equal(bookHook(sample), '小说讲述了一位灯塔守望者的故事。')
assert.equal(bookHook('《活着》是一部中国小说，作者余华，于1993年出版。'), '《活着》是一部中国小说，作者余华。')
assert.equal(isRejectedSentence('三明经，南传上座部佛教《巴利文大藏经》中的长部第十三部经。'), false)
assert.equal(isRejectedSentence('《娜娜》是法国作家左拉的《卢贡-马卡尔家族》系列作品的第九部。'), true)
assert.equal(isRejectedSentence('他经历了一系列冒险。'), false)
assert.equal(bookHook(''), '')

const runtime = JSON.parse(await readFile(new URL('../public/data/catalog.runtime.json', import.meta.url), 'utf8'))
const strip = stripBrackets
let failures = 0
let empty = 0
let gated = 0
assert.equal(isRejectedSentence('该书是《甲》系列的第一本作品，接着是《乙》（2012年）、《丙》（2013年）。'), true)
assert.equal(isRejectedSentence('小说讲述了一位灯塔守望者的故事。'), false)
for (const book of runtime.books) {
  const lead = strip(book.summary ?? '')
  const hook = (book.hook ?? '').replace(/……$/u, '')
  const pieces = splitSentences(hook)
  if (!book.hook) { empty += 1; continue }
  if ([...book.hook].length > 120 || pieces.some((piece) => !lead.includes(piece.replace(/……$/u, '').replace(/。$/u, '')))) {
    failures += 1
    if (failures <= 5) console.error(`hook not verbatim: ${book.id} ${book.title}: ${book.hook}`)
  }
  if (splitSentences(hook).some((piece) => isRejectedSentence(piece))) gated += 1
  for (const note of Object.values(book.notes ?? {})) {
    if (!lead.includes(note.replace(/[。！？]$/u, ''))) {
      failures += 1
      if (failures <= 5) console.error(`note not verbatim: ${book.id} ${book.title}: ${note}`)
    }
  }
}
assert.equal(failures, 0, `${failures} hooks are not verbatim spans of their lead`)
assert.equal(gated, 0, `${gated} hooks still carry gated sentences`)
console.log(`书页钩子检查通过：${runtime.books.length} 本，均为导语原句；${empty} 本无可用书页一瞥（改为展开导语全文）`)
