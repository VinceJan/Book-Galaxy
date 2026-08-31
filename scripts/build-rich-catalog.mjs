#!/usr/bin/env node

/**
 * Build a Chinese-first, content-rich book map from Wikidata and Chinese
 * Wikipedia.  The output is intentionally separate from the Gutenberg demo
 * catalog: it is a curated, citation-friendly work snapshot rather than a
 * large bibliographic index.
 *
 * The script only uses Node's standard library.  Network responses are cached
 * under data/raw/rich-catalog/ (ignored by git), so a second run resumes
 * without repeating completed API calls.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALLOW_P31,
  POLICY_HASH,
  POLICY_TYPES,
  POLICY_VERSION,
  evaluateWork,
} from './lib/book-eligibility.mjs'
import {
  COVER_BLOCKLIST,
  applyApprovedCoversToSnapshot,
  assertValidApprovedCovers,
} from './lib/cover-policy.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT_DIR = resolve(ROOT, 'data/rich')
const RAW_DIR = resolve(ROOT, 'data/raw/rich-catalog')
const OUTPUT_PATH = resolve(OUTPUT_DIR, 'books.json')
const APPROVED_COVERS_PATH = resolve(ROOT, 'data/covers/approved-v1.json')

const WDQS_URL = 'https://query.wikidata.org/sparql'
const WBGETENTITIES_URL = 'https://www.wikidata.org/w/api.php'
const WIKIPEDIA_API_URL = 'https://zh.wikipedia.org/w/api.php'
const OPENLIBRARY_SEARCH_URL = 'https://openlibrary.org/search.json'
const DEFAULT_LIMIT = 1000
const DEFAULT_CANDIDATE_MULTIPLIER = 2
const MAX_LIMIT = 5000
const ENTITY_BATCH_SIZE = 50
const INTRO_BATCH_SIZE = 20
const PAGE_BATCH_SIZE = 50
const ENTITY_CLAIM_PROPERTIES = new Set([
  'P31',
  'P50',
  'P136',
  'P921',
  'P1269',
  'P642',
  'P407',
  'P495',
  'P1476',
  'P577',
  'P580',
  'P2093',
  'P648',
])
// WDQS can time out when a VALUES clause contains the whole policy allowlist
// and asks for thousands of rows in one response. Keep each request small and
// deterministic; the per-type/page response cache below makes the crawl
// resumable after an interruption or a transient endpoint failure.
const CANDIDATE_PAGE_SIZE = 250
const REQUEST_TIMEOUT_MS = 45_000
const MAX_RETRIES = 4
const MIN_REQUEST_INTERVAL_MS = 260
const USER_AGENT = 'book-galaxy-rich-catalog/2.0 (https://github.com/VinceJan/Book-Galaxy; contact: book-galaxy@example.invalid)'

// These are presentation anchors for the three-minute hackathon route. They
// still pass the same summary/source/metadata gates as every other work; the
// list only protects them from being displaced by quality-score tie breaks.
const REQUIRED_QIDS = new Set([
  'Q607112', // 三体
  'Q753894', // 基地
  'Q190192', // 沙丘
  'Q261281', // 索拉里斯星
  'Q147787', // 安娜·卡列尼娜
  'Q151919', // 活着
  'Q8265', // 红楼梦
  'Q70784', // 西游记
  'Q178869', // 百年孤独
  'Q165318', // 罪与罚
  'Q193417', // 包法利夫人
  'Q180736', // 悲惨世界
])
const REQUIRED_TITLES = new Set(['红楼梦', '西游记', '哈姆雷特', '百年孤独', '罪与罚', '包法利夫人', '悲惨世界'])
const REQUIRED_CANDIDATES = [
  { id: 'Q607112', title: '三体 (小说)' },
  { id: 'Q753894', title: '基地 (小說)' },
  { id: 'Q190192', title: '沙丘 (小说)' },
  { id: 'Q261281', title: '索拉里斯星 (小说)' },
  { id: 'Q147787', title: '安娜·卡列尼娜' },
  { id: 'Q151919', title: '活着' },
  { id: 'Q8265', title: '红楼梦' },
  { id: 'Q70784', title: '西游记' },
  { id: 'Q178869', title: '百年孤独' },
  { id: 'Q165318', title: '罪与罚' },
  { id: 'Q193417', title: '包法利夫人' },
  { id: 'Q180736', title: '悲惨世界' },
]

// Wikidata P1476 can contain a stale translation, a shortened title, or a
// title accidentally copied from another edition.  Keep the few known cases
// explicit and auditable instead of silently teaching the title heuristic to
// guess.
const FOREIGN_TITLE_OVERRIDES = new Map([
  ['Q127149', { value: 'Lolita', source: 'curated-qid-override', reason: 'Wikidata P1476 contains a known incorrect foreign-title value for this work.' }],
  ['Q1513486', { value: 'La Hojarasca', source: 'curated-qid-override', reason: 'Wikidata P1476 contains a known incorrect foreign-title value for this work.' }],
  ['Q1422823', { value: 'Wirtschaft und Gesellschaft', source: 'curated-qid-override', reason: 'Wikidata P1476 contains a known incorrect foreign-title value for this work.' }],
  ['Q97171148', { value: 'Ready Player Two', source: 'curated-qid-override', reason: 'Wikidata P1476 incorrectly labels the Spanish title as English; use the verified English work title.' }],
])
const DISPLAY_TITLE_OVERRIDES = new Map([
  ['Q179485', { value: '唐璜 · 莫里哀', source: 'collision-preservation', reason: 'Removing the trailing author/media disambiguator would collide with the Byron work; retain a concise author marker in the display title.' }],
])

// A work can have several P577/P580 claims for serialisation, first edition,
// reprint, translation, or adaptation.  These explicit corrections preserve
// the first appearance of the work where the current entity claims are known
// to surface a later edition or adaptation year.
const YEAR_OVERRIDES = new Map([
  ['Q1430632', { value: 1968, source: 'curated-qid-override', reason: 'Use the work\'s first publication year rather than a later edition or adaptation year.' }],
  ['Q4349243', { value: 1921, source: 'curated-qid-override', reason: 'Use the work\'s first publication year rather than a later edition or adaptation year.' }],
  ['Q16954708', { value: 1958, source: 'curated-qid-override', reason: 'Use the work\'s first serialisation/appearance year rather than a later edition year.' }],
  ['Q11117637', { value: 1807, source: 'curated-qid-override', reason: 'Use the work\'s first publication year (1807) rather than an erroneous later metadata year.' }],
  ['Q1245187', { value: 1819, source: 'curated-qid-override', reason: 'Use the work\'s first publication year rather than a later edition or adaptation year.' }],
  ['Q5410723', { value: 1578, source: 'curated-qid-override', reason: 'Use the work\'s first publication year rather than a later edition or adaptation year.' }],
  ['Q692567', { value: 1899, source: 'curated-qid-override', reason: 'Use the work\'s first publication year rather than a later edition or adaptation year.' }],
  ['Q471005', { value: 1874, source: 'curated-qid-override', reason: 'Use the work\'s first publication year rather than a later edition or adaptation year.' }],
])
const AUTHOR_OVERRIDES = new Map([
  ['Q11117637', {
    source: 'catalog-override',
    reason: '三岛由纪夫是后世歌舞伎改编作者，并非这部江户读本的原作者；保留曲亭马琴这一可核查原作者。',
    authors: [{ name: '曲亭马琴', id: 'Q463142' }],
    removedAuthors: [{ name: '三岛由纪夫', id: 'Q134456' }],
  }],
  ['Q1762323', {
    source: 'catalog-override',
    reason: 'P50 指向“伊斯兰教的神”（Q2095353）是神学/传统归属，不是可展示的个人作者；按传统/宗教归属保留为未署名（佚名）。',
    authors: [],
    removedAuthors: [{ name: '伊斯兰教的神', id: 'Q2095353' }],
  }],
  ['Q2708299', {
    source: 'catalog-override',
    reason: 'P50 指向“集体”（Q13473501）是通用概念而非可署名作者；摘要记录多位编剧/绘师及漫威与 Bungie 合作选集，按多人合著展示。',
    authors: [],
    displayAuthor: '多人合著',
    removedAuthors: [{ name: '集体', id: 'Q13473501' }],
  }],
  ['Q1106019', {
    source: 'catalog-override',
    reason: 'P50 的“美洲原住民”（Q36747）是人群概念而非具名作者；保留贝尔纳迪诺·德萨阿贡，并据导语记录其与未署名纳瓦学者的协作。',
    authors: [{ name: '贝尔纳迪诺·德萨阿贡', id: 'Q379972', source: 'wikidata:P50' }],
    displayAuthor: '贝尔纳迪诺·德萨阿贡',
    removedAuthors: [{ name: '美洲原住民', id: 'Q36747' }],
  }],
  ['Q161953', {
    source: 'catalog-override',
    reason: 'P50 的“the Chronicler”（Q60789054）是不确定作者的占位身份，非具名个人；按中文导语展示为佚名。',
    authors: [],
    displayAuthor: '佚名',
    removedAuthors: [{ name: 'the Chronicler', id: 'Q60789054' }],
  }],
  ['Q760883', {
    source: 'catalog-override',
    reason: 'P50 的 Vyasa（Q19899291）是每个时代“吠陀编纂者”的称号而非具名个人；按传统归属展示。',
    authors: [],
    displayAuthor: '传统归于毗耶娑',
    removedAuthors: [{ name: 'Vyasa', id: 'Q19899291' }],
  }],
  ['Q452075', {
    source: 'catalog-override',
    reason: '原作者不确定；P50 的蒙塔尔沃（Q723468）是增校/修订者而非确定原作者，保留其编辑事实但不作为署名作者展示。',
    authors: [],
    displayAuthor: '佚名（蒙塔尔沃增校）',
    removedAuthors: [{ name: '加西亚·罗德里格斯·德·蒙塔尔沃', id: 'Q723468' }],
  }],
  ['Q914235', {
    source: 'catalog-override',
    reason: '作者不明；P50 的 Francesco Colonna（Q27767305）仅为藏头推测，按传统推定说明而非确定署名展示。',
    authors: [],
    displayAuthor: '佚名（传统推定为弗朗切斯科·科隆纳）',
    removedAuthors: [{ name: 'Francesco Colonna', id: 'Q27767305' }],
  }],
  ['Q131072', {
    source: 'catalog-override',
    reason: 'P50 的“传道者”（Q11740876）本身是匿名作者与化名身份，不是可确认的个人署名；按正文自称展示为佚名。',
    authors: [],
    displayAuthor: '佚名（文中自称‘传道者’）',
    removedAuthors: [{ name: '传道者', id: 'Q11740876' }],
  }],
  ['Q1206749', {
    source: 'catalog-override',
    reason: 'P50 的广博仙人（Q330521）属于传统托名/传说归属，无法作为该书的确定个人作者；按传统归属展示。',
    authors: [],
    displayAuthor: '传统归于广博仙人',
    removedAuthors: [{ name: '广博仙人', id: 'Q330521' }],
  }],
  ['Q1328292', {
    source: 'catalog-override',
    reason: 'P50 的广博仙人（Q330521）属于传统托名/传说归属，无法作为该书的确定个人作者；按传统归属展示。',
    authors: [],
    displayAuthor: '传统归于广博仙人',
    removedAuthors: [{ name: '广博仙人', id: 'Q330521' }],
  }],
  ['Q2531607', {
    source: 'catalog-override',
    reason: 'P50 的广博仙人（Q330521）属于传统托名/传说归属，无法作为该书的确定个人作者；按传统归属展示。',
    authors: [],
    displayAuthor: '传统归于广博仙人',
    removedAuthors: [{ name: '广博仙人', id: 'Q330521' }],
  }],
  ['Q8276', {
    source: 'catalog-override',
    reason: 'P50 的广博仙人（Q330521）属于传统托名/传说归属，无法作为该书的确定个人作者；按传统归属展示。',
    authors: [],
    displayAuthor: '传统归于广博仙人',
    removedAuthors: [{ name: '广博仙人', id: 'Q330521' }],
  }],
])
const GENERIC_AUTHOR_ENTITY_IDS = new Set(['Q1690980', 'Q2818964'])
const CANDIDATE_CACHE_SCHEMA = 'bookshelf-galaxy/rich-candidates-v2'
const CANDIDATE_QUERY_VERSION = 'zhwiki-literary-written-work-direct-allow-p31-v3'

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
let nextRequestAt = 0

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const [key, inline] = arg.slice(2).split('=', 2)
    if (inline !== undefined) options[key] = inline
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) options[key] = argv[++index]
    else options[key] = true
  }
  return options
}

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/\uFEFF/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function chineseCount(value) {
  return (String(value ?? '').match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu) || []).length
}

// The zh.wikipedia.org API keeps canonical page titles in their source
// variant even when `variant=zh-cn` converts the extract.  This compact
// display map handles the common traditional characters found in literary
// titles and labels while preserving the canonical URL in `wikipediaTitle`.
// The lead text itself is already converted by the API and is not rewritten.
const COMMON_TRADITIONAL = {
  亞: '亚', 體: '体', 來: '来', 個: '个', 們: '们', 偉: '伟', 傳: '传', 傷: '伤', 億: '亿', 兩: '两', 兒: '儿', 冊: '册', 冬: '冬', 冰: '冰', 凡: '凡', 劃: '划', 則: '则', 創: '创', 劇: '剧', 劉: '刘', 劍: '剑', 力: '力', 助: '助', 務: '务', 勝: '胜', 勞: '劳', 勢: '势', 匯: '汇', 區: '区', 卻: '却', 厭: '厌', 原: '原', 參: '参', 叢: '丛', 只: '只', 句: '句', 叭: '叭', 向: '向', 君: '君', 呂: '吕', 味: '味', 員: '员', 哥: '哥', 唯: '唯', 問: '问', 單: '单', 喬: '乔', 嗎: '吗', 圖: '图', 國: '国', 圍: '围', 團: '团', 坐: '坐', 堅: '坚', 報: '报', 場: '场', 塊: '块', 壓: '压', 壞: '坏', 壯: '壮', 壽: '寿', 夢: '梦', 夠: '够', 夾: '夹', 奧: '奥', 妝: '妆', 妹: '妹', 姊: '姐', 委: '委', 娛: '娱', 婦: '妇', 媒: '媒', 嫻: '娴', 孫: '孙', 學: '学', 實: '实', 寧: '宁', 寶: '宝', 專: '专', 對: '对', 導: '导', 將: '将', 尋: '寻', 尷: '尴', 屆: '届', 屬: '属', 岡: '冈', 島: '岛', 巖: '岩', 巢: '巢', 巿: '市', 師: '师', 帳: '帐', 帶: '带', 幫: '帮', 幹: '干', 幻: '幻', 庫: '库', 廁: '厕', 廣: '广', 廠: '厂', 廢: '废', 廟: '庙', 廚: '厨', 弔: '吊', 張: '张', 強: '强', 彈: '弹', 彙: '汇', 彥: '彦', 後: '后', 徑: '径', 復: '复', 從: '从', 徳: '德', 志: '志', 怪: '怪', 恆: '恒', 恥: '耻', 悅: '悦', 悶: '闷', 惡: '恶', 惱: '恼', 愛: '爱', 感: '感', 慘: '惨', 慶: '庆', 憂: '忧', 憑: '凭', 應: '应', 懷: '怀', 戀: '恋', 戰: '战', 戲: '戏', 戶: '户', 拔: '拔', 拋: '抛', 拳: '拳', 持: '持', 挾: '挟', 捨: '舍', 採: '采', 掛: '挂', 掃: '扫', 掙: '挣', 換: '换', 揚: '扬', 搖: '摇', 搶: '抢', 摘: '摘', 撲: '扑', 撰: '撰', 擊: '击', 擋: '挡', 據: '据', 擇: '择', 擺: '摆', 攝: '摄', 攜: '携', 攤: '摊', 故: '故', 敗: '败', 敘: '叙', 敵: '敌', 數: '数', 斂: '敛', 斷: '断', 於: '于', 既: '既', 時: '时', 晉: '晋', 暢: '畅', 暫: '暂', 曆: '历', 書: '书', 會: '会', 朮: '术', 東: '东', 果: '果', 架: '架', 柵: '栅', 楊: '杨', 業: '业', 極: '极', 樂: '乐', 標: '标', 樣: '样', 樹: '树', 機: '机', 橋: '桥', 櫻: '樱', 權: '权', 欣: '欣', 歡: '欢', 歲: '岁', 歷: '历', 歸: '归', 殘: '残', 殺: '杀', 殼: '壳', 毀: '毁', 母: '母', 每: '每', 氣: '气', 氫: '氢', 沒: '没', 沿: '沿', 況: '况', 洋: '洋', 流: '流', 海: '海', 涼: '凉', 淚: '泪', 混: '混', 淨: '净', 測: '测', 渾: '浑', 溫: '温', 滅: '灭', 滯: '滞', 滿: '满', 漁: '渔', 演: '演', 漢: '汉', 漲: '涨', 漸: '渐', 潛: '潜', 澤: '泽', 濃: '浓', 濟: '济', 濤: '涛', 瀉: '泻', 瀋: '沈', 灣: '湾', 為: '为', 烏: '乌', 無: '无', 煙: '烟', 照: '照', 燈: '灯', 燒: '烧', 爆: '爆', 父: '父', 爺: '爷', 牆: '墙', 牽: '牵', 物: '物', 狀: '状', 獨: '独', 獲: '获', 王: '王', 現: '现', 理: '理', 環: '环', 瓊: '琼', 畫: '画', 當: '当', 疇: '畴', 疊: '叠', 病: '病', 癡: '痴', 發: '发', 皺: '皱', 盜: '盗', 眾: '众', 睜: '睁', 矚: '瞩', 知: '知', 短: '短', 確: '确', 礦: '矿', 礙: '碍', 祕: '秘', 祿: '禄', 禍: '祸', 禪: '禅', 種: '种', 穀: '谷', 積: '积', 穿: '穿', 窮: '穷', 窩: '窝', 竄: '窜', 競: '竞', 章: '章', 童: '童', 筆: '笔', 策: '策', 答: '答', 算: '算', 節: '节', 範: '范', 簡: '简', 籍: '籍', 米: '米', 粉: '粉', 粗: '粗', 紅: '红', 純: '纯', 紙: '纸', 級: '级', 納: '纳', 細: '细', 組: '组', 結: '结', 絕: '绝', 統: '统', 絲: '丝', 經: '经', 綠: '绿', 維: '维', 綱: '纲', 網: '网', 綴: '缀', 線: '线', 緩: '缓', 練: '练', 總: '总', 績: '绩', 繁: '繁', 織: '织', 繪: '绘', 繼: '继', 續: '续', 纖: '纤', 缺: '缺', 罷: '罢', 羅: '罗', 群: '群', 義: '义', 習: '习', 翻: '翻', 耀: '耀', 聖: '圣', 聞: '闻', 聰: '聪', 職: '职', 肅: '肃', 肯: '肯', 育: '育', 背: '背', 能: '能', 腦: '脑', 腸: '肠', 腳: '脚', 臉: '脸', 臨: '临', 與: '与', 興: '兴', 舊: '旧', 舞: '舞', 艦: '舰', 艱: '艰', 花: '花', 苦: '苦', 萬: '万', 葉: '叶', 著: '著', 藝: '艺', 藥: '药', 藍: '蓝', 蘇: '苏', 蘭: '兰', 處: '处', 虛: '虚', 號: '号', 蛋: '蛋', 蝦: '虾', 蟲: '虫', 術: '术', 衛: '卫', 裝: '装', 裡: '里', 製: '制', 複: '复', 襲: '袭', 見: '见', 規: '规', 覺: '觉', 觀: '观', 解: '解', 觸: '触', 言: '言', 計: '计', 訊: '讯', 討: '讨', 訓: '训', 記: '记', 訪: '访', 設: '设', 許: '许', 診: '诊', 評: '评', 詞: '词', 詠: '咏', 試: '试', 詩: '诗', 認: '认', 誕: '诞', 語: '语', 說: '说', 調: '调', 談: '谈', 請: '请', 論: '论', 諸: '诸', 謝: '谢', 識: '识', 證: '证', 議: '议', 譯: '译', 讀: '读', 變: '变', 讓: '让', 貓: '猫', 貝: '贝', 貞: '贞', 負: '负', 財: '财', 貢: '贡', 貨: '货', 貧: '贫', 責: '责', 貴: '贵', 貿: '贸', 資: '资', 賈: '贾', 賊: '贼', 賞: '赏', 賢: '贤', 質: '质', 購: '购', 賣: '卖', 賽: '赛', 贈: '赠', 趕: '赶', 趙: '赵', 跡: '迹', 跑: '跑', 跨: '跨', 軍: '军', 軌: '轨', 軒: '轩', 軟: '软', 軸: '轴', 載: '载', 輕: '轻', 輪: '轮', 輸: '输', 輯: '辑', 辦: '办', 農: '农', 迴: '回', 進: '进', 逕: '径', 這: '这', 通: '通', 連: '连', 遊: '游', 運: '运', 過: '过', 遠: '远', 適: '适', 遲: '迟', 選: '选', 還: '还', 邊: '边', 邏: '逻', 郁: '郁', 鄉: '乡', 鄭: '郑', 酬: '酬', 醫: '医', 醜: '丑', 釀: '酿', 釋: '释', 鈴: '铃', 錄: '录', 錯: '错', 鍊: '炼', 鎖: '锁', 鏡: '镜', 鐵: '铁', 長: '长', 門: '门', 開: '开', 間: '间', 關: '关', 陰: '阴', 陽: '阳', 階: '阶', 際: '际', 隨: '随', 隱: '隐', 雙: '双', 雜: '杂', 離: '离', 難: '难', 電: '电', 霧: '雾', 靈: '灵', 靜: '静', 頁: '页', 頂: '顶', 順: '顺', 預: '预', 領: '领', 頭: '头', 顏: '颜', 類: '类', 顯: '显', 風: '风', 飛: '飞', 養: '养', 餓: '饿', 餘: '余', 館: '馆', 馬: '马', 驗: '验', 驚: '惊', 髮: '发', 鬥: '斗', 魚: '鱼', 鳥: '鸟', 鳳: '凤', 鷹: '鹰', 鹽: '盐', 麗: '丽', 黃: '黄', 黨: '党', 黴: '霉', 點: '点', 鼓: '鼓', 齊: '齐', 齡: '龄', 龍: '龙', 龜: '龟',
}

function toSimplified(value) {
  return String(value ?? '').replace(/[\u3400-\u9FFF]/gu, (character) => COMMON_TRADITIONAL[character] || character)
}

const DISPLAY_TITLE_MEDIA_MARKERS = /(?:书|書|书本|書本|著作|诗|詩|短篇小说集|短篇小說集|黑格尔著作|黑格爾著作|小说|小說|文学作品|文學作品|戏剧|戲劇|漫画|漫畫|诗歌|詩歌|书籍|書籍|传记|傳記|自传|自傳|回忆录|回憶錄|散文集|散文|剧本|劇本|图画小说|圖畫小說|儿童小说|兒童小說|英语小说|波兰小说|法语小说|日本小说|英文儿童小说|上座部|圣经|聖經)/u
const DISPLAY_TITLE_AUTHORISH = /^[\p{L}\p{N}][-\p{L}\p{N}·'’._\s]{1,31}$/u
const DISPLAY_TITLE_VOLUME = /^(?:上|下|前|后|第?[一二三四五六七八九十百0-9]+[卷册部篇]|卷[一二三四五六七八九十百0-9]+|part\s*[ivx0-9]+)$/iu

function isDisplayTitleDisambiguator(value) {
  const suffix = cleanText(value)
  if (!suffix || DISPLAY_TITLE_VOLUME.test(suffix)) return false
  return DISPLAY_TITLE_MEDIA_MARKERS.test(suffix) || DISPLAY_TITLE_AUTHORISH.test(suffix)
}

function displayTitle(value, workId = '') {
  const override = DISPLAY_TITLE_OVERRIDES.get(String(workId || '').toUpperCase())
  if (override) return override.value
  let title = toSimplified(value).trim()
  for (let pass = 0; pass < 3; pass += 1) {
    const match = title.match(/\s*[（(]([^（）()]*)[）)]\s*$/u)
    if (!match || !isDisplayTitleDisambiguator(match[1])) break
    const base = title.slice(0, match.index).trim()
    if (!base) break
    title = base
  }
  return title
}

function simplifyPunctuation(value) {
  return cleanText(value)
    .replace(/\s*\[\d+\]\s*/gu, ' ')
    .replace(/\s*（[^（）]{0,20}編輯）\s*/gu, ' ')
    .replace(/\s*\([^()]{0,20}編輯\)\s*/gu, ' ')
    .replace(/([。！？；：，、])\1+/gu, '$1')
    .trim()
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, stableJson(value), 'utf8')
  await rename(temporary, path)
}

