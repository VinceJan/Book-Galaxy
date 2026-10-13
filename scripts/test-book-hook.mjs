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
assert.equal(bookHook('《罗马书》，全称《使徒保罗达罗马人书》、《圣保禄宗徒致罗马人书》，意思是《保罗致罗马城基督徒的书信》。'), '')
assert.equal(bookHook('《海底两万里》，或译为《海底历险记》、《海底六万里》，法国科幻小说家儒勒·凡尔纳的代表作之一，是一部出色的科幻小说。'), '《海底两万里》，法国科幻小说家儒勒·凡尔纳的代表作之一，是一部出色的科幻小说。')
// A context-dependent sentence never stands alone.
assert.equal(bookHook('《甲》是某作家的小说。小说引来许多评论家的非议。同时这些非议或许也是因为此书描写了阶级的缘故。').includes('同时这些'), false)

// A clause is verbatim, or two verbatim spans in lead order (an alias run cut from between).
const fromLead = (clause, lead) => {
  if (lead.includes(clause)) return true
  const chars = [...clause]
  for (let k = 2; k < chars.length - 1; k += 1) {
    const head = chars.slice(0, k).join('')
    const at = lead.indexOf(head)
    if (at >= 0 && lead.indexOf(chars.slice(k).join(''), at + head.length) >= 0) return true
  }
  return false
}


assert.equal(bookHook('《甲书》是1900年创作、1901年出版的著作。该书主要论述指导如何通过阅读增进理解力。'), '该书主要论述指导如何通过阅读增进理解力。')
assert.equal(bookHook('该书讲述了北京一个回族家庭六十余年间的兴衰历史，是一个爱情悲剧。'), '该书讲述了北京一个回族家庭六十余年间的兴衰历史，是一个爱情悲剧。')
assert.equal(bookHook('保罗认为这些初代加拉太信徒不需要遵守摩西律法的规条。'), '保罗认为这些初代加拉太信徒不需要遵守摩西律法的规条。')
assert.equal(bookHook('《甲书》是一部长篇小说，于1900年出版，1901年再版。'), '《甲书》是一部长篇小说。')
assert.equal(bookHook('《甲书》是1900年创作、1901年出版的著作。该书讲述了一部电影的制作过程。'), '')
assert.equal(bookHook('《甲书》是1900年创作、1901年出版的著作。此书论述阅读的方法。'), '此书论述阅读的方法。')
assert.equal(bookHook('《致命中国》，台湾译为《致命中国：中共赤龙对人类社会的危害》。'), '')
assert.equal(bookHook('《群魔》系俄国作家陀思妥耶夫斯基的长篇小说，另译为《附魔者》。'), '《群魔》系俄国作家陀思妥耶夫斯基的长篇小说。')

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
  if ([...book.hook].length > 120 || pieces.some((piece) => piece.replace(/……$/u, '').replace(/[。！？]$/u, '').split(/[，；]/u).some((clause) => clause && !fromLead(clause, lead)))) {
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
