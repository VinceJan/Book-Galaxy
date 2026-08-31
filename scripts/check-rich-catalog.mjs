#!/usr/bin/env node

/** Validate the generated rich Chinese-first catalog without network access. */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateWork, POLICY_HASH, POLICY_VERSION } from './lib/book-eligibility.mjs'
import {
  isOpenLibraryCoverUrl,
  isOpenLibrarySourceUrl,
  isWikipediaRevisionUrl,
  isWikipediaSourceUrl,
  isWikidataUrl,
} from './lib/source-urls.mjs'
import {
  COVER_BLOCKLIST,
  assertApprovedCoverOverlay,
  assertValidApprovedCovers,
} from './lib/cover-policy.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_PATH = resolve(ROOT, 'data/rich/books.json')
const DEFAULT_APPROVED_COVERS = resolve(ROOT, 'data/covers/approved-v1.json')
const PLACEHOLDER = /尚无简介|暂无简介|需要补充|正在編寫|正在编写|没有描述|可能指|本條目需要|消歧義/iu
const SECTION_MARKUP = /={2,}\s*[^=]+\s*={2,}/u
const THEME_SOURCES = new Set(['wikidata-claim', 'summary-rule', 'contextual-metadata', 'generic-last-resort'])
const FOREIGN_TITLE_OVERRIDES = new Map([
  ['Q127149', 'Lolita'],
  ['Q1513486', 'La Hojarasca'],
  ['Q1422823', 'Wirtschaft und Gesellschaft'],
  ['Q97171148', 'Ready Player Two'],
])
const DISPLAY_TITLE_OVERRIDES = new Map([
  ['Q179485', { value: '唐璜 · 莫里哀', source: 'collision-preservation' }],
])
const DISPLAY_TITLE_MEDIA_MARKERS = /(?:书|書|书本|書本|著作|诗|詩|短篇小说集|短篇小說集|黑格尔著作|黑格爾著作|小说|小說|文学作品|文學作品|戏剧|戲劇|漫画|漫畫|诗歌|詩歌|书籍|書籍|传记|傳記|自传|自傳|回忆录|回憶錄|散文集|散文|剧本|劇本|图画小说|圖畫小說|儿童小说|兒童小說|英语小说|波兰小说|法语小说|日本小说|英文儿童小说|上座部|圣经|聖經)/u
const DISPLAY_TITLE_AUTHORISH = /^[\p{L}\p{N}][-\p{L}\p{N}·'’._\s]{1,31}$/u
const DISPLAY_TITLE_VOLUME = /^(?:上|下|前|后|第?[一二三四五六七八九十百0-9]+[卷册部篇]|卷[一二三四五六七八九十百0-9]+|part\s*[ivx0-9]+)$/iu
const DISPLAY_TITLE_SUFFIX = /\s*[（(]([^（）()]*)[）)]\s*$/u
const YEAR_OVERRIDES = new Map([
  ['Q1430632', 1968],
  ['Q4349243', 1921],
  ['Q16954708', 1958],
  ['Q11117637', 1807],
  ['Q1245187', 1819],
  ['Q5410723', 1578],
  ['Q692567', 1899],
  ['Q471005', 1874],
])
const AUTHOR_REGRESSIONS = new Map([
  ['Q11117637', { names: ['曲亭马琴'], ids: ['Q463142'], author: '曲亭马琴', source: 'catalog-override' }],
  ['Q1762323', { names: [], ids: [], author: '佚名', source: 'catalog-override', removedId: 'Q2095353', removedName: '伊斯兰教的神' }],
  ['Q2708299', { names: [], ids: [], author: '多人合著', source: 'catalog-override', removedId: 'Q13473501', removedName: '集体' }],
  ['Q1106019', { names: ['贝尔纳迪诺·德萨阿贡'], ids: ['Q379972'], author: '贝尔纳迪诺·德萨阿贡', source: 'wikidata:P50', removedId: 'Q36747', removedName: '美洲原住民' }],
  ['Q161953', { names: [], ids: [], author: '佚名', source: 'catalog-override', removedId: 'Q60789054', removedName: 'the Chronicler' }],
  ['Q760883', { names: [], ids: [], author: '传统归于毗耶娑', source: 'catalog-override', removedId: 'Q19899291', removedName: 'Vyasa' }],
  ['Q452075', { names: [], ids: [], author: '佚名（蒙塔尔沃增校）', source: 'catalog-override', removedId: 'Q723468', removedName: '加西亚·罗德里格斯·德·蒙塔尔沃' }],
  ['Q914235', { names: [], ids: [], author: '佚名（传统推定为弗朗切斯科·科隆纳）', source: 'catalog-override', removedId: 'Q27767305', removedName: 'Francesco Colonna' }],
  ['Q131072', { names: [], ids: [], author: '佚名（文中自称‘传道者’）', source: 'catalog-override', removedId: 'Q11740876', removedName: '传道者' }],
  ['Q1206749', { names: [], ids: [], author: '传统归于广博仙人', source: 'catalog-override', removedId: 'Q330521', removedName: '广博仙人' }],
  ['Q1328292', { names: [], ids: [], author: '传统归于广博仙人', source: 'catalog-override', removedId: 'Q330521', removedName: '广博仙人' }],
  ['Q2531607', { names: [], ids: [], author: '传统归于广博仙人', source: 'catalog-override', removedId: 'Q330521', removedName: '广博仙人' }],
  ['Q8276', { names: [], ids: [], author: '传统归于广博仙人', source: 'catalog-override', removedId: 'Q330521', removedName: '广博仙人' }],
  ['Q129289', { names: ['让-雅克·卢梭'], ids: ['Q6527'], author: '让-雅克·卢梭' }],
  ['Q19961830', { names: ['本尼迪克特·安德森'], ids: ['Q212993'], author: '本尼迪克特·安德森' }],
  ['Q3819831', { names: ['内维尔·舒特'], ids: ['Q356639'], author: '内维尔·舒特' }],
  ['Q726254', { names: ['塞尔玛·拉格洛夫'], ids: ['Q44519'], author: '塞尔玛·拉格洛夫' }],
  ['Q70784', { names: ['吴承恩'], ids: ['Q228889'], author: '吴承恩' }],
  ['Q70827', { names: ['施耐庵'], ids: ['Q1777502'], author: '施耐庵' }],
  ['Q1185340', { names: ['刘向'], ids: ['Q465282'], author: '刘向' }],
  ['Q1845', { forbiddenNames: ['多位作家', 'various authors', 'group of authors'] }],
])
const NAMED_AUTHOR_COUNT_REGRESSIONS = new Map([
  ['Q11117637', 1],
  ['Q1762323', 0],
  ['Q2708299', 0],
  ['Q1106019', 1],
  ['Q161953', 0],
  ['Q760883', 0],
  ['Q452075', 0],
  ['Q914235', 0],
  ['Q131072', 0],
  ['Q1206749', 0],
  ['Q1328292', 0],
  ['Q2531607', 0],
  ['Q8276', 0],
  ['Q129289', 1],
  ['Q19961830', 1],
  ['Q3819831', 1],
  ['Q726254', 1],
  ['Q70784', 1],
  ['Q70827', 1],
  ['Q1185340', 1],
  ['Q1845', 0],
])
const FORBIDDEN_THEME_REGRESSIONS = new Map([
  ['Q1075382', new Set(['神话与超自然'])], // 《韩非子》只在史料说明中提到民间传说
  ['Q1192316', new Set(['神话与超自然', '家族与代际'])], // 《人月神话》的标题和 System/360 family 都是技术语境
  ['Q1134458', new Set(['神话与超自然'])], // 《四叠半神话大系》的题名不是神话题材证据
  ['Q1052905', new Set(['权力与政治'])], // “较少涉及政治关系”是否定性说明
  ['Q202009', new Set(['自由与压迫'])], // “并非讨论审查制度”是否定性说明
  ['Q465360', new Set(['自由与压迫'])], // “自由间接话语”是叙事术语
  ['Q5687101', new Set(['权力与政治'])], // “革命性的意义”不是政治革命
  ['Q10893170', new Set(['权力与政治', '成长与教育'])], // 顾问履历和教育基金会不等于作品主题
  ['Q719327', new Set(['哲学与信仰'])], // 他作的神学冥想不等于当前作品主题
  ['Q65053924', new Set(['科学与技术'])],
  ['Q2335348', new Set(['战争与创伤'])],
  ['Q7771002', new Set(['生态与环境'])],
  ['Q1211109', new Set(['迁徙与乡土', '战争与创伤'])],
  ['Q552213', new Set(['记忆与时间'])], // 作者创作灵感中的回忆不等于《阿甘正传》的叙事主题
  ['Q839220', new Set(['自由与压迫'])], // “后者”的压迫主题属于被比较的《第22条军规》
  ['Q1068344', new Set(['城市与现代性'])], // “都市”只出现在作者另一套三部曲的名称中
  ['Q628410', new Set(['迁徙与乡土'])], // 故事地点也是作者故乡，不构成迁徙/乡土主题
  ['Q111207760', new Set(['帝国与殖民'])], // 马尼托巴殖民地是社区专名，不是殖民主题
  ['Q1244674', new Set(['家族与代际'])], // 九位姐妹的名字不是血缘/代际叙事证据
  ['Q16241627', new Set(['家族与代际'])], // 戏班师兄弟不是家族关系
  ['Q260205', new Set(['帝国与殖民'])], // 工资奴隶制是阶级隐喻，不是帝国/殖民证据
  ['Q2603313', new Set(['司法与正义'])], // 《末日审判书》专名不构成司法审判主题
  ['Q749783', new Set(['旅行与远方'])], // “几乎没有使用星际旅行”是否定性说明
  ['Q836841', new Set(['历史记忆'])], // 对传记体裁的模仿是形式说明
  ['Q1977971', new Set(['孤独与异化'])], // 他书《百年孤独》的题名不是当前作品主题
  ['Q2004486', new Set(['爱情与亲密关系'])], // 证据描述另一本自传
  ['Q5123535', new Set(['神话与超自然'])], // 致敬奇幻作家的句子不是本书主题
  ['Q772435', new Set(['司法与正义'])], // 角色职业为律师不等于司法主题
  ['Q7759270', new Set(['艺术与创作'])], // “家庭画家”是房屋油漆工语境
  ['Q1169371', new Set(['司法与正义'])], // “神圣正义”是书名，不是司法主题
  ['Q464220', new Set(['哲学与信仰'])], // 外星寄生体名为“灵魂”，不是宗教/哲学证据
  ['Q1639633', new Set(['阶级与贫困'])], // “资产阶级革命”是历史事件名称
  ['Q3819831', new Set(['迁徙与乡土'])], // 澳洲是末日背景，不是迁徙/乡土叙事
  ['Q4127192', new Set(['迁徙与乡土'])], // 土地开发商是案件线索，不是乡土主题
  ['Q2531607', new Set(['文明与未来'])], // 宇宙论是宗教经典内容，不等于未来文明
  ['Q2292400', new Set(['文明与未来'])], // 书名释义中的“宇宙”不单独证明文明主题
  ['Q338034', new Set(['艺术与创作'])], // 画家克罗德后来成为他作主角
  ['Q42040', new Set(['权力与政治'])], // 统治年代是成书考据，不是作品政治主题
  ['Q1498315', new Set(['科学与技术'])], // 生物学家的后续研究属于接受史
  ['Q30314382', new Set(['科学与技术'])], // “受到科学技术研究关注”属于接受史
  ['Q7730315', new Set(['旅行与远方'])], // 报刊书评中的骑行/旅游描述属于评论语境
  ['Q4186950', new Set(['旅行与远方'])], // 对本书研究方向的“月球旅行”不是正文证据
  ['Q28841909', new Set(['哲学与信仰'])], // VR 创作者谈灵魂的评论不是小说正文
  ['Q1194357', new Set(['司法与正义', '旅行与远方'])], // 文类评论清单，不是剧情证据
  ['Q1241741', new Set(['阶级与贫困', '历史记忆'])], // 阶级比较与时代背景都不是主题论述
  ['Q6145461', new Set(['孤独与异化'])], // “风格奇特/荒诞角色”不等于孤独异化
  ['Q1783411', new Set(['司法与正义'])], // 谋杀是情节起点，不构成司法主题
  ['Q7773128', new Set(['战争与创伤', '城市与现代性'])], // 军队/资本主义出现在制度批判中，不是两类主题
  ['Q25750', new Set(['苦难与救赎'])], // 议席争夺中的死亡是开端事件，不是救赎主题
  ['Q3562362', new Set(['苦难与救赎'])], // 集中营情节属于书中嵌套故事，不作为全书关系主题
  ['Q1193302', new Set(['身体与疾病'])], // “文化疾病”是评价隐喻，不是身体疾病
  ['Q228169', new Set(['身体与疾病'])], // 作者诺奖医学背景不是本书身体主题
  ['Q6071286', new Set(['身体与疾病'])], // 叔叔心脏病发是触发情节的偶发事件
  ['Q193417', new Set(['城市与现代性'])], // wiki 小节中的资本主义背景句不是正文主题
])

function args(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const [key, inline] = arg.slice(2).split('=', 2)
    result[key] = inline ?? (argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true)
  }
  return result
}

