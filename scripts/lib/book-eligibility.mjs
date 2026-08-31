import { createHash } from 'node:crypto'

/**
 * Shared, fail-closed policy for deciding whether a Wikidata item is a book
 * that belongs in the public galaxy.  Keep this module dependency-free: the
 * builder and the offline checker import the exact same rule data, while the
 * checker independently re-evaluates every generated item's evidence.
 */

export const POLICY_VERSION = 'book-galaxy-book-unit-policy-v19'

// Shared, evidence-backed exclusions for entities whose direct Wikidata
// statements are insufficient to recover a trustworthy book record. Keeping
// them in the policy (instead of a builder-only skip list) makes the offline
// checker reproduce the same fail-closed decision.
const BLOCKED_WORK_REASONS = new Map([
  ['Q1141990', '《道藏》明确是汇集大量道教经典及相关书籍的大丛书，不是单一书级文本'],
  ['Q85705758', '《正统道藏》是汇集大量道教经典及相关书籍的大丛书，不是单一书级文本'],
  ['Q385530', '《藏文大藏经》是收录数千部译经的藏传佛教经典集成，不是单一书级文本'],
  ['Q215685', '《巴利三藏》是上座部佛教多部经律论的经典结集，不是单一书级文本'],
  ['Q138733', '《高丽大藏经》是由数千卷经文和八万余块木板组成的整套文化遗产，不是单一书级文本'],
  ['Q174361', '《死者之书》在来源中是古埃及墓葬文书传统的总称，各份文本几乎独一无二，不是单一书级作品'],
  ['Q1762323', '《引支勒》是福音的阿拉伯语名称及存在多种解释的启示概念，无法核验为单一现存文本'],
  ['Q34990', '《妥拉》在来源中指向可变的经书传统与多部经典集合，不是单一书级文本'],
  ['Q10786016', '条目是维基百科项目页，不是书籍或独立文学作品'],
  ['Q110904767', '条目是后室网络迷因及其系列世界的概念集合，不是单一书级文本'],
  ['Q17439649', '条目是 SCP 基金会协作写作 wiki 项目，不是单一书级文本'],
  ['Q3127227', '仅见杂志刊载且再版失败的单篇故事，不是书级出版物'],
  ['Q3761739', 'Wikidata 作者标签被污染，当前来源无法生成可信作者字段'],
  ['Q597697', 'Wikidata P50 指向无关实体，与中文来源中的传统归属矛盾'],
  ['Q4837410', 'Wikidata P50 指向口述对象而非摘要明确记载的著者'],
  ['Q1321432', '“三藏”在来源中被定义为佛教经典分类法，不是单一书级文本'],
  ['Q201410', '“次经”是多部著作的类别性集合，不是单一书级文本'],
  ['Q216383', '“先知书”是《希伯来圣经》的分部集合，不是单一书级文本'],
  ['Q2655574', '“濒死的地球”是系列总称，不是单一书级文本'],
  ['Q2261631', '条目指向包含三部作品的合集且重定向身份含混，无法生成单一书星'],
  ['Q3086228', '“历史书”是包含十二卷圣经书目的分组，不是单一书级文本'],
  ['Q3224748', '仅有杂志首发并收入故事集的单篇中篇小说证据，缺少独立成书证据'],
  ['Q4212557', '“景教经典”是多部景教译经的集合总称，不是单一书级文本'],
])

