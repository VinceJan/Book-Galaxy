/**
 * Deterministic 1–2 sentence "hook" extraction from the Chinese Wikipedia lead.
 *
 * Nothing is generated: the hook is always a verbatim span of the lead (minus
 * bracketed transliterations), chosen so that it says what the book is about
 * rather than when it was printed, translated, adapted or awarded.
 */

const PUBLISHING_NOISE = /出版|连载|发表|刊行|印行|发行|再版|译本|翻译|译者|获得|获颁|荣获|奖|改编|电影|电视|舞台剧|上映|销量|畅销|ISBN|版本|抄本|全集|评为|入选|提名|排行/u
const SECOND_HAND = /^在《|^当中|^其中|视为|认为是|评价|撰文|批评家|评论家|学者认为|被认为|誉为|称赞|赞誉|抄本/u
const CONTENT_SIGNAL = /内容以|讲述|描写|描述|叙述|刻画|记录|记述|探讨|论述|讨论|阐述|主人公|故事|围绕|以.{1,16}为(?:中心|主线|背景|题材)|认为|揭示|描绘|追溯|关于|控诉|批判|反思/u
const MAX_HOOK = 96
// Hard gate: series lists, sequel/adaptation news and release calendars are
// never a hook, whatever else the sentence says.
const HARD_REJECT = /续作|续集|前传|后传|外传|系列(?:的|中的)?第|系列作品|接着是|改编|动画|漫画|电视剧|电影|游戏|舞台剧|广播剧|上映|播出|首播|提名|获奖|奖项|销量|印数/u

export function isRejectedSentence(sentence) {
  const years = sentence.match(/\d{4}\s*年/gu)?.length ?? 0
  const titles = sentence.match(/《[^》]+》/gu)?.length ?? 0
  const open = sentence.indexOf('“')
  const close = sentence.indexOf('”')
  const quotes = (sentence.match(/“/gu)?.length ?? 0) !== (sentence.match(/”/gu)?.length ?? 0) || (close >= 0 && (open < 0 || close < open))
  return HARD_REJECT.test(sentence) || years >= 2 || titles >= 3 || quotes
}

export const stripBrackets = (text) => {
  let current = text
  // Repeat so nested brackets（丹尼尔（Ty Franck）的笔名）collapse too.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = current
      .replace(/（[^（）]*[A-Za-zÀ-ɏ\u0900-\u097f\u0600-\u06ff：:][^（）]*）/gu, '')
      .replace(/\([^()]*\)/gu, '')
    if (next === current) break
    current = next
  }
  return current.replace(/\s+/gu, ' ').trim()
}

export function splitSentences(text) {
  return (text.match(/[^。！？]+[。！？]?/gu) ?? [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => [...sentence].length >= 6)
}

function clip(sentence, max = MAX_HOOK) {
  const characters = [...sentence]
  if (characters.length <= max) return sentence
  // Cut at the last clause boundary so the hook never ends mid-word.
  const head = characters.slice(0, max).join('')
  const boundary = Math.max(head.lastIndexOf('，'), head.lastIndexOf('；'), head.lastIndexOf('、'))
  return `${(boundary > max * 0.45 ? head.slice(0, boundary) : head).replace(/[，；、：]$/u, '')}……`
}

export function scoreSentence(sentence, index) {
  let score = 0
  if (CONTENT_SIGNAL.test(sentence)) score += 3
  if (PUBLISHING_NOISE.test(sentence)) score -= 2
  if (SECOND_HAND.test(sentence)) score -= 3
  if (/^(?:该书|本书|此书|这部|小说|书中|全书|作品)/u.test(sentence)) score += 1
  score -= index * 0.35
  if ((sentence.match(/“/gu)?.length ?? 0) !== (sentence.match(/”/gu)?.length ?? 0)) score -= 5
  return score
}

export function bookHook(summary = '') {
  const sentences = splitSentences(stripBrackets(summary))
  if (sentences.length === 0) return ''
  const ranked = sentences
    .map((sentence, index) => ({ sentence, index, score: scoreSentence(sentence, index) - (isRejectedSentence(sentence) ? 100 : 0) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
  const best = ranked[0]
  const identity = sentences[0]
  const length = (value) => [...value].length
  let hook = best.score > 0 || best.index === 0 ? best.sentence : identity
  let start = hook === identity ? 0 : best.index
  // A content sentence that leans on a pronoun ("此书记录了他……") or opens
  // with the work itself reads best after the identity sentence that names it.
  const leansOnIdentity = /^(?:该|此|这|本|其|他|她|它|小说|书中|全书|故事|内容)/u.test(hook)
  if (start > 0 && length(identity) + length(hook) <= MAX_HOOK + 12
    && (leansOnIdentity || !PUBLISHING_NOISE.test(identity))) {
    hook = `${identity}${hook}`
  }
  // A very short hook ("该小说讲述了莉莉·巴特的故事。") keeps its next sentence.
  const next = sentences[start + 1]
  if (length(hook) < 28 && next && !PUBLISHING_NOISE.test(next) && !isRejectedSentence(next) && length(hook) + length(next) <= MAX_HOOK) {
    hook = `${hook}${next}`
  }
  if (splitSentences(hook).every((piece) => isRejectedSentence(piece))) {
    // Nothing clean survived: keep only the identity clause ("X 是 …的小说").
    const characters = [...identity]
    const is = identity.indexOf('是')
    const comma = is >= 0 ? characters.findIndex((ch, index) => index > is && (ch === '，' || ch === '；')) : -1
    if (comma > 0) return `${characters.slice(0, comma).join('')}。`
  }
  return clip(hook, MAX_HOOK + 12)
}

const SCHOLARLY = /考证|考据|索隐|学者|研究者|观点|版本|原稿|抄本|增删|回目|章回|第.{1,4}回/u
const unbalanced = (sentence) => (sentence.match(/“/gu)?.length ?? 0) !== (sentence.match(/”/gu)?.length ?? 0)

const NOTE_KINDS = [
  ['story', /主人公|讲述|故事|叙述了|描写了|刻画/u],
  ['setting', /以.{1,24}为(?:背景|舞台)|发生在|背景是|设定在/u],
  ['idea', /探讨|论述|阐述|提出|主张|揭示|批判|反思|核心/u],
]

/**
 * Up to three more verbatim sentences from the lead, each tagged by what it
 * tells the reader (story / setting / idea).  The offline librarian quotes
 * these; it never paraphrases them.
 */
export function bookNotes(summary = '', hook = '') {
  const sentences = splitSentences(stripBrackets(summary))
    .filter((sentence) => !isRejectedSentence(sentence) && !PUBLISHING_NOISE.test(sentence) && !SECOND_HAND.test(sentence) && !SCHOLARLY.test(sentence) && !unbalanced(sentence))
    .filter((sentence) => !hook.includes(sentence.replace(/[。！？]$/u, '')) && [...sentence].length <= 110)
  const notes = {}
  for (const [kind, pattern] of NOTE_KINDS) {
    const found = sentences.find((sentence) => pattern.test(sentence) && !Object.values(notes).includes(sentence))
    if (found) notes[kind] = found
  }
  return notes
}
