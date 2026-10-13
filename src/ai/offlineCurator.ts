import type { Book, BookRelation } from '../types'

/**
 * The offline librarian.
 *
 * It answers without any server, and it never invents a fact: every clause is
 * either a verbatim span of the book's lead (the hook), a catalog value
 * (author, year, country, theme), or a fixed editorial frame around them.
 */

const GENERIC_THEME = /^(?:\d+世纪作品|文本叙事|作品语境|.{1,6}文学)$/u

/** Catalog-wide umbrella tags; true of many books, so never offered as the reason two met. */
const BROAD_THEME = /^(?:科学与技术|文明与未来|神话与超自然|哲学与信仰|权力与政治|宗教经典|历史记忆|文本叙事|作品语境)$/u

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

/** Show a region's question only when the book belongs there and shares its vocabulary. */
export function regionSpeaksTo(book: Book, region: { name: string; subtitle?: string; question: string; bookIds: string[] } | undefined): boolean {
  if (!region || !region.bookIds.includes(book.id)) return false
  const place = `${region.name}${region.subtitle ?? ''}${region.question}`
  return meaningfulThemes(book).some((theme) => {
    const chars = [...theme]
    for (let index = 0; index + 1 < chars.length; index += 1) if (place.includes(chars[index] + chars[index + 1])) return true
    return chars.length === 1 && place.includes(theme)
  })
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
  // The hook is already on the page (书页一瞥); the librarian never reads it back.
  void hook
  const lead = pick([
    `《${book.title}》——我替它记着几句原话，不多，但都是馆藏里写着的。`,
    `你停在《${book.title}》前面了。我不替书下结论，只把架上的句子递给你。`,
    `这颗星我认得。关于《${book.title}》，我只说导语里有的话。`,
  ], book.id)
  return { lead, lines }
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

type RegionLike = { name: string; subtitle?: string; question: string; bookIds: string[] }

export interface TransitionContext {
  fromRegion?: RegionLike
  toRegion?: RegionLike
}

const short = (text: string | undefined, max = 64) => (text && [...text].length <= max ? text.replace(/。$/u, '') : undefined)

/** Chinese genre label from Wikidata instance-of, or undefined for English-only labels. */
function genre(book: Book): string | undefined {
  // Only labels that name a kind of book (佛经, 漫画小说, 词典…); bibliographic ones
  // (书面作品, 多卷作品, 四六版…) say nothing. 文学作品 is the plain counterpart.
  const labels = (book.instanceOf ?? []).map((item) => item.label).filter((label) => /[\u3400-\u9fff]/u.test(label))
  const specific = labels.find((label) => /经|漫画|专著|非小说|往世书|史[诗詩]|词典|辞典|哲学|历史书|工具书|诗|剧|小说|散文|随笔|传记|回忆录|论文|教科书|百科/u.test(label))
  return specific ?? (labels.includes('文学作品') ? '文学作品' : undefined)
}

function gapPhrase(gap: number): string {
  if (gap < 8) return '它们几乎写于同一时期'
  if (gap < 100) return `两本书相隔约 ${gap} 年`
  const centuries = Math.round(gap / 100)
  const words = ['', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十']
  return centuries <= 10 ? `两本书隔着约${words[centuries]}个世纪` : `两本书相隔约 ${gap} 年`
}

/**
 * A far jump, in the librarian's voice. Every clause still comes from data:
 * region names and questions, catalog themes, years, places, languages,
 * Wikidata genre, verbatim lead sentences and the star's density on the map.
 * What varies is which of these this particular pair actually has.
 */
function farNote(relation: BookRelation, from: Book | undefined, to: Book | undefined, context: TransitionContext): OfflineNote {
  const seed = `${from?.id ?? ''}>${to?.id ?? ''}`
  const lines: string[] = []
  const fromRegion = context.fromRegion
  const toRegion = context.toRegion
  const crossed = fromRegion && toRegion && fromRegion.name !== toRegion.name

  let lead: string
  if (crossed) {
    lead = pick([
      `这一跳越过了半片星海：从「${fromRegion.name}」到「${toRegion.name}」。`,
      `你离开「${fromRegion.name}」，落在「${toRegion.name}」。`,
      `「${fromRegion.name}」已经在身后，这里是「${toRegion.name}」。`,
    ], seed)
  } else if (toRegion && fromRegion) {
    // Same region on the map, far apart in content: say exactly that.
    lead = `同在「${toRegion.name}」，内容上却离得很远。`
  } else {
    lead = pick([
      `从《${from?.title ?? '出发星'}》到《${to?.title ?? '远方书星'}》，中间几乎没有路标。`,
      `《${to?.title ?? '远方书星'}》离《${from?.title ?? '出发星'}》很远，远到书线只剩一根。`,
    ], seed)
  }

  if (from && to) {
    // Why it is far: each side's own concern, then whatever thin thread remains.
    const shared = new Set(sharedThemes(relation, from, to))
    const own = (book: Book) => meaningfulThemes(book).find((theme) => !shared.has(theme) && !BROAD_THEME.test(theme))
    const mine = own(from)
    const theirs = own(to)
    if (mine && theirs && mine !== theirs) {
      lines.push(pick([
        `一边是「${mine}」，一边是「${theirs}」，几乎没有重叠。`,
        `《${from.title}》落在「${mine}」，《${to.title}》落在「${theirs}」。`,
      ], `${seed}:themes`))
    }
    const thread = [...shared].filter((theme) => !GENERIC_THEME.test(theme))
    const specific = thread.find((theme) => !BROAD_THEME.test(theme))
    if (specific) lines.push(`它们之间只剩一根细线：「${specific}」。`)
    else if (thread[0]) lines.push(`唯一的交集是一个很宽的词：「${thread[0]}」，宽到不足以解释这一跳。`)

    const facts: string[] = []
    if (Number.isInteger(from.year) && Number.isInteger(to.year) && from.year && to.year) {
      facts.push(gapPhrase(Math.abs((to.year as number) - (from.year as number))))
    }
    // A change of kind (佛经 → 小说) says more than a change of country, so it ranks first.
    const kindA = genre(from)
    const kindB = genre(to)
    if (kindA && kindB && kindA !== kindB && (kindA !== '文学作品' || kindB !== '文学作品')) facts.push(`一部是${kindA}，一部是${kindB}`)
    const place = placePhrase(from, to)
    if (place && !place.startsWith('同样')) facts.push(place)
    else {
      const a = known(from.language)
      const b = known(to.language)
      if (a && b && a !== b) facts.push(`一本以${a}写成，一本以${b}写成`)
    }
    if (facts.length > 0) lines.push(`${facts.slice(0, 2).join('，')}。`)

    const fromQuote = short(quotableNote(from, ['idea', 'story', 'setting']))
    const toQuote = short(quotableNote(to, ['idea', 'story', 'setting']))
    if (fromQuote && toQuote) lines.push(`对读：「${fromQuote}」——「${toQuote}」`)
    else if (toQuote) lines.push(`到了这里，导语写着：「${toQuote}」`)
  }

  // The region's own question is already shown under the band; not repeated here.
  if (to && ((to.outlierScore ?? 0) >= 0.7 || (to.localDensity ?? 1) <= 0.2)) {
    lines.push(pick(['它在星域的边缘，四周很少有书。', '它身边很空，很少有书线经过。'], `${seed}:edge`))
  }
  const signOff = pick([
    '说实话，这一跳连我也没料到，这正是我喜欢的部分。',
    '离家很远了。别急着找路标，先读第一页。',
    '我不保证你会喜欢它，只保证你本来不会遇见它。',
    '远行的理由很少，所以每一条都值得细读。',
    '书线到这里很细了，剩下的要靠你读出来。',
    '若读不下去，回出发星只要一下；若读下去了，这就是你的发现。',
  ], `${seed}:sign`)
  return { lead, lines: [...lines.slice(0, 4), signOff] }
}

export function offlineTransitionNote(relation: BookRelation, from?: Book, to?: Book, context: TransitionContext = {}): OfflineNote {
  if (relation.distanceBand === 'far' && relation.provenance !== 'reading-hypothesis') return farNote(relation, from, to, context)
  const lines: string[] = []
  const themes = sharedThemes(relation, from, to)
  const meaningful = themes.filter((theme) => !GENERIC_THEME.test(theme))
  const facts = from && to ? [eraPhrase(from, to), placePhrase(from, to)].filter(Boolean) : []
  // Umbrella tags (科学与技术 on 《蝇王》) are too coarse to explain a jump, and a far
  // jump by definition shares little: say nothing rather than overclaim a bridge.
  const specific = meaningful.filter((theme) => !BROAD_THEME.test(theme))
  if (relation.distanceBand !== 'far' && specific.length > 0) lines.push(`它们共同经过「${specific.slice(0, 2).join('」与「')}」。`)
  if (facts.length > 0) lines.push(`${facts.join('，')}。`)
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
  // The librarian's own voice: a sign-off about the trip, never a claim about the books.
  const seed = `${from?.id ?? ''}${to?.id ?? ''}`
  lines.push(pick(band === 'near' ? [
    '我常把它们放在同一层，你大概也会。',
    '近路走得快，不妨在这一本多停一会儿。',
  ] : band === 'mid' ? [
    '书线是我搭的，过不过河由你。',
    '这座桥我只搭一半，另一半等你读出来。',
  ] : [
    '说实话，这一跳连我也没料到——这正是我喜欢的部分。',
    '离家很远了。别急着找路标，先读第一页。',
    '我不保证你会喜欢它，只保证你本来不会遇见它。',
  ], seed))
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
  context: { relation?: BookRelation; from?: Book; to: Book; nearest?: Book; sleeping?: boolean } & TransitionContext,
): string {
  const { relation, from, to, nearest } = context
  if (question === 'about') {
    const more = quotableNote(to, ['story', 'setting', 'idea'])
    if (more) return `书页一瞥之外，导语再往下读是：「${more.replace(/。$/u, '')}」`
    return `关于《${to.title}》，馆藏导语只有书页上那一句——我不往下编。想读全文，出处链接就在书页底部。`
  }
  if (question === 'why') {
    if (!relation) return `《${to.title}》还没有前一站。偏航一次，馆员就能说说两本书为何相遇。`
    const note = offlineTransitionNote(relation, from, to, context)
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