// Distinct, auditable publication/distribution exclusion set (conservative,
// reproducible). These six works are excluded by directory policy, not by
// source-identity conflict: the first three are user-mandated and the latter
// three intersect the linked titles in the current《中华人民共和国被禁出版物列表》.
// Keeping a separate map makes the offline checker reproduce the same decision
// without camouflaging it as an identity conflict. Do NOT extend this set by
// inference in this milestone (e.g. 灵山、致命中国、不要说我们一无所有、龙在雪域
// remain eligible if they otherwise pass).
const PUBLICATION_EXCLUDED_WORKS = new Map([
  ['Q11098383', '出版/发行受限：李鹏六四日记（用户指定保守排除）——按本目录出版排除策略排除'],
  ['Q27544', '出版/发行受限：毛泽东：鲜为人知的故事（用户指定保守排除；与《中华人民共和国被禁出版物列表》关联条目交集）——按本目录出版排除策略排除'],
  ['Q17029712', '出版/发行受限：解放的悲剧：中国革命史1945-1957（用户指定保守排除；与《中华人民共和国被禁出版物列表》关联条目交集）——按本目录出版排除策略排除'],
  ['Q10874462', '出版/发行受限：中国即将崩溃（与《中华人民共和国被禁出版物列表》关联条目交集）——按本目录保守出版排除策略排除'],
  ['Q390176', '出版/发行受限：一个人的圣经（与《中华人民共和国被禁出版物列表》关联条目交集）——按本目录保守出版排除策略排除'],
  ['Q976946', '出版/发行受限：上海宝贝（与《中华人民共和国被禁出版物列表》关联条目交集）——按本目录保守出版排除策略排除'],
])

export const ALLOW_P31 = [
  'Q7725634', 'Q47461344', 'Q116476516', 'Q25379', 'Q1279564', 'Q725377',
  'Q2831984', 'Q474090', 'Q108329152', 'Q108329788', 'Q209680', 'Q1001051',
  'Q1191035', 'Q179461', 'Q41795401', 'Q36279', 'Q5292', 'Q223638', 'Q571',
  'Q24723',
]

export const HARD_DENY_P31 = [
  'Q5', 'Q35127', 'Q24897257', 'Q620615', 'Q7397', 'Q19967801', 'Q41298',
  'Q3185361', 'Q15296520', 'Q847906', 'Q5398426', 'Q15416', 'Q63952888',
  'Q117467246', 'Q113671041', 'Q220898', 'Q105543609', 'Q114586269',
  'Q21848887', 'Q856713', 'Q4830453', 'Q431289', 'Q2024496', 'Q11396960',
  'Q3209941', 'Q1249224', 'Q14946528',
  // Project pages, wikis, memes, concepts and non-book fragments that have
  // appeared with a noisy secondary “literary work” statement in Wikidata.
  'Q14204246', 'Q171', 'Q2927074', 'Q189349', 'Q115470079', 'Q18535',
  'Q2643280',
  // Legally or editorially bounded texts that may carry a noisy literary-work
  // statement but are not a book unit in this catalogue.
  'Q49084', 'Q5185279', 'Q602446', 'Q7366', 'Q174864', 'Q861911',
  'Q625298', 'Q131569', 'Q1691434', 'Q1414472', 'Q79700418', 'Q476068',
  'Q820655', 'Q3099732', 'Q10870555',
  'Q13406463', 'Q131510',
  // A chapter/section is never a standalone book unit, even when a noisy
  // item also carries a strong scripture or literary-work P31 statement.
  'Q1980247',
]

export const SERIES_DEFAULT_DENY_P31 = [
  'Q14406742', 'Q137637896', 'Q133863495', 'Q137644978', 'Q21198342',
  'Q277759', 'Q1667921', 'Q838795', 'Q213369', 'Q8274', 'Q754669', 'Q1004',
  'Q7725310',
  'Q104213567',
]

// These direct types identify a book-sized unit closely enough to pass even
// when ancient or anonymous works lack modern publication metadata.
const STRONG_BOOK_P31 = new Set([
  'Q571', 'Q1279564', 'Q725377', 'Q2831984', 'Q108329152', 'Q108329788',
  'Q209680', 'Q1001051', 'Q1191035', 'Q179461', 'Q41795401', 'Q5292',
  'Q223638',
])

// Broad work/form types need an independent, book-unit proof. In particular,
// Q7725634 “literary work” alone also covers a single poem, an allegory, a
// genre, a wiki project and other entities that must not become book stars.
const CONDITIONAL_WORK_P31 = new Set([
  'Q7725634', 'Q47461344', 'Q116476516', 'Q25379', 'Q474090', 'Q36279',
  'Q24723',
])