function chineseCount(value) {
  return (String(value ?? '').match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu) || []).length
}

function fail(errors, message) {
  errors.push(message)
}

function formatAuthorNames(authors) {
  const names = authors.map((author) => String(author?.name || '').trim())
  if (!names.length) return '佚名'
  return names.length <= 3 ? names.join('、') : `${names.slice(0, 2).join('、')}等`
}

function namedAuthorCount(authors) {
  return (Array.isArray(authors) ? authors : [])
    .filter((author) => /^Q\d+$/u.test(String(author?.id || '')) && String(author?.name || '').trim()).length
}

function isDisplayTitleDisambiguator(value) {
  const suffix = String(value || '').trim()
  if (!suffix || DISPLAY_TITLE_VOLUME.test(suffix)) return false
  return DISPLAY_TITLE_MEDIA_MARKERS.test(suffix) || DISPLAY_TITLE_AUTHORISH.test(suffix)
}

async function main() {
  const options = args(process.argv.slice(2))
  const path = resolve(ROOT, String(options.input || DEFAULT_PATH))
  const target = Number.parseInt(String(options.target || 5000), 10)
  if (!existsSync(path)) throw new Error(`找不到富书目文件：${path}`)
  const snapshot = JSON.parse(await readFile(path, 'utf8'))
  const approvedCoversPath = resolve(ROOT, String(options.sidecar || DEFAULT_APPROVED_COVERS))
  if (!existsSync(approvedCoversPath)) throw new Error(`找不到已批准封面侧车：${approvedCoversPath}`)
  const approvedCovers = JSON.parse(await readFile(approvedCoversPath, 'utf8'))
  const books = Array.isArray(snapshot.books) ? snapshot.books : []
  assertValidApprovedCovers(approvedCovers, { catalogBooks: books })
  assertApprovedCoverOverlay(books, approvedCovers)
  const errors = []
  const requestedTarget = options.target === undefined ? Number(snapshot.selection?.targetCount || 0) : target
  if (!Number.isInteger(requestedTarget) || requestedTarget < 1 || requestedTarget > 5000) fail(errors, `目标数必须在 1..5000：${requestedTarget}`)
  if (books.length !== requestedTarget) fail(errors, `书目数量 ${books.length} 不等于目标数 ${requestedTarget}`)
  if (books.length > 5000) fail(errors, `书目数量 ${books.length} 超过 5000`)
  if (snapshot.schemaVersion !== 'bookshelf-galaxy/rich-books-v2') fail(errors, 'schemaVersion 不正确')
  if (snapshot.selection?.acceptedCount !== books.length) fail(errors, 'selection.acceptedCount 与实际书目数量不一致')
  if (snapshot.eligibilityPolicy?.version !== POLICY_VERSION || snapshot.eligibilityPolicy?.hash !== POLICY_HASH) fail(errors, '输出使用的资格 policy 与当前共享 policy 不一致')
  const coverProvenance = snapshot.provenance?.cover
  if (!coverProvenance || coverProvenance.method !== 'Default: Wikidata P648 Open Library work ID + Search API cover_i; approved sidecar entries: exact Edition CoverAsset overlay') fail(errors, 'provenance.cover.method 缺失或不诚实')
  if (!coverProvenance || !String(coverProvenance.versionNote || '').trim()) fail(errors, 'provenance.cover.versionNote 缺失')
  const coverEntries = Array.isArray(coverProvenance?.blocklist) ? coverProvenance.blocklist : []
  for (const [id, reason] of COVER_BLOCKLIST) {
    const entry = coverEntries.find((item) => item?.id === id)
    if (!entry || entry.reason !== reason) fail(errors, `provenance.cover.blocklist 缺少 ${id} 的明确原因`)
  }
  const expectedNamedAuthorBooks = books.filter((book) => namedAuthorCount(book.authors) > 0).length
  if (snapshot.quality?.namedAuthorBooks !== expectedNamedAuthorBooks) fail(errors, 'quality.namedAuthorBooks 与结构化 authors 统计不一致')
  const expectedAuthorCoverage = Number((expectedNamedAuthorBooks / Math.max(books.length, 1)).toFixed(3))
  if (snapshot.quality?.authorCoverage !== expectedAuthorCoverage) fail(errors, 'quality.authorCoverage 与结构化 authors 统计不一致')

  const ids = new Set()
  const displayTitles = new Set()
  const pageIds = new Set()
  const sourceUrls = new Set()
  const revisionUrls = new Set()
  const contentFingerprints = new Set()
  for (const [index, book] of books.entries()) {
    const prefix = `books[${index}]`
    if (!/^Q\d+$/u.test(String(book.id || ''))) fail(errors, `${prefix}.id 不是 Wikidata Q-id`)
    if (ids.has(book.id)) fail(errors, `${prefix}.id 重复：${book.id}`)
    ids.add(book.id)
    if (!book.title || /^(未命名|unknown|undefined)$/iu.test(String(book.title))) fail(errors, `${prefix}.title 缺失或占位`)
    if (chineseCount(book.title) < 1) fail(errors, `${prefix}.title 不是中文展示题名`)
    const displayTitleKey = String(book.title || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
    if (displayTitles.has(displayTitleKey)) fail(errors, `${prefix}.title 展示题名重复：${book.title}`)
    else displayTitles.add(displayTitleKey)
    const titleSuffix = String(book.title || '').match(DISPLAY_TITLE_SUFFIX)
    if (titleSuffix && isDisplayTitleDisambiguator(titleSuffix[1])) fail(errors, `${prefix}.title 不得残留维基消歧尾缀：${book.title}`)
    const expectedDisplayTitle = DISPLAY_TITLE_OVERRIDES.get(book.id)
    if (expectedDisplayTitle) {
      if (book.title !== expectedDisplayTitle.value) fail(errors, `${prefix}.title 碰撞保留 override 失败：应为 ${expectedDisplayTitle.value}`)
      const displayTitleOverride = book.provenance?.displayTitleOverride
      if (displayTitleOverride?.value !== expectedDisplayTitle.value || displayTitleOverride?.source !== expectedDisplayTitle.source || !String(displayTitleOverride?.reason || '').trim()) fail(errors, `${prefix}.provenance.displayTitleOverride 缺少可审计碰撞保留说明`)
    }
    if (!Array.isArray(book.authors)) {
      fail(errors, `${prefix}.authors 必须是可审计作者数组`)
    } else {
      const authorNames = new Set()
      for (const [authorIndex, author] of book.authors.entries()) {
        const authorPrefix = `${prefix}.authors[${authorIndex}]`
        const name = String(author?.name || '').trim()
        const source = String(author?.source || '').trim()
        if (!name) fail(errors, `${authorPrefix}.name 缺失或为空`)
        if (authorNames.has(name)) fail(errors, `${authorPrefix}.name 重复：${name}`)
        authorNames.add(name)
        if (!/^wikidata:P(?:50|2093)$/u.test(source) && source !== 'catalog-override') fail(errors, `${authorPrefix}.source 不是可审计的 P50/P2093 来源或 catalog override`)
        if (source === 'wikidata:P50' && !/^Q\d+$/u.test(String(author?.id || ''))) fail(errors, `${authorPrefix}.id 缺失或不是实体作者 Q-id`)
        if (source === 'catalog-override' && (!/^Q\d+$/u.test(String(author?.id || '')) || !String(author?.reason || '').trim())) fail(errors, `${authorPrefix}.catalog override 缺少实体 id 或理由`)
        if (author?.statementId !== undefined && !String(author.statementId).trim()) fail(errors, `${authorPrefix}.statementId 为空`)
      }
      const expectedAuthor = AUTHOR_REGRESSIONS.get(book.id)?.author || formatAuthorNames(book.authors)
      if (book.author !== expectedAuthor) fail(errors, `${prefix}.author 与 authors 数组不一致：${book.author} ≠ ${expectedAuthor}`)
    }
    const expectedForeignTitle = FOREIGN_TITLE_OVERRIDES.get(book.id)
    if (expectedForeignTitle) {
      if (book.originalTitle !== expectedForeignTitle || book.foreignTitle !== expectedForeignTitle) fail(errors, `${prefix}.foreignTitle 固定回归失败：应为 ${expectedForeignTitle}`)
      const titleOverride = book.provenance?.titleOverride
      if (titleOverride?.value !== expectedForeignTitle || titleOverride?.source !== 'curated-qid-override' || !String(titleOverride?.reason || '').trim()) fail(errors, `${prefix}.provenance.titleOverride 缺少可审计固定覆盖说明`)
    }
    const expectedYear = YEAR_OVERRIDES.get(book.id)
    if (expectedYear !== undefined) {
      if (book.year !== expectedYear) fail(errors, `${prefix}.year 固定回归失败：应为 ${expectedYear}`)
      const yearOverride = book.provenance?.yearOverride
      if (yearOverride?.value !== expectedYear || yearOverride?.source !== 'curated-qid-override' || !String(yearOverride?.reason || '').trim()) fail(errors, `${prefix}.provenance.yearOverride 缺少可审计固定覆盖说明`)
    }
    const authorRegression = AUTHOR_REGRESSIONS.get(book.id)
    const expectedNamedAuthorCount = NAMED_AUTHOR_COUNT_REGRESSIONS.get(book.id)
    if (expectedNamedAuthorCount !== undefined && namedAuthorCount(book.authors) !== expectedNamedAuthorCount) fail(errors, `${prefix}.authors 具名作者计数回归失败`)
    if (authorRegression) {
      const actualAuthors = Array.isArray(book.authors) ? book.authors : []
      if (authorRegression.names) {
        const actualNames = actualAuthors.map((author) => author?.name)
        const actualIds = actualAuthors.map((author) => author?.id)
        if (JSON.stringify(actualNames) !== JSON.stringify(authorRegression.names) || JSON.stringify(actualIds) !== JSON.stringify(authorRegression.ids)) fail(errors, `${prefix}.authors 固定回归失败`)
        if (book.author !== authorRegression.author) fail(errors, `${prefix}.author 固定回归失败：应为 ${authorRegression.author}`)
        if (authorRegression.source && actualAuthors.some((author) => author?.source !== authorRegression.source)) fail(errors, `${prefix}.authors 固定回归来源失败`)
      }
      for (const forbiddenName of authorRegression.forbiddenNames || []) {
        if (actualAuthors.some((author) => author?.name === forbiddenName)) fail(errors, `${prefix}.authors 不应包含泛化署名：${forbiddenName}`)
      }
      if (authorRegression.source === 'catalog-override') {
        const override = book.provenance?.authorOverride
        if (override?.source !== 'catalog-override' || !String(override?.reason || '').trim()) fail(errors, `${prefix}.provenance.authorOverride 缺少来源或理由`)
        if (authorRegression.removedId && (!Array.isArray(override?.removedAuthors) || !override.removedAuthors.some((author) => author?.id === authorRegression.removedId && author?.name === authorRegression.removedName))) fail(errors, `${prefix}.provenance.authorOverride 未记录被过滤的署名`)
      }
      if (book.id === 'Q11117637') {
        const override = book.provenance?.authorOverride
        if (override?.source !== 'catalog-override' || !String(override?.reason || '').trim()) fail(errors, `${prefix}.provenance.authorOverride 缺少来源或理由`)
        if (!Array.isArray(override?.removedAuthors) || !override.removedAuthors.some((author) => author?.id === 'Q134456' && author?.name === '三岛由纪夫')) fail(errors, `${prefix}.provenance.authorOverride 未记录被移除的改编作者`)
      }
      if (book.id === 'Q1762323') {
        const override = book.provenance?.authorOverride
        if (override?.source !== 'catalog-override' || !String(override?.reason || '').includes('传统归属') || !String(override.reason).includes('神学')) fail(errors, `${prefix}.provenance.authorOverride 未说明神学/传统归属`)
        if (!Array.isArray(override?.removedAuthors) || !override.removedAuthors.some((author) => author?.id === authorRegression.removedId && author?.name === authorRegression.removedName)) fail(errors, `${prefix}.provenance.authorOverride 未记录被移除的神学归属`)
      }
      if (book.id === 'Q2708299') {
        const override = book.provenance?.authorOverride
        if (override?.source !== 'catalog-override' || !String(override?.reason || '').includes('通用概念') || !String(override.reason).includes('多人合著')) fail(errors, `${prefix}.provenance.authorOverride 未说明集体署名过滤理由`)
        if (!Array.isArray(override?.removedAuthors) || !override.removedAuthors.some((author) => author?.id === authorRegression.removedId && author?.name === authorRegression.removedName)) fail(errors, `${prefix}.provenance.authorOverride 未记录被移除的集体署名`)
      }
      if (book.id === 'Q1106019') {
        const override = book.provenance?.authorOverride
        if (override?.source !== 'catalog-override' || !String(override?.reason || '').includes('人群概念') || !String(override.reason).includes('纳瓦学者')) fail(errors, `${prefix}.provenance.authorOverride 未说明人群署名过滤与纳瓦学者协作`)
        if (!Array.isArray(override?.removedAuthors) || !override.removedAuthors.some((author) => author?.id === authorRegression.removedId && author?.name === authorRegression.removedName)) fail(errors, `${prefix}.provenance.authorOverride 未记录被移除的人群署名`)
      }
    }
    if (!book.summary || chineseCount(book.summary) < 120 || PLACEHOLDER.test(book.summary)) fail(errors, `${prefix}.summary 少于 120 个中文字符或为占位摘要`)
    if (SECTION_MARKUP.test(String(book.summary || ''))) fail(errors, `${prefix}.summary 不得残留 MediaWiki section markup`)
    const pageId = Number(book.provenance?.wikipediaPageId)
    if (!Number.isInteger(pageId) || pageId < 1) fail(errors, `${prefix}.provenance.wikipediaPageId 缺失`)
    else if (pageIds.has(pageId)) fail(errors, `${prefix}.provenance.wikipediaPageId 重复：${pageId}`)
    else pageIds.add(pageId)
    const sourceKey = String(book.sourceUrl || '').replace(/[?#].*$/u, '').replace(/\/+$/u, '').toLocaleLowerCase('en-US')
    if (sourceUrls.has(sourceKey)) fail(errors, `${prefix}.sourceUrl 重复：${book.sourceUrl}`)
    else sourceUrls.add(sourceKey)
    const revisionKey = String(book.provenance?.wikipediaRevisionUrl || '')
    if (revisionUrls.has(revisionKey)) fail(errors, `${prefix}.provenance.wikipediaRevisionUrl 重复`)
    else revisionUrls.add(revisionKey)
    const contentKey = `${String(book.title || '').replace(/\s+/gu, '')}\u0000${String(book.summary || '').replace(/\s+/gu, '')}`
    if (contentFingerprints.has(contentKey)) fail(errors, `${prefix} 中文题名与摘要和另一颗书星完全重复`)
    else contentFingerprints.add(contentKey)
    if (!Array.isArray(book.themes) || book.themes.length < 3 || book.themes.some((theme) => !String(theme).trim() || chineseCount(theme) < 1)) fail(errors, `${prefix}.themes 少于 3 个有效中文主题`)
    const themeProvenance = book.themeProvenance && typeof book.themeProvenance === 'object' && !Array.isArray(book.themeProvenance)
      ? book.themeProvenance
      : null
    if (!themeProvenance) fail(errors, `${prefix}.themeProvenance 缺失`)
    else {
      const themeKeys = Object.keys(themeProvenance)
      if (themeKeys.length !== book.themes.length || book.themes.some((theme) => !Object.hasOwn(themeProvenance, theme))) fail(errors, `${prefix}.themeProvenance 未逐条覆盖 themes`)
      if (themeKeys.some((theme) => !THEME_SOURCES.has(themeProvenance[theme]))) fail(errors, `${prefix}.themeProvenance 含未知来源类型`)
    }
    const themeEvidence = book.themeEvidence && typeof book.themeEvidence === 'object' && !Array.isArray(book.themeEvidence)
      ? book.themeEvidence
      : null
    if (!themeEvidence) fail(errors, `${prefix}.themeEvidence 缺失`)
    else {
      const evidenceKeys = Object.keys(themeEvidence)
      if (evidenceKeys.length !== book.themes.length || book.themes.some((theme) => !String(themeEvidence[theme] || '').trim())) fail(errors, `${prefix}.themeEvidence 未逐条覆盖 themes`)
    }
    for (const forbidden of FORBIDDEN_THEME_REGRESSIONS.get(book.id) ?? []) {
      if (book.themes.includes(forbidden)) fail(errors, `${prefix} 主题回归：${book.title} 不应以“${forbidden}”参与关系`)
    }
    if (!isWikipediaSourceUrl(String(book.sourceUrl || ''))) fail(errors, `${prefix}.sourceUrl 必须是中文维基百科文章 HTTPS 链接`)
    if (!isWikipediaRevisionUrl(book.sourceUrl, book.provenance?.wikipediaRevisionUrl)) fail(errors, `${prefix}.provenance.wikipediaRevisionUrl 必须与 sourceUrl 同页且 oldid 为纯数字`)
    if (!isWikidataUrl(String(book.wikidataUrl || ''), String(book.id || ''))) fail(errors, `${prefix}.wikidataUrl 必须链接到该作品的 Wikidata Q 项`)
    if (!book.source || !String(book.source).trim()) fail(errors, `${prefix}.source 缺失`)
    if (!Array.isArray(book.instanceOf) || !book.instanceOf.length || book.instanceOf.some((type) => !type.id || !String(type.label || '').trim())) fail(errors, `${prefix}.instanceOf 作品类型证据缺失`)
    if (book.eligibility?.accepted !== true) fail(errors, `${prefix}.eligibility 未确认通过`)
    const reconstructedEntity = {
      id: book.id,
      claims: {
        P31: book.instanceOf.map((type) => ({
          mainsnak: { snaktype: 'value', datavalue: { value: { id: type.id }, type: 'wikibase-entityid' } },
          rank: type.rank || 'normal',
          id: type.statementId || `${book.id}$checker`,
        })),
        ...(book.author && book.author !== '佚名' ? { P50: [{ mainsnak: { datavalue: { value: { id: 'Q999001' } } }, rank: 'normal' }] } : {}),
        ...(book.year ? { P577: [{ mainsnak: { datavalue: { value: { time: `${book.year < 0 ? '-' : '+'}${Math.abs(book.year)}-01-01T00:00:00Z` } } }, rank: 'normal' }] } : {}),
        ...(book.language && book.language !== '未注明' ? { P407: [{ mainsnak: { datavalue: { value: { id: 'Q999002' } } }, rank: 'normal' }] } : {}),
      },
    }
    const reconstructedLabels = Object.fromEntries(book.instanceOf.map((type) => [type.id, { labels: { zh: { value: type.label } } }]))
    const recomputed = evaluateWork({ work: reconstructedEntity, entityMap: reconstructedLabels, intro: book.summary, hasOpenLibrary: Boolean(book.openLibraryId) })
    if (!recomputed.accepted || recomputed.ruleId !== book.eligibility?.ruleId || book.eligibility?.policyHash !== POLICY_HASH) fail(errors, `${prefix}.eligibility 无法由共享 policy 独立复算`)
    if (book.coverUrl !== null && book.coverUrl !== undefined && !isOpenLibraryCoverUrl(String(book.coverUrl))) fail(errors, `${prefix}.coverUrl 必须是 covers.openlibrary.org 的固定 JPG 封面链接`)
    if (book.coverUrl && !book.openLibraryId) fail(errors, `${prefix}.coverUrl 存在但没有 openLibraryId`)
    if (book.coverSourceUrl && !isOpenLibrarySourceUrl(String(book.coverSourceUrl))) fail(errors, `${prefix}.coverSourceUrl 必须是 Open Library work 或 exact Edition 链接`)
    const coverBlockReason = COVER_BLOCKLIST.get(book.id)
    if (coverBlockReason) {
      if (book.coverUrl !== null || book.coverSourceUrl !== null) fail(errors, `${prefix} 已知错配封面必须将 coverUrl/coverSourceUrl 置 null`)
      if (book.provenance?.coverBlockReason !== coverBlockReason) fail(errors, `${prefix}.provenance.coverBlockReason 缺失或不匹配 blocklist`)
      if (book.provenance?.coverStatus !== 'blocked-known-mismatch') fail(errors, `${prefix}.provenance.coverStatus 必须标记为 blocked-known-mismatch`)
    }
    if (!book.provenance?.variantTitleSource) fail(errors, `${prefix}.provenance.variantTitleSource 缺失`)
    if (typeof book.contentLength !== 'number' || book.contentLength < 120) fail(errors, `${prefix}.contentLength 不足`)
    if (typeof book.metadataCompleteness !== 'number' || book.metadataCompleteness < 0 || book.metadataCompleteness > 1) fail(errors, `${prefix}.metadataCompleteness 越界`)
  }
  if (errors.length) {
    console.error(`富书目检查失败（${errors.length} 项）：`)
    for (const error of errors.slice(0, 40)) console.error(`- ${error}`)
    if (errors.length > 40) console.error(`- 其余 ${errors.length - 40} 项省略`)
    process.exitCode = 1
    return
  }
  const minSummary = Math.min(...books.map((book) => chineseCount(book.summary)))
  const coverCount = books.filter((book) => book.coverUrl).length
  console.log(JSON.stringify({
    ok: true,
    path,
    books: books.length,
    uniqueIds: ids.size,
    minimumChineseSummaryCharacters: minSummary,
    covers: coverCount,
    coverRate: Number((coverCount / books.length).toFixed(3)),
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