function compactStatement(statement) {
  if (!statement || statement.rank === 'deprecated') return null
  const mainsnak = statement.mainsnak || {}
  return {
    ...(statement.id ? { id: statement.id } : {}),
    rank: statement.rank || 'normal',
    mainsnak: {
      snaktype: mainsnak.snaktype || 'novalue',
      property: mainsnak.property || null,
      ...(mainsnak.datavalue ? { datavalue: mainsnak.datavalue } : {}),
    },
  }
}

function compactEntity(entity) {
  if (!entity?.id) return null
  const claims = {}
  for (const [property, statements] of Object.entries(entity.claims || {})) {
    if (!ENTITY_CLAIM_PROPERTIES.has(property)) continue
    const compacted = (statements || []).map(compactStatement).filter(Boolean)
    if (compacted.length) claims[property] = compacted
  }
  const sitelinks = {}
  for (const site of ['zhwiki', 'enwiki']) {
    const sitelink = entity.sitelinks?.[site]
    if (sitelink?.title) sitelinks[site] = { site, title: sitelink.title }
  }
  return {
    id: entity.id,
    type: entity.type || 'item',
    ...(entity.lastrevid ? { lastrevid: entity.lastrevid } : {}),
    labels: entity.labels || {},
    descriptions: entity.descriptions || {},
    ...(entity.aliases ? { aliases: entity.aliases } : {}),
    claims,
    sitelinks,
  }
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

async function requestJson(url, { accept = 'application/json', retries = MAX_RETRIES } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const wait = Math.max(0, nextRequestAt - Date.now())
    if (wait) await sleep(wait)
    nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        headers: {
          accept,
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.5',
          'user-agent': USER_AGENT,
        },
        signal: controller.signal,
      })
      const body = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 160)}`)
      return JSON.parse(body)
    } catch (error) {
      lastError = error
      if (attempt >= retries) break
      const backoff = Math.min(12_000, 600 * (2 ** attempt))
      console.warn(`请求失败，${backoff}ms 后重试（${attempt + 1}/${retries}）：${error.message}`)
      await sleep(backoff)
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError || new Error(`Request failed: ${url}`)
}

function urlWithParams(base, params) {
  const url = new URL(base)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  return url.toString()
}

function chunks(values, size) {
  const output = []
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size))
  return output
}

function entityId(value) {
  const match = String(value ?? '').match(/Q\d+$/u)
  return match ? match[0] : ''
}

function claimValues(entity, property) {
  return claimStatements(entity, property)
    .map((claim) => claim?.mainsnak?.datavalue?.value)
    .filter((value) => value !== undefined && value !== null)
}

function claimStatements(entity, property) {
  return (entity?.claims?.[property] || [])
    .filter((claim) => claim?.rank !== 'deprecated')
}

function claimEntityIds(entity, property) {
  return claimValues(entity, property)
    .map((value) => entityId(value?.id || value))
    .filter(Boolean)
}

function claimString(entity, property) {
  const value = claimValues(entity, property)[0]
  if (!value) return ''
  if (typeof value === 'string') return cleanText(value)
  return cleanText(value.text || value.amount || value.time || '')
}

function claimYear(entity) {
  const values = []
  for (const property of ['P577', 'P580']) {
    for (const statement of claimStatements(entity, property)) {
      const value = statement?.mainsnak?.datavalue?.value
      const match = String(value?.time || value || '').match(/^([+-])(\d{4,})-/u)
      if (!match) continue
      const absoluteYear = Number(match[2])
      const year = match[1] === '-' ? -absoluteYear : absoluteYear
      if (Number.isInteger(year) && year !== 0 && year >= -5000 && year <= 2200) {
        values.push({ year, rank: statement.rank || 'normal' })
      }
    }
  }
  // A preferred statement is the editor's strongest signal.  Within that
  // rank, choose the earliest credible year so edition/reprint dates do not
  // displace the work's first appearance.  If no preferred statement exists,
  // use the same earliest-year rule over normal claims.
  const preferred = values.filter(({ rank }) => rank === 'preferred')
  const candidates = preferred.length ? preferred : values
  return candidates.reduce((earliest, { year }) => {
    if (earliest === null || year < earliest) return year
    return earliest
  }, null)
}

function localizedLabel(entity, languages = ['zh-cn', 'zh-hans', 'zh', 'en']) {
  for (const language of languages) {
    const value = entity?.labels?.[language]?.value
    if (value) return cleanText(value)
  }
  return ''
}

function localizedDescription(entity) {
  return localizedLabel({ labels: entity?.descriptions }, ['zh-cn', 'zh-hans', 'zh', 'en'])
}

function englishLabel(entity) {
  return cleanText(entity?.labels?.en?.value || '')
}

function claimLabelIds(entity, properties) {
  const ids = []
  for (const property of properties) ids.push(...claimEntityIds(entity, property))
  return [...new Set(ids)]
}

function pickTitle(entity, pageTitle) {
  const override = FOREIGN_TITLE_OVERRIDES.get(String(entity?.id || '').toUpperCase())
  if (override) {
    return {
      originalTitle: override.value,
      foreignTitle: override.value,
      override: { ...override },
    }
  }
  const titles = claimStatements(entity, 'P1476')
    .map((statement, order) => {
      const value = statement?.mainsnak?.datavalue?.value
      return {
        text: cleanText(value?.text),
        language: String(value?.language || ''),
        rank: statement.rank || 'normal',
        order,
      }
    })
    .filter((value) => value.text)
  const preferred = titles.filter((value) => value.rank === 'preferred')
  const rankedTitles = [...preferred, ...titles.filter((value) => value.rank !== 'preferred')]
  const englishClaim = preferred.find((value) => value.language === 'en')?.text
    || rankedTitles.find((value) => value.language === 'en')?.text
  // The product is Chinese-first and explicitly presents an English/foreign
  // secondary title. Prefer a preferred-rank P1476 first; within that rank,
  // prefer English, then fall back to an English normal-rank claim or label.
  const foreign = englishClaim || preferred[0]?.text || englishLabel(entity) || rankedTitles[0]?.text || pageTitle
  return { originalTitle: foreign, foreignTitle: foreign, override: null }
}

function pageUrl(title) {
  return `https://zh.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /gu, '_'))}`
}