export const POLICY_TYPES = [...new Set([...ALLOW_P31, ...HARD_DENY_P31, ...SERIES_DEFAULT_DENY_P31])].sort()

const POLICY_DIGEST_INPUT = JSON.stringify({
  version: POLICY_VERSION,
  ruleContract: 'publication-exclusion-v1;blocked-work-identity-conflicts;fixed-known-non-book-v2;chapter-p31-deny-v1;canon-collection-intro-v1;hard-deny-and-series-first;all-allowed-types-respect-explicit-fragment-intro;strong-direct;conditional-requires-positive-book-identity-and-valid-bibliography;fragment-intro-deny-v10-chinese-sentence-window;mixed-p31-deny-v2',
  allow: [...ALLOW_P31].sort(),
  hardDeny: [...HARD_DENY_P31].sort(),
  seriesDefaultDeny: [...SERIES_DEFAULT_DENY_P31].sort(),
  blockedWorks: [...BLOCKED_WORK_REASONS].sort(([left], [right]) => left.localeCompare(right)),
  publicationExcludedWorks: [...PUBLICATION_EXCLUDED_WORKS].sort(([left], [right]) => left.localeCompare(right)),
})
export const POLICY_HASH = createHash('sha256').update(POLICY_DIGEST_INPUT).digest('hex')

