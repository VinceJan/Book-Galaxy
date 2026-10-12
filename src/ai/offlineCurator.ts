import type { Book, BookRelation } from '../types'

/**
 * The offline librarian.
 *
 * It answers without any server, and it never invents a fact: every clause is
 * either a verbatim span of the book's lead (the hook), a catalog value
 * (author, year, country, theme), or a fixed editorial frame around them.
 */

const GENERIC_THEME = /^(?:\d+世纪作品|文本叙事|作品语境|.{1,6}文学)$/u

export function meaningfulThemes(book: Book): string[] {
  return book.themes.map((theme) => theme.trim()).filter((theme) => theme && !GENERIC_THEME.test(theme))
}

const known = (value: string | null | undefined) => {
  const text = value?.trim()
  return text && !/^(?:未注明|未知|不详)$/u.test(text) ? text : undefined
}

function years(book: Book): string | undefined {
  if (typeof book.year !== 'number' || !Number.isInteger(book.year) || book.year === 0) return undefined
  return book.year < 0 ? `公元前 ${Math.abs(book.year)} 年` : `${book.year} 年`
}

function pick<T>(items: readonly T[], seed: string): T {
  let hash = 2166136261
  for (const character of seed) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619)
  return items[Math.abs(hash) % items.length]
}

export function bookHookText(book: Book): string {
  return book.hook?.trim() || ''
}

/** A verbatim lead sentence the librarian can quote, best first. */
export function quotableNote(book: Book, prefer: Array<'story' | 'setting' | 'idea'> = ['story', 'setting', 'idea']): string | undefined {
  for (const kind of prefer) {
    const note = book.notes?.[kind]?.trim()
    if (note) return note
  }
  return undefined
}

export interface OfflineNote {
  lead: string
  lines: string[]
}

export function offlineBookNote(book: Book, options: { sleeping?: boolean; nearest?: Book } = {}): OfflineNote {
  const hook = bookHookText(book)
  const year = years(book)
  const themes = meaningfulThemes(book)
  const lines: string[] = []
  const origin = [known(book.country), year].filter(Boolean).join('，')
  if (origin) lines.push(`它来自${origin}，由${book.author}写下。`)
  if (themes.length > 0) lines.push(`读它时，可以把注意力放在「${themes.slice(0, 2).join('」与「')}」上。`)
  const quote = quotableNote(book)
  if (quote) lines.push(`导语里还写着：「${quote.replace(/。$/u, '')}」`)
  if (options.sleeping) lines.push(pick([
    '这颗星很少被人造访。今晚，你是它的第一位来客。',
    '它在星海里安静了很久，很少有书线经过这里。',
    '很少有人从这里出发——这正是它值得一读的理由。',
  ], book.id))
  if (options.nearest) lines.push(`如果想留在附近，《${options.nearest.title}》离它最近。`)
  return { lead: hook || `你正在观测《${book.title}》。`, lines }
}

function eraPhrase(from: Book, to: Book): string | undefined {
  if (!Number.isInteger(from.year) || !Number.isInteger(to.year) || !from.year || !to.year) return undefined
  const gap = Math.abs((to.year as number) - (from.year as number))
  if (gap < 8) return '它们几乎写于同一时期'
  return `两本书相隔约 ${gap} 年`
}

function placePhrase(from: Book, to: Book): string | undefined {
  const a = known(from.country)
  const b = known(to.country)
  if (!a || !b) return undefined
  return a === b ? `同样来自${a}` : `从${a}到${b}`
}

export function sharedThemes(relation: BookRelation | undefined, from?: Book, to?: Book): string[] {
  const evidence = relation?.evidence?.sharedThemes
  const fromEvidence = Array.isArray(evidence) ? evidence.filter((item): item is string => typeof item === 'string') : []
  const derived = from && to ? from.themes.filter((theme) => to.themes.includes(theme)) : []
  return [...new Set([...fromEvidence, ...derived])].filter((theme) => theme.trim())
}

export function offlineTransitionNote(relation: BookRelation, from?: Book, to?: Book): OfflineNote {
  const lines: string[] = []
  const themes = sharedThemes(relation, from, to)
  const meaningful = themes.filter((theme) => !GENERIC_THEME.test(theme))
  const facts = from && to ? [eraPhrase(from, to), placePhrase(from, to)].filter(Boolean) : []
  if (meaningful.length > 0) lines.push(`它们共同经过「${meaningful.slice(0, 2).join('」与「')}」。`)
  else if (themes.length > 0) lines.push(`它们同属「${themes[0]}」的星群。`)
  if (facts.length > 0) lines.push(`${facts.join('，')}。`)
  const toHook = to ? bookHookText(to) : ''
  if (toHook) lines.push(`抵达处：${toHook}`)
  // Two verbatim lines side by side: the reader draws the connection.
  const fromQuote = from ? quotableNote(from, ['idea', 'story', 'setting']) : undefined
  const toQuote = to ? quotableNote(to, ['idea', 'story', 'setting']) : undefined
  if (fromQuote && toQuote) lines.push(`对读：「${fromQuote.replace(/。$/u, '')}」——「${toQuote.replace(/。$/u, '')}」`)
  const band = relation.distanceBand
  lines.push(band === 'near'
    ? '这是一段近路：熟悉的气息还在，只是换了一扇窗。'
    : band === 'mid'
      ? '这是一座桥：一半熟悉，一半陌生，正适合换一种目光。'
      : '这是一次远行：相遇的理由很少，所以每一条都值得细读。')
  const lead = relation.provenance === 'reading-hypothesis' && relation.sentence?.trim()
    ? relation.sentence.trim()
    : `从《${from?.title ?? '出发星'}》到《${to?.title ?? '远方书星'}》。`
  return { lead, lines }
}

export type OfflineQuestion = 'about' | 'why' | 'next'

export const offlineQuestions: Array<{ id: OfflineQuestion; label: string }> = [
  { id: 'about', label: '它讲了什么？' },
  { id: 'why', label: '为什么会相遇？' },
  { id: 'next', label: '下一站去哪？' },
]

export function offlineAnswer(
  question: OfflineQuestion,
  context: { relation?: BookRelation; from?: Book; to: Book; nearest?: Book; sleeping?: boolean },
): string {
  const { relation, from, to, nearest } = context
  if (question === 'about') {
    const hook = bookHookText(to)
    const more = quotableNote(to, ['story', 'setting', 'idea'])
    if (hook && more) return `馆藏导语这样写：${hook}再往下读：「${more.replace(/。$/u, '')}」`
    return hook ? `馆藏导语这样写：${hook}` : `《${to.title}》的导语还未显影，可以从出处链接读到全文。`
  }
  if (question === 'why') {
    if (!relation) return `《${to.title}》还没有前一站。偏航一次，馆员就能说说两本书为何相遇。`
    const note = offlineTransitionNote(relation, from, to)
    return [note.lead, ...note.lines.slice(0, 2)].join('')
  }
  const themes = meaningfulThemes(to)
  if (nearest) {
    return themes.length > 0
      ? `若想留在「${themes[0]}」附近，去《${nearest.title}》；若想走远一点，点「从这里偏航」，选“远”。`
      : `若想留在附近，去《${nearest.title}》；若想走远一点，点「从这里偏航」，选“远”。`
  }
  return '点「从这里偏航」，让距离替你决定下一本。'
}
