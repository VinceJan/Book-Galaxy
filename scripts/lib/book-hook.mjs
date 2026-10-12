/**
 * Deterministic 1–2 sentence "hook" extraction from the Chinese Wikipedia lead.
 *
 * Nothing is generated: the hook is always a verbatim span of the lead (minus
 * bracketed transliterations), chosen so that it says what the book is about
 * rather than when it was printed, translated, adapted or awarded.
 */

const PUBLISHING_NOISE = /出版|连载|发表|刊行|印行|发行|再版|译本|翻译|译者|获得|获颁|荣获|奖|改编|电影|电视|舞台剧|上映|销量|畅销|ISBN|版本|抄本|全集|评为|入选|提名|排行/u
const SECOND_HAND = /^在《|评价|撰文|批评家|评论家|学者认为|被认为|誉为|称赞|赞誉|抄本/u
const CONTENT_SIGNAL = /内容以|讲述|描写|描述|叙述|刻画|记录|记述|探讨|论述|讨论|阐述|主人公|故事|围绕|以.{1,16}为(?:中心|主线|背景|题材)|认为|揭示|描绘|追溯|关于|控诉|批判|反思/u
const MAX_HOOK = 96

const stripBrackets = (text) => text
  .replace(/（[^（）]*[A-Za-zÀ-ɏ\u0900-\u097f\u0600-\u06ff：:][^（）]*）/gu, '')
  .replace(/\([^()]*\)/gu, '')
  .replace(/\s+/gu, ' ')
  .trim()

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
  return score
}

export function bookHook(summary = '') {
  const sentences = splitSentences(stripBrackets(summary))
  if (sentences.length === 0) return ''
  const ranked = sentences
    .map((sentence, index) => ({ sentence, index, score: scoreSentence(sentence, index) }))
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
  if (length(hook) < 28 && next && !PUBLISHING_NOISE.test(next) && length(hook) + length(next) <= MAX_HOOK) {
    hook = `${hook}${next}`
  }
  return clip(hook, MAX_HOOK + 12)
}