function clean(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

function claimStatements(entity, property) {
  return (entity?.claims?.[property] || [])
    .filter((statement) => statement?.rank !== 'deprecated')
}

function entityIdFromStatement(statement) {
  const value = statement?.mainsnak?.datavalue?.value
  const id = value?.id || value
  const match = String(id ?? '').match(/^Q\d+$/u)
  return match ? match[0] : ''
}

function claimEntityIds(entity, property) {
  return claimStatements(entity, property).map(entityIdFromStatement).filter(Boolean)
}

function hasAuthorEvidence(entity) {
  if (claimEntityIds(entity, 'P50').length) return true
  return claimStatements(entity, 'P2093').some((statement) => clean(statement?.mainsnak?.datavalue?.value).length >= 2)
}

function hasValidPublicationYear(entity) {
  return claimStatements(entity, 'P577').some((statement) => {
    const value = statement?.mainsnak?.datavalue?.value
    const match = String(value?.time || value || '').match(/^([+-])(\d{1,6})-/u)
    if (!match) return false
    const absolute = Number(match[2])
    const year = match[1] === '-' ? -absolute : absolute
    return Number.isInteger(year) && year !== 0 && year >= -5000 && year <= 2200
  })
}

function labelFor(id, entityMap) {
  const entity = entityMap?.[id]
  return clean(entity?.labels?.['zh-cn']?.value
    || entity?.labels?.['zh-hans']?.value
    || entity?.labels?.zh?.value
    || entity?.labels?.en?.value
    || id)
}

function firstSentences(value, count = 1) {
  // Chinese Wikipedia leads frequently contain initials such as “J.D.” and
  // “J.K.”. Treating every ASCII period as a sentence boundary truncated the
  // identity statement before “短篇小说”, allowing a fragment through the
  // book-unit gate. The zh-cn corpus has Chinese terminators, so use those as
  // the only hard boundaries and keep a deliberately small shared window.
  const text = clean(value)
  if (!text) return ''
  const sentences = text.match(/[^。！？]+[。！？]?/gu) ?? [text]
  return clean(sentences.slice(0, Math.max(1, count)).join(' '))
}

function firstSentence(value) {
  return firstSentences(value, 1)
}

function introRejectsBookUnit(value) {
  const identityWindow = firstSentences(value, 2)
  // Keep canon-collection matching deliberately narrow: a book that merely
  // cites a canon must remain eligible; only explicit collection identity
  // language (大藏经/三藏/经典结集/汇集大量…大丛书) is quarantined.
  const canonCollection = /(?:经典|經典)(?:集成|结集|結集|总集|總集)|(?:汇集|彙集).{0,24}(?:大量|数千|數千|多部|数百|數百).{0,24}(?:经典|經典|经书|經書|典籍).{0,24}(?:大丛书|大叢書)|(?:^|[。！？])\s*(?:《[^》]{0,18}》|[^。！？]{0,18})(?:大藏经|大藏經)(?:（[^）]{0,40}）)?\s*(?:是|为|為|指|又称|又稱|，|在)|(?:^|[。！？])\s*(?:巴利|南传|南傳|佛教)三藏(?:（[^）]{0,40}）)?\s*(?:是|为|為|指|又称|又稱|，|在)|(?:经典|經典)的(?:结集|結集)/iu.test(identityWindow)
  if (canonCollection) return true
  return /(?:一首|单首|單首|第一首|其中一首).{0,18}(?:诗|詩|俳句|绝句|絕句|颂歌|頌歌|圣诗|聖詩|歌曲)|短篇(?!集|结集|結集|合集|选集|選集|作品集)[^。！？]{0,8}(?:小说|小說|故事)(?!集|结集|結集|合集|选集|選集|作品集)|(?:一篇|单篇|單篇)[^。！？]{0,20}(?:小说|小說)(?!集|结集|結集|合集|选集|選集|作品集)|(?:一个|一個|一则|一則|一篇).{0,20}(?:短篇)?(?:故事|童话|童話|寓言)|第\d+则故事|第[一二三四五六七八九十百]+则故事|(?:一篇|单篇|單篇).{0,16}(?:文章|论文|論文|演讲|演說|讲话|講話|报告|報告|散文)|(?:是|为).{0,64}(?:发表|發表|撰写|撰寫|写作|寫作)的(?:一篇)?(?:论文|論文|文章|演讲|演說|讲话|講話)|(?:是|为)[^，,。！？；;]{0,50}(?:小说|小說|漫画|漫畫|故事|作品)系列|(?:是|为).{0,300}(?:经|經).{0,20}中的(?:咒文|咒语|咒語|真言|陀罗尼|陀羅尼)|(?:是|为).{0,80}(?:书籍|書籍|书|書|经|經).{0,12}中的(?:一个|一個|第[一二三四五六七八九十百\d]+)?(?:章节|章節|一章|一节|一節)|(?:这些|這些|所有|多部|数部|數部|诸|諸)(?:圣书|聖書|经书|經書)|(?:是指|指).{0,100}(?:三个|三個|多个|多個|数个|數個).{0,16}(?:篇章|章节|章節|段落)|(?:被称为|被稱為|名为|名為)[^。！？]{0,20}(?:文书|文書|文献|文獻)[^。！？]{0,12}共有[两二兩]件|(?:^|[。！？])[^。！？]{0,30}指《[^》]+》(?:和|与|與|及|、)《[^》]+》|(?:是|指)[^。！？]{0,140}(?:的)?(?:特征|特徵|术语|術語|名称|名稱|概念|类型|類型)(?:[。！？]|$)|调查报告|調查報告|国际公约|國際公約|名句|诗歌类型|詩歌類型|文学类型|文學類型|体裁之一|體裁之一|寓言故事|(?:写作|寫作|创作|創作|组织|組織).{0,8}(?:原则|原則|规则|規則)|网络迷因|網路迷因|创作项目|創作項目|协作写作|協作寫作|wiki|维基|維基|收录于.{0,24}(?:诗集|詩集|小说集|小說集|故事集)|(?:poem|short story|essay|speech|song lyric)\b/iu.test(identityWindow)
}

function introConfirmsStandaloneWork(value) {
  const identityWindow = firstSentences(value, 2)
  if (introRejectsBookUnit(identityWindow) || /概念/iu.test(identityWindow)) return false
  const directIdentity = /小说(?!系列|人物|角色|体裁|類型|类型|章节|章節)|小說(?!系列|人物|角色|體裁|類型|章节|章節)|短篇小说结集|短篇小說結集|小说集|小說集|短篇集|故事集|图像小说|圖像小說|漫画书|漫畫書|著作|专著|專著|书籍|書籍|图书|圖書|诗集|詩集|文集|作品集|选集|選集|合集|剧本|劇本|戏剧|戲劇|史诗|史詩|经书|經書|典籍|圣经|聖經|宗教文本|传记|傳記|自传|自傳|回忆录|回憶錄|百科全书|百科全書|词典|詞典|辞典|辭典|指南|手册|手冊|论著|論著|novel|novella|collection|anthology|graphic novel|comic book|book|monograph|play|drama|biography|memoir|encyclopedia|dictionary|handbook|scripture/iu
  if (directIdentity.test(identityWindow)) return true
  // Some Chinese Wikipedia leads call the subject only “作品” in sentence
  // one, then immediately identify it as a book through a subject-led second
  // sentence (“小说以…”, “本书讲述…”). Keep the window tight so a later
  // mention of an adaptation or another title cannot qualify the item.
  const extendedIdentityWindow = firstSentences(value, 4)
  return /(?:^|[。！？])\s*(?:小说|小說|本书|本書|全书|全書|该书|該書|此书|此書)(?:以|讲述|講述|描写|描寫|叙述|敘述|围绕|圍繞|收录|收錄)/iu.test(extendedIdentityWindow)
}

function directP31Evidence(work, entityMap) {
  return claimStatements(work, 'P31').map((statement) => {
    const id = entityIdFromStatement(statement)
    return {
      id,
      label: labelFor(id, entityMap),
      rank: statement.rank || 'normal',
      statementId: statement.id || null,
    }
  }).filter((type) => type.id)
}

function signalList({ matchedAllow, matchedDeny, matchedSeries, hasAuthor, hasDate, hasLanguage, introExplicit, hasOpenLibrary }) {
  return [
    ...matchedAllow.map((id) => `allow:${id}`),
    ...matchedDeny.map((id) => `hard-deny:${id}`),
    ...matchedSeries.map((id) => `series:${id}`),
    hasAuthor ? 'author:P50-or-P2093' : 'missing:author',
    hasDate ? 'date:P577' : 'missing:date',
    hasLanguage ? 'language:P407' : 'missing:language',
    introExplicit ? 'intro:first-sentence-work-identity' : 'missing:intro-work-identity',
    hasOpenLibrary ? 'cover:P648' : 'missing:cover:P648',
  ]
}

/**
 * Evaluate direct, non-deprecated P31 statements. `intro` may be either a
 * plain extract string or an intro cache object with an `extract` property.
 */
export function evaluateWork({ work, entityMap = {}, intro = '', hasOpenLibrary = false } = {}) {
  const directP31 = directP31Evidence(work, entityMap)
  const ids = directP31.map((type) => type.id)
  const matchedAllow = ids.filter((id) => ALLOW_P31.includes(id))
  const matchedDeny = ids.filter((id) => HARD_DENY_P31.includes(id))
  const matchedSeries = ids.filter((id) => SERIES_DEFAULT_DENY_P31.includes(id))
  const introText = typeof intro === 'string' ? intro : intro?.extract || ''
  const introExplicit = introConfirmsStandaloneWork(introText)
  const introFragment = introRejectsBookUnit(introText)
  const hasAuthor = hasAuthorEvidence(work)
  const hasDate = hasValidPublicationYear(work)
  const hasLanguage = claimEntityIds(work, 'P407').length > 0
  const signals = [
    ...signalList({ matchedAllow, matchedDeny, matchedSeries, hasAuthor, hasDate, hasLanguage, introExplicit, hasOpenLibrary }),
    introFragment ? 'intro:non-book-unit' : 'intro:no-fragment-signal',
  ]
  const evidence = {
    policyVersion: POLICY_VERSION,
    policyHash: POLICY_HASH,
    directP31,
    matchedIds: { allow: matchedAllow, hardDeny: matchedDeny, seriesDefaultDeny: matchedSeries },
    signals,
  }

  if (PUBLICATION_EXCLUDED_WORKS.has(work?.id)) return {
    accepted: false,
    status: 'rejected',
    ruleId: 'publication-excluded',
    category: 'publication-restricted',
    reason: PUBLICATION_EXCLUDED_WORKS.get(work.id),
    ...evidence,
  }

  if (BLOCKED_WORK_REASONS.has(work?.id)) return {
    accepted: false,
    status: 'rejected',
    ruleId: 'catalog-specific-identity-conflict',
    category: 'source-identity-conflict',
    reason: BLOCKED_WORK_REASONS.get(work.id),
    ...evidence,
  }

  // A hard deny is absolute, even if a noisy item also advertises a book-like
  // type. This is the important anti-pollution invariant.
  if (matchedDeny.length) return {
    accepted: false,
    status: 'rejected',
    ruleId: 'hard-deny-direct-p31',
    category: 'non-book-or-platform',
    reason: `命中硬否决 P31：${matchedDeny.join(', ')}`,
    ...evidence,
  }

  // Series/collection types remain quarantined in this build. Releasing one
  // would require a second pass after Open Library returns a real cover_i and
  // a single-work intro proof; the builder intentionally stays fail-closed.
  if (matchedSeries.length) return {
    accepted: false,
    status: 'quarantine',
    ruleId: 'series-default-deny',
    category: 'series-or-collection',
    reason: '系列/合集类型在当前快照统一隔离；单本拆分需后续人工核验',
    ...evidence,
  }

  // Direct type statements can be noisy. An explicit lead-level statement
  // that the entity is a single story, poem, speech, chapter, mantra or
  // another fragment outranks even a broad “book/scripture” P31.
  if (introFragment) return {
    accepted: false,
    status: 'quarantine',
    ruleId: 'intro-identifies-non-book-unit',
    category: 'work-fragment-needs-book-edition',
    reason: '导语把实体明确识别为单篇诗文、章节、咒文、规则或其他非独立书级单元',
    ...evidence,
  }

  const strongBookTypes = matchedAllow.filter((id) => STRONG_BOOK_P31.has(id))
  if (strongBookTypes.length) return {
    accepted: true,
    status: 'accepted',
    ruleId: 'direct-book-type',
    category: 'book-like-work',
    reason: `命中直接书籍类型：${strongBookTypes.join(', ')}`,
    ...evidence,
  }

  const conditionalTypes = matchedAllow.filter((id) => CONDITIONAL_WORK_P31.has(id))
  if (conditionalTypes.length) {
    const classicalText = /经书|經書|圣经|聖經|宗教文本|scripture|sacred text/iu.test(`${directP31.map((type) => type.label).join(' ')} ${firstSentence(introText)}`)
    const completeWrittenWork = hasAuthor && hasDate && hasLanguage && introExplicit
    if (completeWrittenWork || (classicalText && introExplicit)) return {
      accepted: true,
      status: 'accepted',
      ruleId: completeWrittenWork
        ? 'work-with-bibliographic-evidence'
        : 'written-classical-text',
      category: classicalText ? 'classical-text' : 'written-work',
      reason: completeWrittenWork
        ? '宽泛作品类型同时具备作者、初版年、语言和肯定的独立书级导语身份证据'
        : '经典文本具备明确文本身份和导语证据',
      ...evidence,
    }
    return {
      accepted: false,
      status: 'quarantine',
      ruleId: 'broad-work-missing-book-unit-evidence',
      category: 'work-needs-book-unit-review',
      reason: '宽泛作品类型缺少可独立复算的书级书目证据',
      ...evidence,
    }
  }

  return {
    accepted: false,
    status: 'rejected',
    ruleId: 'no-allowed-direct-p31',
    category: 'unclassified',
    reason: '没有命中允许的直接 P31 类型',
    ...evidence,
  }
}