function normalizeSummary(value) {
  // The plaintext fallback can include MediaWiki section headings.  They are
  // navigation markup, not book content, so remove them before measuring or
  // clipping the evidence shown in the product.
  const text = simplifyPunctuation(value)
    .replace(/={2,}\s*[^=]+\s*={2,}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (text.length <= 600) return text
  // Prefer a sentence boundary so the card never ends with a dangling clause.
  const clipped = text.slice(0, 600)
  const boundary = Math.max(clipped.lastIndexOf('。'), clipped.lastIndexOf('！'), clipped.lastIndexOf('？'))
  return (boundary >= 180 ? clipped.slice(0, boundary + 1) : clipped).trim()
}

function wikiTitleKey(value) {
  return cleanText(String(value ?? '').replace(/_/gu, ' ')).normalize('NFKC').toLocaleLowerCase('zh-CN')
}

function looksLikePlaceholder(summary) {
  const text = cleanText(summary)
  return !text
    || /尚无简介|暂无简介|需要补充|正在編寫|正在编写|没有描述|可能指|本條目需要|消歧義/iu.test(text)
    || chineseCount(text) < 120
}

const THEME_SOURCE = Object.freeze({
  WIKIDATA: 'wikidata-claim',
  SUMMARY: 'summary-rule',
  CONTEXT: 'contextual-metadata',
  GENERIC: 'generic-last-resort',
})

// A small, auditable quarantine for high-confidence false positives found in
// the final evidence pass.  These are not claims about the books; they are
// explicit guardrails against known lead-section traps (book-title words,
// reviews, author context, form/technique notes and incidental events).  Keep
// this list in the builder as well as the offline checker: a future rebuild
// must remove the same unsupported theme rather than silently reintroduce it.
const THEME_REGRESSION_EXCLUSIONS = new Map([
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

// These rules are deliberately a controlled ontology rather than a bag of
// broad words.  A rule must name a concrete narrative concern; standalone
// matches such as “人”“社会”“生活”“历史” and “文学” are intentionally not
// accepted.  Keeping the patterns in one auditable table also makes the
// generated themeProvenance explainable to a reviewer.
const SUMMARY_THEME_RULES = [
  ['权力与政治', /权力斗争|政治斗争|政治权力|政治制度|政治阴谋|政治运动|政治压迫|政治改革|政治冲突|政治寓言|政治讽刺|政权|统治|官僚|议会|选举|政党|独裁|专制|君主|政府统治|政府压迫|政府腐败|宫廷|革命运动|革命斗争|革命历史|暴政/iu],
  ['帝国与殖民', /帝国主义|帝国扩张|帝国|殖民主义|(?<!马尼托巴)殖民地|殖民统治|(?<!工资)奴隶制|奴役|种族隔离|征服与占领/iu],
  ['科学与技术', /科学幻想|科幻小说|科幻文学|科学技术|科学研究|科学家|技术革命|发明|实验室|(?:软件|航天|机械|电子|计算机|航空|核能)工程师|计算机|人工智能|机器人|基因|医学技术|航天|太空探索|互联网|核能|量子/iu],
  ['文明与未来', /文明兴衰|文明存亡|未来社会|末日|世界毁灭|人类灭绝|反乌托邦|乌托邦|星际|宇宙|外星文明|人类终局/iu],
  ['记忆与时间', /历史记忆|集体记忆|失忆|遗忘|时间旅行|循环时间|记忆|回忆|往事|时光流逝|过去与未来/iu],
  ['身份与自我', /身份认同|性别认同|自我认同|主体性|人格分裂|寻找自我|自我发现|身份危机|性别角色/iu],
  ['孤独与异化', /孤独|异化|疏离|孤立|荒诞|无意义|异乡人|边缘人|隔绝|精神困境|被抛弃/iu],
  ['家族与代际', /家族史|家族兴衰|家族关系|家族命运|家族伦理|家族冲突|家族秘密|家庭关系|父子|母女|亲兄弟|兄弟关系|兄弟二人|两兄弟|兄妹|姊妹关系|姐妹关系|姐妹二人|两姐妹|亲子|代际|血缘|家业继承|王位继承/iu],
  ['阶级与贫困', /阶级矛盾|阶级冲突|社会阶级|阶级|贫困|贫穷|饥饿|底层|工人阶级|劳工|劳动剥削|资本剥削|贫民|不平等/iu],
  ['迁徙与乡土', /被迫迁徙|人口迁徙|移民生活|移民经历|移民家庭|移民群体|被迫流亡|流亡生活|流亡经历|流亡者|离散群体|离散经验|漂泊生活|返乡|乡土|乡村|农村|(?<!作者的)故乡|土地|农民|边地|流离失所/iu],
  ['自由与压迫', /思想自由|言论自由|个人自由|自由意志|争取自由|追求自由|获得自由|失去自由|重获自由|压迫|监视|审查制度|政治审查|禁锢|囚禁|规训|控制社会|反抗压迫|服从权力|逃亡/iu],
  ['司法与正义', /司法正义|法律|司法|正义|(?<!末日)审判|法庭|(?:律师.{0,20}(?:案件|辩护|辯護|法庭|诉讼|訴訟)|(?:案件|法庭|诉讼|訴訟).{0,20}律师)|罪行|犯罪|谋杀|侦探|悬疑|推理|案件|刑罚|冤案/iu],
  ['生态与环境', /生态危机|生态环境|生态系统|生态灾难|环境保护|环境危机|气候变化|环境污染|自然环境|人与自然|海洋生态|森林生态|野生动物|植物生态|荒漠化|河流生态/iu],
  ['艺术与创作', /艺术创作|文学创作|创作过程|写作生涯|画家|绘画艺术|绘画创作|音乐家|作曲家|摄影师|舞台艺术|艺术家/iu],
  ['身体与疾病', /身体疾病|病痛|疾病|医学|癌症|心脏病|精神疾病|残疾|衰老|身体政治|生育|身体边界/iu],
  ['爱情与亲密关系', /爱情|恋爱|婚姻|亲密关系|恋人|情欲|夫妻|婚姻困境|爱情悲剧/iu],
  ['成长与教育', /人物成长|成长经历|成长过程|成长试炼|青春成长|青春期|少年主人公|童年经历|成年礼|教育制度|教育问题|学校生活|校园生活|求学经历|师生关系|老师与学生/iu],
  ['战争与创伤', /战争题材|战争经历|战争创伤|战争中的|战争期间|卷入战争|战乱|军事冲突|战役|军队|战俘|战后创伤|战后社会|战后重建|战后困境|战后生活|战后记忆|前线|革命战争/iu],
  ['历史记忆', /历史背景|历史时期|朝代|王朝|编年|历史事件|历史人物|传记(?!体裁|形式|手法)|年代变迁/iu],
  ['城市与现代性', /现代性|现代都市|城市生活|都市|工业化|资本主义|城市化|现代社会/iu],
  // Bare “神话/传说” is deliberately excluded: it turns incidental phrases
  // such as “民间传说”, the software classic《人月神话》, or a metaphorical
  // title into supernatural evidence.  Keep only genre/subject phrases whose
  // surrounding wording actually identifies mythic or supernatural content.
  ['神话与超自然', /幻想文学|幻想小说|幻想故事|奇幻小说|奇幻文学|魔法|神话故事|神话传说|神话体系|神话人物|神话题材|神话小说|神话叙事|神话改编|民间神话|创世神话|希腊神话|罗马神话|北欧神话|中国神话|古代神话|苏美尔神话|克苏鲁神话|英雄传说|超自然|鬼故事|鬼魂|巫术|神魔|异世界/iu],
  ['哲学与信仰', /哲学思考|哲学思想|哲学问题|宗教信仰|佛教经典|印度教经典|佛经|佛陀|湿婆|濕婆|信仰危机|伦理困境|道德困境|存在主义|神学思想|神学问题|灵魂|罪与救赎/iu],
  ['苦难与救赎', /苦难|救赎|悲剧|死亡|创伤|生存困境|尊严|悔恨|幸存/iu],
  ['旅行与远方', /旅行|冒险|航海|远方|探险|漂流|返乡之旅|旅途/iu],
]

// Wikidata labels are useful evidence, but raw P136/P921 labels often
// contain “文学作品”“社会”等不能解释书间关系的上位词.  Map only labels
// that land in the same controlled ontology and drop the rest.  This keeps
// claims auditable without allowing a noisy label vocabulary into the graph.
const WIKIDATA_THEME_RULES = [
  ['帝国与殖民', /帝国主义|帝国|殖民主义|殖民地|殖民统治|奴隶制|奴役|种族隔离/iu],
  ['权力与政治', /政治小说|政治寓言|政治讽刺|政治|权力|政权|统治|官僚|独裁|专制|君主制|政治哲学/iu],
  ['科学与技术', /科学幻想|科学小说|科学技术|科学家|技术|发明|工程|计算机|人工智能|机器人|基因|航天|太空|科幻/iu],
  ['文明与未来', /文明|未来主义|乌托邦|反乌托邦|末日|世界末日|星际|外星|人类终局/iu],
  ['记忆与时间', /记忆|时间|失忆|遗忘|回忆|年代|历史记忆/iu],
  ['身份与自我', /身份|自我|主体性|人格|性别认同|身份认同/iu],
  ['孤独与异化', /孤独|异化|疏离|荒诞|存在主义|边缘人|异乡人/iu],
  ['家族与代际', /家族|家庭|父子|母女|亲子|代际|血缘|继承/iu],
  ['阶级与贫困', /阶级|贫困|贫穷|工人|劳动|剥削|不平等|贫民/iu],
  ['迁徙与乡土', /乡土|乡村|农村|移民|流亡|离散|漂泊|故乡|边地/iu],
  ['自由与压迫', /自由|压迫|监视|审查|禁锢|囚禁|规训|反抗|暴政/iu],
  ['司法与正义', /法律|司法|正义|审判|法庭|犯罪|谋杀|侦探|悬疑|推理|刑罚/iu],
  ['生态与环境', /生态|环境|气候|污染|自然|海洋|森林|动物|植物|荒漠/iu],
  ['艺术与创作', /艺术|创作|作家|绘画|画家|音乐|诗歌|电影|摄影|舞台|艺术家/iu],
  ['身体与疾病', /身体|疾病|病痛|医学|癌症|残疾|衰老|生育/iu],
  ['爱情与亲密关系', /爱情|恋爱|婚姻|情欲|恋人|夫妻|亲密关系/iu],
  ['成长与教育', /成长|青春|教育|少年|童年|成年|校园/iu],
  ['战争与创伤', /战争|战乱|军事|战役|军队|战俘|战后|革命/iu],
  ['历史记忆', /历史小说|历史剧|历史诗|朝代|王朝|传记|编年/iu],
  ['城市与现代性', /现代性|都市|城市|工业化|资本主义|城市化/iu],
  ['神话与超自然', /(?<!科学)幻想|奇幻|魔法|神话|传说|超自然|鬼魂|巫术|神魔/iu],
  ['哲学与信仰', /哲学|宗教|信仰|伦理|道德|神学|灵魂/iu],
  ['苦难与救赎', /苦难|救赎|悲剧|死亡|创伤|生存|悔恨/iu],
  ['旅行与远方', /旅行|冒险|航海|探险|漂流|远方/iu],
]

// Form/type labels are only used as a contextual fallback.  These are
// intentionally more specific than “小说” or “文学作品”, which are
// rejected because they create a false high-degree hub in the galaxy.
const TYPE_THEME_RULES = [
  ['长篇小说', /长篇小说|长篇叙事/iu],
  ['短篇小说', /短篇小说|短篇故事/iu],
  ['科幻小说', /科幻小说/iu],
  ['历史小说', /历史小说/iu],
  ['侦探小说', /侦探小说/iu],
  ['推理小说', /推理小说/iu],
  ['奇幻小说', /奇幻小说/iu],
  ['恐怖小说', /恐怖小说/iu],
  ['爱情小说', /爱情小说/iu],
  ['战争小说', /战争小说/iu],
  ['武侠小说', /武侠小说/iu],
  ['乌托邦小说', /乌托邦小说/iu],
  ['反乌托邦小说', /反乌托邦小说/iu],
  ['图像小说', /图像小说|漫画/iu],
  ['戏剧', /戏剧|剧作|剧本/iu],
  ['诗歌', /诗歌|诗集/iu],
  ['史诗', /史诗/iu],
  ['散文', /散文/iu],
  ['传记', /传记/iu],
  ['自传', /自传/iu],
  ['回忆录', /回忆录/iu],
  ['童话', /童话/iu],
  ['宗教经典', /佛经|经书|經書|宗教经典|宗教經典|佛教典籍|大乘经|大乘經|契经|契經|往世书|往世書|圣经|聖經/iu],
  ['寓言', /寓言/iu],
  ['书信集', /书信|书简/iu],
  ['日记', /日记/iu],
]

const UNSUITABLE_WIKIDATA_THEME = /^(?:文学|文学作品|小说|故事|作品|著作|虚构作品|虚构文学|文艺|艺术作品|题材|主题|人|人类|社会|生活|语言|中文|汉语|英语|法语|俄语|日语|德语|文学体裁|书籍|出版物)$/iu
const GENERIC_LAST_RESORT_THEMES = ['文本叙事', '作品语境', '阅读路径']
const THEME_SOURCE_RANK = new Map([
  [THEME_SOURCE.WIKIDATA, 0],
  [THEME_SOURCE.SUMMARY, 1],
  [THEME_SOURCE.CONTEXT, 2],
  [THEME_SOURCE.GENERIC, 3],
])

function normalizedThemeLabel(value) {
  return toSimplified(cleanText(value)).replace(/[：:]+$/u, '').trim()
}

function controlledWikidataTheme(label) {
  const normalized = normalizedThemeLabel(label)
  if (!normalized || chineseCount(normalized) < 2 || UNSUITABLE_WIKIDATA_THEME.test(normalized)) return ''
  const matched = WIKIDATA_THEME_RULES.find(([, pattern]) => pattern.test(normalized))
  return matched?.[0] || ''
}

const THEME_NARRATIVE_ANCHOR = /讲述|讲解|描写|描绘|描述|叙述|记述|记录|围绕|聚焦|探讨|讨论|研究|阐述|反映|刻画|展现|呈现|表现|涉及|涵盖|故事(?:发生|内容|讲述)|主人公|主角|题材|主题|以.{0,36}为(?:背景|主线|主题)/iu
const THEME_BIBLIOGRAPHIC_NOISE = /出版|发行|连载|刊载|登载|收录|目录|再版|版本|译本|翻译|销量|畅销|获奖|奖项|提名|评论|评价|批评|争议|官司|版权|出版社|杂志|报刊|改编|翻拍|上映|播出|导演|编剧|电视剧|电影|动画|漫画版|游戏/iu
const THEME_CONTEXT_NOISE = /并非|不是|不以|不涉及|较少涉及|很少涉及|未涉及|没有涉及|没有使用|未使用|很少使用|几乎没有|无关|《百年孤独》|另一本|另一部|致敬|纪念.{0,30}(?:作家|作者)|家庭画家|马尼托巴殖民地|门诺派.{0,30}殖民地|殖民地.{0,30}门诺派|自由间接话语|自由间接引语|革命性|灵感|启发|前者|后者|其他作品|其余作品|另.{0,8}作品|作者(?:曾|还|也|另)|(?:作者|作家).{0,24}(?:其他)?(?:作品|三部曲)|(?:作者|作家|诗人|小说家|剧作家|雨果).{0,16}流亡|(?:战争|战役)之后|生态女性主义者|顾问|任职|履历|毕业|就读|教授|基金会/iu

function narrativeThemeSentences(summary) {
  return cleanText(summary)
    .split(/(?<=[。！？!?])\s*/u)
    .map((sentence) => cleanText(sentence))
    .filter((sentence) => sentence.length >= 12 && sentence.length <= 420)
    .filter((sentence) => THEME_NARRATIVE_ANCHOR.test(sentence) && !THEME_BIBLIOGRAPHIC_NOISE.test(sentence) && !THEME_CONTEXT_NOISE.test(sentence))
}

function inferThemes(_title, summary) {
  const result = []
  // Only sentences that explicitly describe subject matter, plot or argument
  // may generate a narrative theme. Publication, adaptation, award, review and
  // author-biography sentences are excluded: matching the entire lead made a
  // trial after publication look like the novel's legal theme, or a magazine
  // title containing “少年” look like a coming-of-age story.
  const sentences = narrativeThemeSentences(summary)
  for (const [theme, pattern] of SUMMARY_THEME_RULES) {
    const evidence = sentences.find((sentence) => pattern.test(sentence))
    if (evidence) result.push({ theme, source: THEME_SOURCE.SUMMARY, evidence: evidence.slice(0, 180) })
  }
  return result
}

function themeLabels(work, entityMap) {
  const ids = claimLabelIds(work, ['P136', 'P921', 'P1269', 'P642'])
  const result = []
  for (const id of ids) {
    const label = localizedLabel(entityMap[id])
    const theme = controlledWikidataTheme(label)
    if (theme) result.push({ theme, source: THEME_SOURCE.WIKIDATA, evidence: `Wikidata 结构化主题：${normalizedThemeLabel(label)}` })
  }
  return result
}

function typeThemeLabels(work, entityMap) {
  const ids = claimLabelIds(work, ['P31', 'P136'])
  const result = []
  for (const id of ids) {
    const label = normalizedThemeLabel(localizedLabel(entityMap[id]))
    if (!label || UNSUITABLE_WIKIDATA_THEME.test(label)) continue
    const matched = TYPE_THEME_RULES.find(([, pattern]) => pattern.test(label))
    if (matched) result.push({ theme: matched[0], source: THEME_SOURCE.CONTEXT, evidence: `Wikidata 类型或体裁：${label}` })
  }
  return result
}

const REGION_LABELS = new Set(['欧洲', '亚洲', '非洲', '拉丁美洲', '中东', '东亚', '南亚', '东南亚', '北欧', '南欧', '东欧', '西欧'])
const COUNTRY_ENTITY_OVERRIDES = new Map([
  ['Q1574130', '战国韩国'],
])
const COUNTRY_THEME_OVERRIDES = new Map([
  ['中华人民共和国', '中国文学'],
  ['中国', '中国文学'],
  ['中华民国', '中国文学'],
  ['大不列颠及北爱尔兰联合王国', '英国文学'],
  ['英国', '英国文学'],
  ['英格兰', '英国文学'],
  ['法兰西共和国', '法国文学'],
  ['法国', '法国文学'],
  ['德意志联邦共和国', '德国文学'],
  ['德国', '德国文学'],
  ['俄罗斯联邦', '俄罗斯文学'],
  ['俄罗斯', '俄罗斯文学'],
  ['俄国', '俄国文学'],
  ['苏联', '苏联文学'],
  ['美利坚合众国', '美国文学'],
  ['美国', '美国文学'],
  ['日本', '日本文学'],
  ['大韩民国', '韩国文学'],
  ['韩国', '韩国文学'],
  ['战国韩国', '战国韩国文献'],
  ['意大利共和国', '意大利文学'],
  ['意大利', '意大利文学'],
  ['西班牙', '西班牙文学'],
  ['葡萄牙', '葡萄牙文学'],
  ['印度', '印度文学'],
  ['伊朗', '伊朗文学'],
  ['埃及', '埃及文学'],
  ['希腊', '希腊文学'],
])

function countryThemeLabel(country) {
  const normalized = normalizedThemeLabel(country)
  if (!normalized || normalized === '未注明' || chineseCount(normalized) < 2) return ''
  if (COUNTRY_THEME_OVERRIDES.has(normalized)) return COUNTRY_THEME_OVERRIDES.get(normalized)
  if (REGION_LABELS.has(normalized)) return `${normalized}地域书写`
  // P495 is a country-of-origin claim.  For an otherwise untranslated
  // country label this compact form remains honest while avoiding language
  // as a proxy for a literary region.
  if (normalized.length >= 2 && normalized.length <= 16) return `${normalized}文学`
  return ''
}

function centuryThemeLabel(year) {
  if (!Number.isInteger(year) || year === 0 || Math.abs(year) > 3000) return ''
  const century = Math.floor((Math.abs(year) - 1) / 100) + 1
  return year < 0 ? `公元前${century}世纪作品` : `${century}世纪作品`
}

function contextualThemes(work, entityMap, country, year) {
  const result = []
  const countryTheme = countryThemeLabel(country)
  if (countryTheme) result.push({ theme: countryTheme, source: THEME_SOURCE.CONTEXT, evidence: `Wikidata 来源国家或地区：${country}` })
  const centuryTheme = centuryThemeLabel(year)
  if (centuryTheme) result.push({ theme: centuryTheme, source: THEME_SOURCE.CONTEXT, evidence: `Wikidata 作品年代：${year}` })
  result.push(...typeThemeLabels(work, entityMap))
  return result
}

function addThemeEntry(entries, entry) {
  const theme = normalizedThemeLabel(entry?.theme)
  const source = entry?.source
  if (!theme || !THEME_SOURCE_RANK.has(source)) return
  const existingIndex = entries.findIndex((item) => item.theme === theme)
  if (existingIndex < 0) {
    entries.push({ theme, source, ...(cleanText(entry?.evidence) ? { evidence: cleanText(entry.evidence) } : {}) })
    return
  }
  const existing = entries[existingIndex]
  if (THEME_SOURCE_RANK.get(source) < THEME_SOURCE_RANK.get(existing.source)) {
    entries[existingIndex] = { theme, source, ...(cleanText(entry?.evidence) ? { evidence: cleanText(entry.evidence) } : {}) }
  }
}

function buildThemes(title, summary, metadata, work, entityMap, country, year) {
  const entries = []
  for (const entry of themeLabels(work, entityMap)) addThemeEntry(entries, entry)
  for (const entry of inferThemes(title, summary, metadata)) addThemeEntry(entries, entry)
  if (entries.length < 3) {
    for (const entry of contextualThemes(work, entityMap, country, year)) {
      addThemeEntry(entries, entry)
      if (entries.length >= 8) break
    }
  }
  const excluded = THEME_REGRESSION_EXCLUSIONS.get(work?.id)
  const retained = entries.filter(({ theme }) => !excluded?.has(theme))
  // Regression exclusions are deliberately applied after evidence inference.
  // Refill only after that removal so every displayed book still has three
  // honest navigation labels instead of leaking a known false-positive theme.
  if (retained.length < 3) {
    for (const theme of GENERIC_LAST_RESORT_THEMES) {
      addThemeEntry(retained, { theme, source: THEME_SOURCE.GENERIC, evidence: '目录完整性使用的受控兜底标签；不作为关系的独立依据' })
      if (retained.length >= 3) break
    }
  }
  return retained.slice(0, 8)
}

function authorIdentityKeys(value) {
  const normalized = toSimplified(cleanText(value))
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
  const compact = normalized.replace(/[^\p{L}\p{N}]+/gu, '')
  if (!compact) return []
  const keys = [compact]
  // Wikidata's P2093 often stores only the Latin surname (for example
  // "Rousseau"), while P50 stores "Jean-Jacques Rousseau".  Treat the final
  // token as an alias, but do not use fuzzy substrings that could erase real
  // co-authors.
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) || []
  if (tokens.length > 1) keys.push(tokens[tokens.length - 1])
  return [...new Set(keys)]
}

function entityAliasValues(entity) {
  const values = []
  for (const label of Object.values(entity?.labels || {})) {
    if (label?.value) values.push(label.value)
  }
  for (const aliases of Object.values(entity?.aliases || {})) {
    for (const alias of Array.isArray(aliases) ? aliases : [aliases]) {
      if (alias?.value) values.push(alias.value)
    }
  }
  return values
}

function genericAuthorEntity(entityIdValue, name) {
  if (GENERIC_AUTHOR_ENTITY_IDS.has(entityIdValue)) return true
  return /^(?:group of authors|various authors|多位作家|众多作家|不详作者|未知作者)$/iu.test(cleanText(name))
}

function authorRecords(work, entityMap) {
  const records = []
  const seen = new Set()
  const p50IdentityKeys = new Set()
  const add = ({ name, source, id, statementId, reason }) => {
    const normalized = toSimplified(cleanText(name))
    if (!normalized || seen.has(normalized) || genericAuthorEntity(id, normalized)) return
    seen.add(normalized)
    records.push({
      name: normalized,
      source,
      ...(id ? { id } : {}),
      ...(statementId ? { statementId } : {}),
      ...(reason ? { reason } : {}),
    })
  }

  // Keep Wikidata's statement order for deterministic rendering. When an
  // editor has marked P50 as preferred, normal-rank competing attributions
  // are not co-authors; otherwise retain all normal-rank P50 authors.
  const p50Statements = claimStatements(work, 'P50')
  const preferredP50 = p50Statements.filter((statement) => statement.rank === 'preferred')
  const selectedP50 = preferredP50.length
    ? preferredP50
    : p50Statements.filter((statement) => statement.rank !== 'preferred')
  // P50 names are auditable entities; their labels and aliases form the
  // conservative identity set used to filter duplicate P2093 surname literals.
  for (const statement of selectedP50) {
    const value = statement?.mainsnak?.datavalue?.value
    const id = entityId(value?.id || value)
    if (!id) continue
    const entity = entityMap[id]
    const name = localizedLabel(entity)
    if (genericAuthorEntity(id, name)) continue
    for (const identity of entityAliasValues(entity)) {
      for (const key of authorIdentityKeys(identity)) p50IdentityKeys.add(key)
    }
    add({
      name,
      source: 'wikidata:P50',
      id,
      statementId: statement.id,
    })
  }
  for (const statement of claimStatements(work, 'P2093')) {
    const value = statement?.mainsnak?.datavalue?.value
    const name = typeof value === 'string' ? value : value?.text
    // With an entity author present, only absorb a literal when it does not
    // match any P50 label/alias. This preserves genuine named co-authors while
    // removing surname duplicates such as Rousseau/Anderson/Shute/Lagerlof.
    if (p50IdentityKeys.size && authorIdentityKeys(name).some((key) => p50IdentityKeys.has(key))) continue
    add({
      name,
      source: 'wikidata:P2093',
      statementId: statement.id,
    })
  }
  return records
}

function authorName(authors) {
  const names = authors.map((author) => author.name)
  if (!names.length) return '佚名'
  return names.length <= 3 ? names.join('、') : `${names.slice(0, 2).join('、')}等`
}

function namedAuthorCount(authors) {
  return (Array.isArray(authors) ? authors : [])
    .filter((author) => /^Q\d+$/u.test(String(author?.id || '')) && cleanText(author?.name)).length
}

function languageName(work, entityMap) {
  const label = claimEntityIds(work, 'P407')
    .map((id) => localizedLabel(entityMap[id]))
    .filter(Boolean)[0]
  return toSimplified(label || '未注明')
}

function countryName(work, entityMap) {
  const label = claimEntityIds(work, 'P495')
    .map((id) => COUNTRY_ENTITY_OVERRIDES.get(id) || localizedLabel(entityMap[id]))
    .filter(Boolean)[0]
  return toSimplified(label || '未注明')
}

function openLibraryId(work) {
  return claimString(work, 'P648').replace(/^olid:/iu, '').trim() || null
}

function entityCompleteness(fields) {
  const tracked = ['originalTitle', 'authors', 'year', 'language', 'country', 'themes', 'openLibraryId']
  const filled = tracked.filter((key) => {
    const value = fields[key]
    if (key === 'authors') return namedAuthorCount(value) > 0
    return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== '' && value !== '未注明' && value !== '佚名'
  }).length
  return Number((filled / tracked.length).toFixed(3))
}

function mergeRequiredCandidates(candidates) {
  const byId = new Map((Array.isArray(candidates) ? candidates : []).map((candidate) => [candidate.id, candidate]))
  for (const candidate of REQUIRED_CANDIDATES) {
    if (byId.has(candidate.id)) continue
    byId.set(candidate.id, {
      ...candidate,
      article: pageUrl(candidate.title),
    })
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id) || left.title.localeCompare(right.title))
}

async function getCandidates(limit, refresh, candidateMultiplier = DEFAULT_CANDIDATE_MULTIPLIER) {
  const cachePath = resolve(RAW_DIR, 'wdqs-candidates.json')
  const queryLimit = Math.min(25_000, Math.max(limit * candidateMultiplier, limit + 500))
  const cached = refresh ? null : await readJson(cachePath, null)
  if (!refresh) {
    // v1 stored only the candidate array.  It came from a deliberately broad
    // WDQS literary/written-work superset, so it is safe to reuse as input:
    // every candidate is still re-evaluated from its direct, non-deprecated
    // P31 statements by the shared fail-closed policy before publication.
    // Keeping this migration path also makes interrupted public-API builds
    // resumable instead of forcing another expensive WDQS query.
    if (Array.isArray(cached) && cached.length >= limit) {
      const descriptor = 'cached WDQS literary/written-work superset; local direct-P31 fail-closed eligibility filter'
      return {
        candidates: mergeRequiredCandidates(cached),
        queryHash: hash(descriptor),
        queryLimit: cached.length,
        queryComplete: true,
        queryVersion: 'cached-wdqs-superset-direct-p31-filter-v1',
        queryMethod: descriptor,
      }
    }
    if (cached?.schemaVersion === CANDIDATE_CACHE_SCHEMA
      && cached.queryVersion === CANDIDATE_QUERY_VERSION
      && Array.isArray(cached.candidates)
      && (cached.queryComplete === true || cached.candidates.length >= queryLimit)) {
      return {
        candidates: mergeRequiredCandidates(cached.candidates),
        queryHash: cached.queryHash || null,
        queryLimit: cached.queryLimit || cached.candidates.length,
        queryComplete: cached.queryComplete === true,
        queryVersion: cached.queryVersion,
        queryMethod: cached.queryMethod || 'WDQS Chinese Wikipedia sitelink + direct P31 allowlist',
      }
    }
  }
  // Keep candidates bounded to direct P31 statements. A subclass path admits
  // noisy pages such as platforms, government reports and media franchises;
  // the shared policy below then applies the same allow/deny evidence again.
  //
  // The previous implementation put every allowed type in one VALUES clause
  // and asked WDQS for thousands of rows. That query is both prone to the
  // endpoint's 45-second timeout and impossible to resume halfway through.
  // Query one fixed P31 at a time, in deterministic, small OFFSET pages. Each
  // page stores the unmodified WDQS response and its parsed candidates before
  // the aggregate cache is advanced, so an interrupted run can continue from
  // the last completed page without relaxing the eligibility policy.
  const queryMethod = 'WDQS Chinese Wikipedia sitelink + one direct P31 type per sorted page'
  const pageSchema = `${CANDIDATE_CACHE_SCHEMA}/page`
  const pageDir = resolve(RAW_DIR, 'wdqs-candidate-pages')
  const queryDescriptor = JSON.stringify({
    queryVersion: CANDIDATE_QUERY_VERSION,
    queryLimit,
    pageSize: CANDIDATE_PAGE_SIZE,
    directP31: ALLOW_P31,
    queryMethod,
  })
  const aggregateQueryHash = hash(queryDescriptor)
  const unique = []
  const seen = new Set()

  const addCandidates = (values) => {
    for (const candidate of values || []) {
      if (!candidate?.id || !candidate.title || !candidate.article?.startsWith('https://zh.wikipedia.org/')) continue
      if (seen.has(candidate.id)) continue
      seen.add(candidate.id)
      unique.push(candidate)
    }
  }

  // A partial aggregate cache is useful even when an older page cache was
  // removed. It is only a candidate seed: every item still goes through the
  // same entity and fail-closed eligibility checks later in this builder.
  if (cached?.schemaVersion === CANDIDATE_CACHE_SCHEMA
    && cached.queryVersion === CANDIDATE_QUERY_VERSION
    && Array.isArray(cached.candidates)) {
    addCandidates(cached.candidates)
  }

  const pageQuery = (directType, pageIndex) => {
    const offset = pageIndex * CANDIDATE_PAGE_SIZE
    const query = `
SELECT DISTINCT ?item ?article ?articleTitle WHERE {
  ?article schema:about ?item ;
           schema:isPartOf <https://zh.wikipedia.org/> ;
           schema:name ?articleTitle .
  ?item wdt:P31 wd:${directType} .
  FILTER(!CONTAINS(STR(?articleTitle), "(消歧义)"))
  FILTER(!CONTAINS(STR(?articleTitle), "列表"))
}
ORDER BY ?item
LIMIT ${CANDIDATE_PAGE_SIZE}
OFFSET ${offset}`
    return { query, offset }
  }

  const parseBindings = (bindings, directType) => (bindings || [])
    .map((binding) => ({
      id: entityId(binding.item?.value),
      title: cleanText(binding.articleTitle?.value),
      article: binding.article?.value || '',
      directType,
    }))
    .filter((candidate) => candidate.id
      && candidate.title
      && candidate.article.startsWith('https://zh.wikipedia.org/'))

  const pageStates = ALLOW_P31.map((directType) => ({
    directType,
    nextPage: 0,
    complete: false,
  }))
  let reachedTarget = unique.length >= queryLimit

  for (const state of pageStates) {
    while (!state.complete && !reachedTarget) {
      const pageIndex = state.nextPage
      const { query, offset } = pageQuery(state.directType, pageIndex)
      const pagePath = resolve(pageDir, `direct-${state.directType}-page-${String(pageIndex).padStart(5, '0')}.json`)
      const pageQueryHash = hash(query)
      let pageCache = null
      if (!refresh) {
        const saved = await readJson(pagePath, null)
        if (saved?.schemaVersion === pageSchema
          && saved.queryVersion === CANDIDATE_QUERY_VERSION
          && saved.directType === state.directType
          && saved.page === pageIndex
          && saved.pageSize === CANDIDATE_PAGE_SIZE
          && saved.queryHash === pageQueryHash
          && Array.isArray(saved.candidates)
          && saved.response) {
          pageCache = saved
        }
      }

      if (!pageCache) {
        const url = urlWithParams(WDQS_URL, { query, format: 'json' })
        console.log(`从 WDQS 获取 ${state.directType} 第 ${pageIndex + 1} 页（${offset}–${offset + CANDIDATE_PAGE_SIZE - 1}）…`)
        const response = await requestJson(url)
        const bindings = response?.results?.bindings || []
        const pageCandidates = parseBindings(bindings, state.directType)
        pageCache = {
          schemaVersion: pageSchema,
          queryVersion: CANDIDATE_QUERY_VERSION,
          queryHash: pageQueryHash,
          queryMethod,
          directType: state.directType,
          page: pageIndex,
          offset,
          pageSize: CANDIDATE_PAGE_SIZE,
          resultCount: bindings.length,
          pageComplete: bindings.length < CANDIDATE_PAGE_SIZE,
          fetchedAt: new Date().toISOString(),
          requestUrl: url,
          response,
          candidates: pageCandidates,
        }
        await writeJson(pagePath, pageCache)
      } else {
        console.log(`复用 WDQS 原始缓存 ${state.directType} 第 ${pageIndex + 1} 页…`)
      }

      addCandidates(pageCache.candidates)
      state.complete = pageCache.pageComplete === true
        || Number(pageCache.resultCount) < CANDIDATE_PAGE_SIZE
      state.nextPage += 1
      reachedTarget = unique.length >= queryLimit

      // Advance the aggregate after every page, including pages loaded from
      // disk. This is the recovery checkpoint used by the next invocation.
      await writeJson(cachePath, {
        schemaVersion: CANDIDATE_CACHE_SCHEMA,
        queryVersion: CANDIDATE_QUERY_VERSION,
        queryHash: aggregateQueryHash,
        queryLimit,
        queryComplete: reachedTarget,
        queryMethod,
        pageSize: CANDIDATE_PAGE_SIZE,
        fetchedAt: new Date().toISOString(),
        candidates: unique,
      })
    }
    if (reachedTarget) break
  }

  const queryComplete = reachedTarget || pageStates.every((state) => state.complete)
  unique.sort((a, b) => a.id.localeCompare(b.id) || a.title.localeCompare(b.title))
  await writeJson(cachePath, {
    schemaVersion: CANDIDATE_CACHE_SCHEMA,
    queryVersion: CANDIDATE_QUERY_VERSION,
    queryHash: aggregateQueryHash,
    queryLimit,
    queryComplete,
    queryMethod,
    pageSize: CANDIDATE_PAGE_SIZE,
    fetchedAt: new Date().toISOString(),
    candidates: unique,
  })
  return {
    candidates: mergeRequiredCandidates(unique),
    queryHash: aggregateQueryHash,
    queryLimit,
    queryComplete,
    queryVersion: CANDIDATE_QUERY_VERSION,
    queryMethod,
  }
}

async function enrichEntities(ids, _refresh, { cacheName = 'wikidata-entities.json', props = 'labels|descriptions|claims|sitelinks|aliases' } = {}) {
  const cachePath = resolve(RAW_DIR, cacheName)
  const cachedEntities = await readJson(cachePath, {})
  // wbgetentities includes every claim plus large references and qualifiers,
  // while this catalogue reads a small, explicit property set. Normalising
  // legacy and fresh cache entries avoids V8's single-string ceiling without
  // weakening any eligibility or provenance evidence.
  const entityMap = Object.fromEntries(Object.entries(cachedEntities)
    .map(([id, entity]) => [id, compactEntity(entity)])
    .filter(([, entity]) => entity))
  const missing = ids.filter((id) => !entityMap[id]
    || (props.includes('aliases') && !Object.hasOwn(entityMap[id], 'aliases')))
  if (missing.length) console.log(`补充 Wikidata 实体 ${missing.length} 个（${props.includes('claims') ? '作品元数据' : '标签'}）…`)
  let completed = 0
  for (const batch of chunks(missing, ENTITY_BATCH_SIZE)) {
    const url = urlWithParams(WBGETENTITIES_URL, {
      action: 'wbgetentities',
      ids: batch.join('|'),
      props,
      ...(props.includes('sitelinks') ? { sitefilter: 'zhwiki|enwiki' } : {}),
      languages: 'zh-cn|zh-hans|zh|en',
      format: 'json',
      formatversion: '2',
      origin: '*',
    })
    const response = await requestJson(url)
    const entities = Array.isArray(response?.entities)
      ? response.entities
      : Object.values(response?.entities || {})
    for (const entity of entities) {
      const compacted = compactEntity(entity)
      if (compacted?.id) entityMap[compacted.id] = compacted
    }
    completed += batch.length
    if (completed % 2000 < ENTITY_BATCH_SIZE || completed === missing.length) {
      console.log(`  Wikidata ${Math.min(completed, missing.length)}/${missing.length}`)
      await writeJson(cachePath, entityMap)
    }
  }
  await writeJson(cachePath, entityMap)
  return entityMap
}

async function getIntros(candidates, refresh) {
  const cachePath = resolve(RAW_DIR, 'zhwiki-intros.json')
  const introMap = await readJson(cachePath, {})
  const cachedByTitle = new Map(Object.entries(introMap).map(([title, intro]) => [wikiTitleKey(title), intro]))
  // Lead text and page-info are fetched separately. This lets a resumed build
  // reuse the expensive extract cache and add revision/variant-title evidence
  // only for the candidates that pass the 120-character gate.
  const missing = candidates.filter((candidate) => {
    if (refresh) return true
    const cached = cachedByTitle.get(wikiTitleKey(candidate.title))
    return !cached?.extract && cached?.fetchStatus !== 'missing'
  })
  if (missing.length) console.log(`从中文维基百科获取 ${missing.length} 篇导语…`)
  let completed = 0
  // TextExtracts limits anonymous multi-page requests to 20 pages. Larger
  // batches silently return info for every page but extracts for only a
  // subset, which previously left valid Chinese classics permanently empty.
  for (const batch of chunks(missing, INTRO_BATCH_SIZE)) {
    const url = urlWithParams(WIKIPEDIA_API_URL, {
      action: 'query',
      format: 'json',
      formatversion: '2',
      prop: 'extracts|info',
      exintro: '1',
      explaintext: '1',
      inprop: 'url',
      redirects: '1',
      variant: 'zh-cn',
      titles: batch.map((candidate) => candidate.title).join('|'),
      origin: '*',
    })
    const response = await requestJson(url)
    for (const page of response?.query?.pages || []) {
      if (!page?.title) continue
      introMap[page.title] = {
        title: page.title,
        extract: normalizeSummary(page.extract || ''),
        url: page.fullurl || pageUrl(page.title),
        pageid: page.pageid || null,
        lastrevid: page.lastrevid || null,
        fetchStatus: page.missing ? 'missing' : 'ok',
      }
    }
    for (const redirect of response?.query?.redirects || []) {
      if (redirect?.from && redirect?.to && introMap[redirect.to]) introMap[redirect.from] = introMap[redirect.to]
    }
    for (const normalized of response?.query?.normalized || []) {
      if (normalized?.from && normalized?.to && introMap[normalized.to]) introMap[normalized.from] = introMap[normalized.to]
    }
    completed += batch.length
    if (completed % 1000 < INTRO_BATCH_SIZE || completed === missing.length) {
      console.log(`  中文维基导语 ${Math.min(completed, missing.length)}/${missing.length}`)
      await writeJson(cachePath, introMap)
    }
  }
  await writeJson(cachePath, introMap)
  return introMap
}

async function ensureRequiredAnchorSummaries(candidates, introMap, refresh) {
  const cachePath = resolve(RAW_DIR, 'zhwiki-intros.json')
  const byTitle = new Map(Object.entries(introMap).map(([title, intro]) => [wikiTitleKey(title), intro]))
  const anchors = candidates.filter((candidate) => REQUIRED_QIDS.has(candidate.id) || REQUIRED_TITLES.has(displayTitle(candidate.title, candidate.id)))
  const needsFullExtract = anchors.filter((candidate) => {
    const cached = byTitle.get(wikiTitleKey(candidate.title))
    return refresh || chineseCount(cached?.extract || '') < 120
  })
  if (!needsFullExtract.length) return introMap

  console.log(`为 ${needsFullExtract.length} 本体验锚点补充可核查的中文正文节选…`)
  for (const batch of chunks(needsFullExtract, INTRO_BATCH_SIZE)) {
    const url = urlWithParams(WIKIPEDIA_API_URL, {
      action: 'query',
      format: 'json',
      formatversion: '2',
      prop: 'extracts|info',
      explaintext: '1',
      exchars: '1200',
      inprop: 'url|varianttitles',
      redirects: '1',
      variant: 'zh-cn',
      titles: batch.map((candidate) => candidate.title).join('|'),
      origin: '*',
    })
    const response = await requestJson(url)
    for (const page of response?.query?.pages || []) {
      if (!page?.title || page.missing) continue
      const extract = normalizeSummary(page.extract || '')
      if (chineseCount(extract) < 120) continue
      const existing = introMap[page.title] || byTitle.get(wikiTitleKey(page.title)) || {}
      const value = {
        ...existing,
        title: page.title,
        extract,
        url: page.fullurl || existing.url || pageUrl(page.title),
        pageid: page.pageid || existing.pageid || null,
        lastrevid: page.lastrevid || existing.lastrevid || null,
        variantTitleZhCn: cleanText(page.varianttitles?.['zh-cn'] || existing.variantTitleZhCn || page.title),
        fetchStatus: 'ok',
        summaryScope: 'full-extract-anchor-fallback',
      }
      introMap[page.title] = value
      introMap[toSimplified(page.title)] = value
      byTitle.set(wikiTitleKey(page.title), value)
      byTitle.set(wikiTitleKey(toSimplified(page.title)), value)
    }
    for (const redirect of response?.query?.redirects || []) {
      const target = introMap[redirect?.to] || byTitle.get(wikiTitleKey(redirect?.to))
      if (redirect?.from && target) introMap[redirect.from] = target
    }
    for (const normalized of response?.query?.normalized || []) {
      const target = introMap[normalized?.to] || byTitle.get(wikiTitleKey(normalized?.to))
      if (normalized?.from && target) introMap[normalized.from] = target
    }
  }
  await writeJson(cachePath, introMap)
  return introMap
}

async function getPageInfo(candidates, refresh) {
  const cachePath = resolve(RAW_DIR, 'zhwiki-intros.json')
  const introMap = await readJson(cachePath, {})
  const cachedByTitle = new Map(Object.entries(introMap).map(([title, intro]) => [wikiTitleKey(title), intro]))
  const missing = candidates.filter((candidate) => refresh || !cachedByTitle.get(wikiTitleKey(candidate.title))?.lastrevid || !cachedByTitle.get(wikiTitleKey(candidate.title))?.variantTitleZhCn)
  if (missing.length) console.log(`补充中文维基版本与简中题名 ${missing.length} 篇…`)
  let completed = 0
  for (const batch of chunks(missing, PAGE_BATCH_SIZE)) {
    const url = urlWithParams(WIKIPEDIA_API_URL, {
      action: 'query',
      format: 'json',
      formatversion: '2',
      prop: 'info',
      inprop: 'url|varianttitles',
      redirects: '1',
      variant: 'zh-cn',
      titles: batch.map((candidate) => candidate.title).join('|'),
      origin: '*',
    })
    const response = await requestJson(url)
    for (const page of response?.query?.pages || []) {
      if (!page?.title) continue
      const existing = introMap[page.title] || {}
      introMap[page.title] = {
        ...existing,
        title: page.title,
        url: page.fullurl || existing.url || pageUrl(page.title),
        pageid: page.pageid || existing.pageid || null,
        lastrevid: page.lastrevid || existing.lastrevid || null,
        variantTitleZhCn: cleanText(page.varianttitles?.['zh-cn'] || page.title),
      }
    }
    for (const redirect of response?.query?.redirects || []) {
      if (redirect?.from && redirect?.to && introMap[redirect.to]) introMap[redirect.from] = introMap[redirect.to]
    }
    for (const normalized of response?.query?.normalized || []) {
      if (normalized?.from && normalized?.to && introMap[normalized.to]) introMap[normalized.from] = introMap[normalized.to]
    }
    completed += batch.length
    if (completed % 1000 < PAGE_BATCH_SIZE || completed === missing.length) {
      console.log(`  中文维基版本 ${Math.min(completed, missing.length)}/${missing.length}`)
      await writeJson(cachePath, introMap)
    }
  }
  await writeJson(cachePath, introMap)
  return introMap
}

function validSummaryCandidates(candidates, introMap) {
  const byTitle = new Map(Object.entries(introMap).map(([title, intro]) => [wikiTitleKey(title), intro]))
  return candidates.filter((candidate) => !looksLikePlaceholder(byTitle.get(wikiTitleKey(candidate.title))?.extract || ''))
}

function normalizedOpenLibraryId(value) {
  return cleanText(value).replace(/^\/works\//iu, '').toUpperCase()
}

async function getOpenLibraryCovers(books, refresh) {
  const cachePath = resolve(RAW_DIR, 'openlibrary-covers.json')
  const coverMap = await readJson(cachePath, {})
  const ids = [...new Set(books
    .filter((book) => !COVER_BLOCKLIST.has(book.id))
    .map((book) => normalizedOpenLibraryId(book.openLibraryId))
    .filter(Boolean))]
  const missing = ids.filter((id) => refresh || !coverMap[id])
  if (missing.length) console.log(`校验 Open Library 封面元数据 ${missing.length} 个…`)
  let completed = 0
  for (const batch of chunks(missing, 50)) {
    const expression = batch.map((id) => `/works/${id}`).join(' OR ')
    const url = urlWithParams(OPENLIBRARY_SEARCH_URL, {
      q: `key:(${expression})`,
      fields: 'key,title,cover_i',
      limit: 100,
    })
    const response = await requestJson(url)
    for (const doc of response?.docs || []) {
      const id = normalizedOpenLibraryId(doc.key)
      if (!id || !batch.includes(id)) continue
      coverMap[id] = {
        key: doc.key,
        title: cleanText(doc.title || ''),
        coverId: Number.isInteger(doc.cover_i) ? doc.cover_i : null,
      }
    }
    // A missing result is cached too, so later resumptions do not hammer the
    // endpoint for the same P648 IDs.
    for (const id of batch) if (!coverMap[id]) coverMap[id] = { key: `/works/${id}`, title: '', coverId: null }
    completed += batch.length
    if (completed % 500 < 50 || completed === missing.length) {
      console.log(`  Open Library ${Math.min(completed, missing.length)}/${missing.length}`)
      await writeJson(cachePath, coverMap)
    }
  }
  await writeJson(cachePath, coverMap)
  return books.map((book) => {
    const coverBlockReason = COVER_BLOCKLIST.get(book.id)
    if (coverBlockReason) {
      return {
        ...book,
        coverUrl: null,
        coverSourceUrl: null,
        provenance: {
          ...book.provenance,
          coverStatus: 'blocked-known-mismatch',
          coverBlockReason,
        },
      }
    }
    const id = normalizedOpenLibraryId(book.openLibraryId)
    const match = id ? coverMap[id] : null
    if (!match?.coverId) {
      return {
        ...book,
        coverUrl: null,
        coverSourceUrl: null,
        provenance: {
          ...book.provenance,
          coverStatus: 'no-cover-found',
          coverBlockReason: null,
        },
      }
    }
    return {
      ...book,
      coverUrl: `https://covers.openlibrary.org/b/id/${match.coverId}-M.jpg`,
      coverSourceUrl: `https://openlibrary.org${match.key}`,
      imageKind: '书籍封面',
      provenance: {
        ...book.provenance,
        coverStatus: 'openlibrary-cover-i',
        coverBlockReason: null,
      },
    }
  })
}

function entityCandidateIds(candidates, entityMap) {
  const ids = []
  for (const candidate of candidates) {
    const entity = entityMap[candidate.id]
    ids.push(candidate.id)
    ids.push(...claimLabelIds(entity, ['P31', 'P50', 'P136', 'P921', 'P1269', 'P642', 'P407', 'P495']))
  }
  return [...new Set(ids)].filter(Boolean)
}

function makeBook(candidate, entityMap, introMap, introByTitle = null) {
  const work = entityMap[candidate.id]
  const intro = introMap[candidate.title]
    || introByTitle?.get(wikiTitleKey(candidate.title))
    || {}
  const wikipediaTitle = cleanText(candidate.title)
  const title = displayTitle(intro.variantTitleZhCn || wikipediaTitle, candidate.id)
  const wikipediaResolvedTitle = cleanText(intro.title || intro.variantTitleZhCn || wikipediaTitle)
  const wikipediaRedirected = wikiTitleKey(toSimplified(wikipediaTitle)) !== wikiTitleKey(toSimplified(wikipediaResolvedTitle))
  const summary = normalizeSummary(intro.extract || '')
  if (!work || chineseCount(title) < 1 || looksLikePlaceholder(summary)) return null
  const openLibrary = openLibraryId(work)
  const eligibility = evaluateWork({ work, entityMap, intro: summary, hasOpenLibrary: Boolean(openLibrary) })
  if (!eligibility.accepted) return null
  const titlePair = pickTitle(work, title)
  const metadata = [localizedDescription(work), englishLabel(work)]
  const authorOverride = AUTHOR_OVERRIDES.get(String(work.id || candidate.id).toUpperCase()) || null
  const authors = authorOverride
    ? authorOverride.authors.map((author) => ({
      ...author,
      name: toSimplified(cleanText(author.name)),
      source: author.source || authorOverride.source,
      ...(author.source === 'catalog-override' || !author.source ? { reason: authorOverride.reason } : {}),
    }))
    : authorRecords(work, entityMap)
  const author = authorOverride?.displayAuthor || authorName(authors)
  const language = languageName(work, entityMap)
  const country = countryName(work, entityMap)
  const yearOverride = YEAR_OVERRIDES.get(String(work.id || candidate.id).toUpperCase()) || null
  const year = yearOverride?.value ?? claimYear(work)
  if (eligibility.ruleId === 'work-with-bibliographic-evidence' && (author === '佚名' || year === null || language === '未注明')) return null
  const themeEntries = buildThemes(title, summary, metadata, work, entityMap, country, year)
  if (themeEntries.every(({ source }) => source === THEME_SOURCE.GENERIC)) return null
  const themes = themeEntries.map(({ theme }) => theme)
  const themeProvenance = Object.fromEntries(themeEntries.map(({ theme, source }) => [theme, source]))
  const themeEvidence = Object.fromEntries(themeEntries.map(({ theme, evidence, source }) => [
    theme,
    cleanText(evidence) || `受控主题来源：${source}`,
  ]))
  const coverUrl = null
  const fields = {
    originalTitle: titlePair.originalTitle,
    author,
    authors,
    year,
    language,
    country,
    themes,
    openLibraryId: openLibrary,
  }
  const sitelinkCount = Object.keys(work.sitelinks || {}).length
  const popularity = Number(Math.min(1, Math.log1p(sitelinkCount) / Math.log(250)).toFixed(3))
  return {
    id: candidate.id,
    title,
    wikipediaTitle,
    aliases: [...new Set([wikipediaTitle, toSimplified(wikipediaTitle), title])],
    instanceOf: eligibility.directP31,
    eligibility: {
      accepted: true,
      status: eligibility.status,
      ruleId: eligibility.ruleId,
      category: eligibility.category,
      reason: eligibility.reason,
      matchedIds: eligibility.matchedIds,
      signals: eligibility.signals,
      policyVersion: eligibility.policyVersion,
      policyHash: eligibility.policyHash,
    },
    originalTitle: titlePair.originalTitle,
    foreignTitle: titlePair.foreignTitle,
    author,
    authors,
    year,
    language,
    country,
    summary,
    themes,
    themeProvenance,
    themeEvidence,
    source: '中文维基百科 / Wikidata',
    sourceUrl: intro.url || pageUrl(title),
    wikidataUrl: `https://www.wikidata.org/wiki/${candidate.id}`,
    openLibraryId: openLibrary,
    coverUrl,
    coverSourceUrl: null,
    popularity,
    contentLength: summary.length,
    metadataCompleteness: entityCompleteness(fields),
    provenance: {
      workId: candidate.id,
      wikipediaPageId: intro.pageid || null,
      wikipediaRevisionId: intro.lastrevid || null,
      wikipediaRevisionUrl: intro.lastrevid && intro.url ? `${intro.url}?oldid=${intro.lastrevid}` : null,
      wikipediaResolvedTitle,
      wikipediaRedirected,
      wikipediaVariant: 'zh-cn',
      variantTitleSource: intro.variantTitleZhCn ? 'MediaWiki info API inprop=varianttitles' : 'local fallback map',
      displayTitleOverride: DISPLAY_TITLE_OVERRIDES.get(String(candidate.id || '').toUpperCase()) || null,
      titleOverride: titlePair.override,
      yearOverride,
      authorOverride: authorOverride
        ? {
          source: authorOverride.source,
          reason: authorOverride.reason,
          removedAuthors: authorOverride.removedAuthors,
        }
        : null,
      coverStatus: 'pending-openlibrary-cover-i',
      coverBlockReason: COVER_BLOCKLIST.get(candidate.id) || null,
      relationEvidence: 'Wikidata claims and Chinese Wikipedia lead section',
      summaryMethod: intro.summaryScope === 'full-extract-anchor-fallback'
        ? 'MediaWiki extracts API, plaintext full-extract fallback for a named route anchor; clipped to 600 characters at a sentence boundary'
        : 'MediaWiki extracts API, exintro=1, explaintext=1, variant=zh-cn; clipped to 600 characters when needed',
      eligibilityPolicyVersion: eligibility.policyVersion,
      eligibilityPolicyHash: eligibility.policyHash,
    },
  }
}

function scoreBook(book) {
  return (chineseCount(book.summary) * 3)
    + (book.themes.length * 100)
    + (book.author !== '佚名' ? 80 : 0)
    + (book.year ? 30 : 0)
    + (book.openLibraryId ? 15 : 0)
    + Math.round(book.popularity * 20)
}

function pageIdentityKey(book) {
  const pageId = Number(book?.provenance?.wikipediaPageId)
  if (Number.isInteger(pageId) && pageId > 0) return `page:${pageId}`
  try {
    const url = new URL(book.sourceUrl)
    return `url:${url.hostname.toLowerCase()}${decodeURIComponent(url.pathname).replace(/\/+$/u, '')}`
  } catch {
    return `id:${book.id}`
  }
}

function preferCanonicalPageOwner(left, right) {
  const leftDirect = left.provenance?.wikipediaRedirected === false ? 1 : 0
  const rightDirect = right.provenance?.wikipediaRedirected === false ? 1 : 0
  return (rightDirect - leftDirect)
    || (scoreBook(right) - scoreBook(left))
    || left.id.localeCompare(right.id)
}

function deduplicateResolvedPages(books) {
  const grouped = new Map()
  for (const book of books) {
    const key = pageIdentityKey(book)
    const current = grouped.get(key)
    if (!current || preferCanonicalPageOwner(current, book) > 0) grouped.set(key, book)
  }
  return [...grouped.values()]
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const limit = positiveInt(options.limit, DEFAULT_LIMIT, MAX_LIMIT)
  if (limit > MAX_LIMIT) throw new Error(`--limit 不能超过 ${MAX_LIMIT}`)
  const refresh = Boolean(options.refresh)
  const requestedMultiplier = Number(options['candidate-multiplier'] || DEFAULT_CANDIDATE_MULTIPLIER)
  const candidateMultiplier = Number.isFinite(requestedMultiplier) ? Math.max(1.25, requestedMultiplier) : DEFAULT_CANDIDATE_MULTIPLIER
  const startedAt = Date.now()
  const approvedCovers = await readJson(APPROVED_COVERS_PATH, null)
  if (!approvedCovers) throw new Error(`缺少已批准封面侧车：${APPROVED_COVERS_PATH}`)
  assertValidApprovedCovers(approvedCovers)
  await mkdir(RAW_DIR, { recursive: true })
  const candidateSnapshot = await getCandidates(limit, refresh, candidateMultiplier)
  const candidates = candidateSnapshot.candidates
  if (candidates.length < limit) throw new Error(`WDQS 只返回 ${candidates.length} 个候选，目标为 ${limit}`)

  let intros = await getIntros(candidates, refresh)
  intros = await ensureRequiredAnchorSummaries(candidates, intros, refresh)
  const validCandidates = validSummaryCandidates(candidates, intros)
  if (validCandidates.length < limit) {
    throw new Error(`中文导语合格候选仅 ${validCandidates.length} 个，目标为 ${limit}；请提高 --candidate-multiplier 后重试`)
  }
  const pageInfo = await getPageInfo(validCandidates, refresh)
  const pageInfoByTitle = new Map(Object.entries(pageInfo).map(([title, intro]) => [wikiTitleKey(title), intro]))
  // Do not download full claims/sitelinks for candidates whose lead section is
  // unusable.  This keeps the resumable cache proportional to the final map.
  const firstEntities = await enrichEntities(validCandidates.map((candidate) => candidate.id), refresh)
  const relatedIds = entityCandidateIds(validCandidates, firstEntities)
  const relatedOnly = relatedIds.filter((id) => !firstEntities[id])
  const labelEntities = await enrichEntities(relatedOnly, refresh, {
    cacheName: 'wikidata-labels.json',
    props: 'labels|descriptions|aliases',
  })
  const entityMap = { ...labelEntities, ...firstEntities }

  const eligibilityRows = validCandidates.map((candidate) => {
    const work = entityMap[candidate.id]
    const intro = pageInfo[candidate.title]
      || pageInfoByTitle.get(wikiTitleKey(candidate.title))
      || {}
    const evaluation = evaluateWork({
      work,
      entityMap,
      intro: intro.extract || '',
      hasOpenLibrary: Boolean(openLibraryId(work)),
    })
    return { candidate, evaluation }
  })
  const reportRows = (rows) => rows.map(({ candidate, evaluation }) => ({
    id: candidate.id,
    wikipediaTitle: candidate.title,
    status: evaluation.status,
    accepted: evaluation.accepted,
    ruleId: evaluation.ruleId,
    category: evaluation.category,
    reason: evaluation.reason,
    directP31: evaluation.directP31,
    matchedIds: evaluation.matchedIds,
    signals: evaluation.signals,
  }))
  const report = {
    schemaVersion: 'bookshelf-galaxy/rich-eligibility-report-v1',
    generatedAt: new Date().toISOString(),
    policyVersion: POLICY_VERSION,
    policyHash: POLICY_HASH,
    queryVersion: candidateSnapshot.queryVersion || CANDIDATE_QUERY_VERSION,
    queryHash: candidateSnapshot.queryHash,
    candidateCount: candidates.length,
    summaryEligibleCount: validCandidates.length,
    summaryRejectedCount: candidates.length - validCandidates.length,
    accepted: reportRows(eligibilityRows.filter(({ evaluation }) => evaluation.status === 'accepted')),
    rejected: reportRows(eligibilityRows.filter(({ evaluation }) => evaluation.status === 'rejected')),
    quarantine: reportRows(eligibilityRows.filter(({ evaluation }) => evaluation.status === 'quarantine')),
    unknownDirectP31: (() => {
      const known = new Set(POLICY_TYPES)
      const counts = new Map()
      for (const { evaluation } of eligibilityRows) {
        for (const type of evaluation.directP31) {
          if (!known.has(type.id)) counts.set(`${type.id}\u0000${type.label}`, (counts.get(`${type.id}\u0000${type.label}`) || 0) + 1)
        }
      }
      const types = [...counts.entries()]
        .map(([key, count]) => {
          const [id, label] = key.split('\u0000')
          return { id, label, count }
        })
        .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id))
      return { uniqueTypeCount: types.length, statementCount: types.reduce((sum, type) => sum + type.count, 0), types }
    })(),
    samples: {
      accepted: reportRows(eligibilityRows.filter(({ evaluation }) => evaluation.status === 'accepted').slice(0, 20)),
      rejected: reportRows(eligibilityRows.filter(({ evaluation }) => evaluation.status === 'rejected').slice(0, 20)),
      quarantine: reportRows(eligibilityRows.filter(({ evaluation }) => evaluation.status === 'quarantine').slice(0, 20)),
    },
  }
  await writeJson(resolve(OUTPUT_DIR, 'eligibility-report.json'), report)

  const eligibleBeforePageDeduplication = validCandidates
    .map((candidate) => makeBook(candidate, entityMap, pageInfo, pageInfoByTitle))
    .filter(Boolean)
    .sort((a, b) => scoreBook(b) - scoreBook(a) || a.id.localeCompare(b.id))
  const eligibleBooks = deduplicateResolvedPages(eligibleBeforePageDeduplication)
  let books = eligibleBooks
  // Inspect cover availability before the final cut: P648 is metadata only;
  // a cover is advertised only when Open Library returns a real cover_i.
  books = await getOpenLibraryCovers(books, refresh)
  const qualityOrdered = books
    .sort((a, b) => Boolean(b.coverUrl) - Boolean(a.coverUrl) || scoreBook(b) - scoreBook(a) || a.id.localeCompare(b.id))
  const required = qualityOrdered.filter((book) => REQUIRED_QIDS.has(book.id) || REQUIRED_TITLES.has(book.title))
  const remainder = qualityOrdered.filter((book) => !REQUIRED_QIDS.has(book.id) && !REQUIRED_TITLES.has(book.title))
  books = [...required, ...remainder]
    .slice(0, limit)
    .sort((a, b) => a.id.localeCompare(b.id))
  if (books.length < limit) {
    throw new Error(`仅有 ${books.length} 本书满足中文导语 >=120 字符，目标为 ${limit}；请增大候选倍数或降低目标数`)
  }

  const summaryChineseCounts = books.map((book) => chineseCount(book.summary))
  const withCovers = books.filter((book) => book.coverUrl).length
  const withAuthors = books.filter((book) => namedAuthorCount(book.authors) > 0).length
  let snapshot = {
    schemaVersion: 'bookshelf-galaxy/rich-books-v2',
    generatedAt: new Date().toISOString(),
    eligibilityPolicy: { version: POLICY_VERSION, hash: POLICY_HASH },
    selection: {
      targetCount: limit,
      candidateCount: candidates.length,
      candidateQueryVersion: candidateSnapshot.queryVersion || CANDIDATE_QUERY_VERSION,
      candidateQueryHash: candidateSnapshot.queryHash,
      candidateQueryLimit: candidateSnapshot.queryLimit,
      acceptedCount: books.length,
      eligibleBeforePageDeduplication: eligibleBeforePageDeduplication.length,
      duplicateResolvedPagesRemoved: eligibleBeforePageDeduplication.length - eligibleBooks.length,
      deterministicOrder: 'required anchors first, then verified cover availability and quality score desc; output Wikidata Q-id asc',
      minimumChineseSummaryCharacters: 120,
      requiredAnchors: {
        qids: [...REQUIRED_QIDS],
        titles: [...REQUIRED_TITLES],
        retained: books.filter((book) => REQUIRED_QIDS.has(book.id) || REQUIRED_TITLES.has(book.title)).map((book) => ({ id: book.id, title: book.title })),
        rule: 'anchors are selected only after the same valid Chinese summary and source gates as every other book',
      },
    },
    provenance: {
      candidateQuery: candidateSnapshot.queryMethod || 'Wikidata Query Service: Chinese Wikipedia sitelink + direct P31 VALUES from shared eligibility policy',
      metadataEndpoint: WBGETENTITIES_URL,
      summaryEndpoint: WIKIPEDIA_API_URL,
      candidateEndpoint: WDQS_URL,
      coverMetadataEndpoint: OPENLIBRARY_SEARCH_URL,
      wikipediaVariant: 'zh-cn',
      cover: {
        method: 'Default: Wikidata P648 Open Library work ID + Search API cover_i; approved sidecar entries: exact Edition CoverAsset overlay',
        versionNote: 'Default cover_i images remain work-linked and edition-ambiguous; approved sidecar assets bind an exact Edition and preserve their audited L image while displaying an M derivative.',
        blocklist: [...COVER_BLOCKLIST.entries()].map(([id, reason]) => ({ id, reason })),
      },
      licenses: {
        wikidata: 'CC0 1.0 (Wikidata data)',
        wikipedia: 'CC BY-SA 4.0 (lead text; attribution required)',
        openLibraryCovers: 'Open Library cover service terms; URLs only, no bulk download',
      },
      notes: [
        '仅写入拥有中文维基百科页面且中文摘要含至少 120 个汉字的作品；命名体验锚点若导语过短，可使用同一固定修订页面的纯文本正文开头补足，并逐条标记 summaryMethod。',
        'title 优先使用 MediaWiki info API 的 zh-cn varianttitles，wikipediaTitle 保留规范页题名；旧缓存才使用本地繁简回退表。',
        '每本书的 themeProvenance 逐条记录主题来源：wikidata-claim、summary-rule、contextual-metadata 或 generic-last-resort。',
        '主题生成顺序为受控的 Wikidata genre/subject claims、中文导语关键词规则，再到国家/地域、世纪与具体 P31/P136 类型；语言字段仅作书目展示，不进入主题或关系主题。',
        '摘要规则只匹配多词或明确叙事信号，不把“人”“社会”“生活”“历史”“文学”等宽泛词单独作为主题；generic-last-resort 仅在上述可核查信号不足三项时使用，并保留来源记录。',
        '一般 coverUrl 仅在作品存在 P648 Open Library ID 且 Search API 返回 cover_i 时生成，仍不保证版本相同；批准侧车条目例外地以 exact Edition CoverAsset 覆盖运行时 M 图与 Edition 回链，并保留审计 L 图。blocklist 始终优先；构建过程不批量下载封面。',
        '网络响应和构建原始缓存位于被 gitignore 的 data/raw/rich-catalog/。',
      ],
    },
    quality: {
      chineseSummaryEligibleCount: validCandidates.length,
      bookTypeEligibleCount: eligibleBooks.length,
      chineseSummaryMin: Math.min(...summaryChineseCounts),
      chineseSummaryMedian: summaryChineseCounts.slice().sort((a, b) => a - b)[Math.floor(summaryChineseCounts.length / 2)],
      chineseSummaryMax: Math.max(...summaryChineseCounts),
      namedAuthorBooks: withAuthors,
      authorCoverage: Number((withAuthors / books.length).toFixed(3)),
      coverCoverage: Number((withCovers / books.length).toFixed(3)),
      averageMetadataCompleteness: Number((books.reduce((total, book) => total + book.metadataCompleteness, 0) / books.length).toFixed(3)),
    },
    books,
  }
  snapshot = applyApprovedCoversToSnapshot(snapshot, approvedCovers)
  await mkdir(OUTPUT_DIR, { recursive: true })
  await writeJson(OUTPUT_PATH, snapshot)
  const digest = hash(stableJson(snapshot))
  console.log(JSON.stringify({
    output: OUTPUT_PATH,
    books: books.length,
    candidates: candidates.length,
    summariesMinChineseChars: snapshot.quality.chineseSummaryMin,
    summariesMedianChineseChars: snapshot.quality.chineseSummaryMedian,
    authors: withAuthors,
    namedAuthorBooks: withAuthors,
    covers: withCovers,
    averageMetadataCompleteness: snapshot.quality.averageMetadataCompleteness,
    sha256: digest,
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exitCode = 1
})
