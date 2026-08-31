import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import type { Book, BookRelation } from '../types'
import { otherBookId } from '../lib/galaxyMath'

function Icon({ name }: { name: 'sound' | 'mute' | 'expand' | 'motion' | 'close' | 'arrow' | 'signal' }) {
  const paths: Record<typeof name, React.ReactNode> = {
    sound: <><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16 9.5c1.3 1.4 1.3 3.6 0 5M18.8 6.8c2.9 3 2.9 7.4 0 10.4"/></>,
    mute: <><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="m17 10 5 5m0-5-5 5"/></>,
    expand: <><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/><path d="m3 8 6-6m6 0 6 6m0 8-6 6M9 22l-6-6"/></>,
    motion: <><path d="M4 12h16M7 8h10M9 16h6"/><circle cx="12" cy="12" r="9"/></>,
    close: <path d="m5 5 14 14M19 5 5 19"/>,
    arrow: <><path d="M4 12h15M14 6l6 6-6 6"/></>,
    signal: <><path d="M4 17a10 10 0 0 1 16 0M7 14a6 6 0 0 1 10 0M10 11a2.5 2.5 0 0 1 4 0"/><circle cx="12" cy="19" r="1"/></>,
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>
}

interface IntroProps {
  books: Book[]
  ready: boolean
  bookCount: number
  relationCount: number
  curatedRelationCount: number
  loadingPhase?: string
  onStart: (book: Book) => void
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function chineseCharacterCount(value: string | undefined): number {
  return (value?.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu) ?? []).length
}

function bookAliases(book: Book): string[] {
  const runtime = book as Book & {
    aliases?: unknown
    alias?: unknown
    wikipediaTitle?: unknown
  }
  const values = [runtime.wikipediaTitle, ...(Array.isArray(runtime.aliases) ? runtime.aliases : []), ...(Array.isArray(runtime.alias) ? runtime.alias : [])]
  return values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

const familiarAnchorTitles = [
  '三体',
  '红楼梦',
  '西游记',
  '活着',
  '百年孤独',
  '哈姆雷特',
  '罪与罚',
  '安娜·卡列尼娜',
  '基地',
  '沙丘',
]

function matchesTitle(book: Book, query: string): boolean {
  const candidates = [
    book.title,
    book.originalTitle,
    book.foreignTitle,
    ...bookAliases(book),
  ]
  return candidates.some((value) => value && normalizeSearch(value) === normalizeSearch(query))
}

function rankedMatch(book: Book, query: string): number {
  const title = normalizeSearch(book.title)
  const aliases = bookAliases(book).map(normalizeSearch)
  const originalTitles = [book.originalTitle, (book as Book & { foreignTitle?: string }).foreignTitle]
    .filter((value): value is string => Boolean(value))
    .map(normalizeSearch)
  const author = normalizeSearch(book.author)
  if (title === query) return 0
  if (title.startsWith(query)) return 1
  if (title.includes(query)) return 2
  if (aliases.some((value) => value === query)) return 3
  if (aliases.some((value) => value.startsWith(query))) return 4
  if (aliases.some((value) => value.includes(query))) return 5
  if (originalTitles.some((value) => value === query)) return 6
  if (originalTitles.some((value) => value.startsWith(query))) return 7
  if (originalTitles.some((value) => value.includes(query))) return 8
  if (author === query) return 9
  if (author.startsWith(query)) return 10
  if (author.includes(query)) return 11
  return Number.POSITIVE_INFINITY
}

function searchBooks(books: Book[], query: string, limit = 5): Book[] {
  const normalized = normalizeSearch(query)
  if (!normalized) return []
  return books
    .map((book) => ({
      book,
      rank: rankedMatch(book, normalized),
      chinese: chineseCharacterCount(book.title),
      content: chineseCharacterCount(book.summary),
      cover: book.coverUrl ? 1 : 0,
    }))
    .filter((item) => Number.isFinite(item.rank))
    .sort((left, right) => (
      left.rank - right.rank
      || right.chinese - left.chinese
      || right.content - left.content
      || right.cover - left.cover
      || left.book.title.localeCompare(right.book.title, 'zh-CN')
      || left.book.id.localeCompare(right.book.id)
    ))
    .slice(0, limit)
    .map((item) => item.book)
}

function featuredBooks(books: Book[], limit = 5): Book[] {
  const score = (book: Book) => (
    chineseCharacterCount(book.summary) * 2
    + book.themes.length * 16
    + (book.coverUrl ? 50 : 0)
    + (book.originalTitle ? 12 : 0)
    + (Number.isFinite(book.magnitude) ? (book.magnitude as number) * 8 : 0)
  )
  const qualityOrdered = [...books]
    .sort((left, right) => {
      return score(right) - score(left)
        || left.title.localeCompare(right.title, 'zh-CN')
        || left.id.localeCompare(right.id)
    })
  const anchors = familiarAnchorTitles
    .map((title) => books.find((book) => matchesTitle(book, title)))
    .filter((book): book is Book => Boolean(book))
  const seen = new Set<string>()
  return [...anchors, ...qualityOrdered]
    .filter((book) => !seen.has(book.id) && seen.add(book.id))
    .slice(0, limit)
}

export function IntroScreen({ books, ready, bookCount, relationCount, curatedRelationCount, loadingPhase, onStart }: IntroProps) {
  const [query, setQuery] = useState('')
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0)
  const featured = useMemo(() => featuredBooks(books), [books])
  const suggestions = useMemo(() => {
    const normalized = normalizeSearch(query.trim())
    return normalized ? searchBooks(books, normalized) : featured
  }, [books, featured, query])
  const suggestionsOpen = Boolean(query.trim()) && suggestions.length > 0
  const safeActiveSuggestionIndex = suggestions.length > 0
    ? Math.min(activeSuggestionIndex, suggestions.length - 1)
    : -1
  const activeSuggestion = safeActiveSuggestionIndex >= 0 ? suggestions[safeActiveSuggestionIndex] : undefined
  const activeSuggestionId = activeSuggestion ? `departure-option-${activeSuggestion.id}` : undefined

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const hasQuery = Boolean(query.trim())
    const selected = hasQuery ? activeSuggestion : featured[0]
    if (selected && ready) onStart(selected)
  }

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (suggestions.length === 0) return
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveSuggestionIndex((current) => (current + direction + suggestions.length) % suggestions.length)
      return
    }
    if (event.key === 'Escape') {
      if (!query && !suggestionsOpen) return
      event.preventDefault()
      setQuery('')
      setActiveSuggestionIndex(0)
    }
  }

  const noMatch = Boolean(query.trim()) && suggestions.length === 0

  return (
    <section className="intro" aria-labelledby="intro-title">
      <div className="intro-kicker">图书馆 · 搜索之后</div>
      <h1 id="intro-title">
        下一代图书馆，<br />
        <span>不只帮你找到书。</span>
      </h1>
      <p className="intro-thesis">它让你有意义地迷路。</p>
      <form className="departure-search" onSubmit={submit}>
        <label htmlFor="departure">从一本熟悉的书出发</label>
        <div className="search-line">
          <span aria-hidden="true">《</span>
          <input
            id="departure"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveSuggestionIndex(0)
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder="输入书名或作者"
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={suggestionsOpen}
            aria-controls="departure-suggestions"
            aria-activedescendant={suggestionsOpen ? activeSuggestionId : undefined}
          />
          <span aria-hidden="true">》</span>
          <button type="submit" disabled={!ready || books.length === 0 || noMatch} aria-busy={!ready}>
            {ready ? '开始偏航' : '星海显影中'}
            <Icon name="arrow" />
          </button>
        </div>
        {query && suggestions.length > 0 && (
          <div id="departure-suggestions" className="search-suggestions" role="listbox" aria-label="书籍建议">
            {suggestions.map((book, index) => (
              <button
                key={book.id}
                id={`departure-option-${book.id}`}
                type="button"
                disabled={!ready}
                onClick={() => ready && onStart(book)}
                onMouseEnter={() => setActiveSuggestionIndex(index)}
                role="option"
                aria-selected={index === safeActiveSuggestionIndex}
              >
                <span>《{book.title}》</span>
                <small>{book.author}{book.originalTitle ? ` · ${book.originalTitle}` : ''}</small>
              </button>
            ))}
          </div>
        )}
        {noMatch && <div className="search-empty" role="status">这片星海中暂未找到它。试试书名的一部分，或从下方熟悉的书出发。</div>}
      </form>
      <div className="intro-presets" aria-label="推荐出发点">
        {featured.slice(0, 4).map((book) => (
          <button key={book.id} type="button" disabled={!ready} onClick={() => ready && onStart(book)}>
            《{book.title}》
          </button>
        ))}
      </div>
      <div className="intro-proof" aria-label="数据规模">
        <span><strong>{ready ? bookCount.toLocaleString('zh-CN') : '—'}</strong> 本真实书籍</span>
        <span><strong>{ready ? relationCount.toLocaleString('zh-CN') : '—'}</strong> 条书海暗线</span>
        <span><strong>{ready && curatedRelationCount > 0 ? curatedRelationCount.toLocaleString('zh-CN') : '—'}</strong> 条引力书线</span>
      </div>
      {loadingPhase && !ready && (
        <p className="intro-loading-phase" role="status">{loadingPhase}</p>
      )}
      <div className="intro-challenges">双题合流 · 02 × 03</div>
    </section>
  )
}

interface HeaderProps {
  bookCount: number
  relationCount: number
  curatedRelationCount?: number
  soundEnabled: boolean
  reducedMotion: boolean
  onToggleSound: () => void
  onToggleMotion: () => void
  onReset: () => void
}

export function ObservatoryHeader({
  bookCount,
  relationCount,
  curatedRelationCount,
  soundEnabled,
  reducedMotion,
  onToggleSound,
  onToggleMotion,
  onReset,
}: HeaderProps) {
  const fullscreenAvailable = typeof document !== 'undefined'
    && document.fullscreenEnabled
    && typeof document.documentElement.requestFullscreen === 'function'
  const [fullscreenActive, setFullscreenActive] = useState(() => (
    typeof document !== 'undefined' && Boolean(document.fullscreenElement)
  ))

  useEffect(() => {
    if (!fullscreenAvailable) return
    const syncFullscreen = () => setFullscreenActive(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', syncFullscreen)
    return () => document.removeEventListener('fullscreenchange', syncFullscreen)
  }, [fullscreenAvailable])

  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch (error) {
      console.error('Book Galaxy fullscreen failure', error)
    }
  }
  return (
    <header className="observatory-header">
      <button className="wordmark" type="button" onClick={onReset} aria-label="返回星系入口">
        <span className="wordmark-mark">书</span>
        <span><strong>书架星系</strong><small>暗物质图书馆</small></span>
      </button>
      <div className="catalog-state">
        <span>{bookCount.toLocaleString('zh-CN')} 颗书星</span>
        <i />
        <span>{relationCount.toLocaleString('zh-CN')} 条书海暗线</span>
        {typeof curatedRelationCount === 'number' && curatedRelationCount > 0 && (
          <>
            <i aria-hidden="true" />
            <span>{curatedRelationCount.toLocaleString('zh-CN')} 条引力书线</span>
          </>
        )}
      </div>
      <nav className="observatory-tools" aria-label="观测工具">
        <button type="button" onClick={onToggleMotion} aria-pressed={reducedMotion} title="稳定镜头">
          <Icon name="motion" /><span>{reducedMotion ? '稳定镜头' : '动态镜头'}</span>
        </button>
        <button type="button" onClick={onToggleSound} aria-pressed={soundEnabled} title="声音">
          <Icon name={soundEnabled ? 'sound' : 'mute'} /><span>{soundEnabled ? '声音开启' : '开启声音'}</span>
        </button>
        {fullscreenAvailable && (
          <button type="button" onClick={fullscreen} aria-pressed={fullscreenActive} title={fullscreenActive ? '退出全屏' : '全屏'}>
            <Icon name="expand" /><span>{fullscreenActive ? '退出全屏' : '全屏'}</span>
          </button>
        )}
      </nav>
    </header>
  )
}

export function HoverLabel({
  book,
  position,
}: {
  book: Book | null
  position?: { x: number; y: number }
}) {
  if (!book || !position) return null
  const style = {
    '--hover-x': `${Math.max(90, Math.min(window.innerWidth - 220, position.x))}px`,
    '--hover-y': `${Math.max(90, Math.min(window.innerHeight - 120, position.y))}px`,
  } as CSSProperties
  return (
    <div className="hover-label" style={style}>
      <span /><strong>《{book.title}》</strong><small>{book.author}</small>
    </div>
  )
}

type ExternalUrlKind = 'source' | 'wikipediaRevision' | 'wikidata' | 'cover' | 'coverSource' | 'license'

export function safeExternalUrl(value: string | null | undefined, kind: ExternalUrlKind = 'source'): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return undefined
    const host = url.hostname.toLowerCase()
    const rawPath = url.pathname
    const path = decodeURIComponent(rawPath)
    if (kind === 'cover') {
      const coverQuery = (!url.search && !url.href.endsWith('?')) || url.search === '?default=false'
      return host === 'covers.openlibrary.org'
        && !rawPath.includes('%')
        && /^\/b\/id\/\d+-M\.jpg$/u.test(rawPath)
        && coverQuery
        ? url.toString()
        : undefined
    }
    if (kind === 'coverSource') {
      return host === 'openlibrary.org'
        && !rawPath.includes('%')
        && /^\/(?:works\/OL\d+W|books\/OL\d+M)$/u.test(rawPath)
        && !url.search
        ? url.toString()
        : undefined
    }
    if (kind === 'wikidata') {
      return host === 'www.wikidata.org'
        && /^\/wiki\/Q\d+$/u.test(path)
        && !url.search
        ? url.toString()
        : undefined
    }
    if (kind === 'license') {
      return host === 'creativecommons.org'
        && path === '/licenses/by-sa/4.0/deed.zh-hans'
        && !url.search
        ? url.toString()
        : undefined
    }
    if (host !== 'zh.wikipedia.org' || !path.startsWith('/wiki/') || !path.slice(6)) return undefined
    if (kind === 'wikipediaRevision') {
      const oldid = url.searchParams.get('oldid')
      return oldid && url.searchParams.size === 1 && /^\d+$/u.test(oldid)
        ? url.toString()
        : undefined
    }
    return url.search ? undefined : url.toString()
  } catch {
    return undefined
  }
}

const preloadedCovers = new Map<string, HTMLImageElement>()
const PRELOADED_COVER_LIMIT = 32

export function preloadCover(value: string | null | undefined): boolean {
  const coverUrl = safeExternalUrl(value, 'cover')
  if (!coverUrl || preloadedCovers.has(coverUrl) || typeof Image === 'undefined') return false
  if (preloadedCovers.size >= PRELOADED_COVER_LIMIT) {
    preloadedCovers.delete(preloadedCovers.keys().next().value as string)
  }
  const image = new Image()
  image.decoding = 'async'
  image.fetchPriority = 'high'
  image.src = coverUrl
  preloadedCovers.set(coverUrl, image)
  return true
}

type CoverStatus = 'loading' | 'loaded' | 'failed'

export function BookCover({ book }: { book: Book }) {
  const coverUrl = safeExternalUrl(book.coverUrl, 'cover')
  return <BookCoverForUrl key={coverUrl ?? `bookplate:${book.id}`} book={book} coverUrl={coverUrl} />
}

function BookCoverForUrl({ book, coverUrl }: { book: Book; coverUrl?: string }) {
  const [status, setStatus] = useState<CoverStatus>(coverUrl ? 'loading' : 'failed')
  const hasCover = Boolean(coverUrl) && status === 'loaded'
  const imageLabel = book.imageKind === 'related-image' ? '相关图像' : '封面'
  const plateTitle = book.title.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 3) || '书'
  const plateYear = formatYear(book.year)
  const revealCover = async (image: HTMLImageElement) => {
    try {
      await image.decode()
    } catch {
      if (!image.complete || image.naturalWidth === 0) {
        setStatus('failed')
        return
      }
    }
    setStatus('loaded')
  }

  return (
    <div className={`book-cover bookplate${hasCover ? ' has-cover' : ''}`} aria-label={hasCover ? `《${book.title}》${imageLabel}` : `《${book.title}》藏书票预览`}>
      <div className="bookplate-inner" aria-hidden={hasCover}>
        <span className="bookplate-overline">藏书票 · 书页</span>
        <strong>{plateTitle}</strong>
        <span className="bookplate-rule" />
        <small>{book.author}</small>
        <em>{plateYear}</em>
      </div>
      {coverUrl && status !== 'failed' && (
        <img
          className={hasCover ? 'is-visible' : undefined}
          src={coverUrl}
          alt={`《${book.title}》${imageLabel}`}
          loading="eager"
          fetchPriority="high"
          decoding="async"
          onLoad={(event) => void revealCover(event.currentTarget)}
          onError={() => setStatus('failed')}
        />
      )}
    </div>
  )
}

function formatYear(year: number | null | undefined): string {
  if (typeof year !== 'number' || !Number.isInteger(year) || year === 0) return '年代未注明'
  return year < 0 ? `公元前 ${Math.abs(year)} 年` : `${year} 年`
}

function formatLanguage(language: string | null | undefined): string {
  const label = language?.trim()
  if (!label || label === '未注明') return '语种未注明'
  const translations: Record<string, string> = {
    'Late Biblical Hebrew': '后期圣经希伯来语',
    'Quranic Arabic': '古兰经阿拉伯语',
    'Jewish Koine Greek': '犹太通用希腊语',
    'medieval Italian': '中世纪意大利语',
  }
  return translations[label] ?? label
}

function specificInstanceType(book: Book): string | undefined {
  const types = book.instanceOf?.map((type) => type.label.trim()).filter(Boolean) ?? []
  if (types.length === 0) return undefined
  const generic = /^(文学作品|著作|书籍?|作品|文献|手稿|文本|written work|literary work|book|text)$/iu
  return types.find((label) => !generic.test(label)) ?? types[0]
}

interface SemanticNeighborView {
  book: Book
  similarity?: number
  surprise?: number
  navigable?: boolean
  basis?: string[]
}

export function whyHereCopy(
  locationLabel: string,
  densityWord: string,
  nearest?: SemanticNeighborView,
): string {
  if (!nearest) {
    if (locationLabel === densityWord) return `它位于${densityWord}。附近暂未显出可命名的相遇。`
    return `它位于“${locationLabel}”的${densityWord}。附近暂未显出可命名的相遇。`
  }
  if (locationLabel === densityWord) return `它位于${densityWord}。《${nearest.book.title}》是离这里最近的书星。`
  return `它位于“${locationLabel}”的${densityWord}。《${nearest.book.title}》是离这里最近的书星。`
}

interface BookPanelProps {
  book: Book
  index: number
  total: number
  locationLabel?: string
  semanticNeighbors?: SemanticNeighborView[]
  nearbyBooks?: Book[]
  curatedThreads?: CuratedThreadView[]
  canImprint: boolean
  canDetour: boolean
  hasRelationship: boolean
  journeyLength?: number
  isAtOrigin?: boolean
  onClose: () => void
  onObserveNearby: (book: Book) => void
  onFollowCuratedThread: (relation: BookRelation) => void
  onDetour: () => void
  onRestart: () => void
  onAsk: () => void
  onImprint: () => void
  onReturn: () => void
}

export interface CuratedThreadView {
  relation: BookRelation
  target: Book
}

/**
 * Keep hand-written reading hypotheses separate from the algorithmic detour
 * compass.  The view is intentionally tiny: a selected book gets at most
 * three distinct, fully resolvable destinations.
 */
export function curatedThreadsFor(
  bookId: string,
  relations: readonly BookRelation[],
  booksById: ReadonlyMap<string, Book>,
  limit = 3,
): CuratedThreadView[] {
  if (!bookId || limit <= 0) return []
  const candidates = relations
    .filter((relation) => relation.provenance === 'reading-hypothesis'
      && (relation.source === bookId || relation.target === bookId))
    .map((relation) => ({ relation, target: booksById.get(otherBookId(relation, bookId)) }))
    .filter((item): item is CuratedThreadView => {
      const target = item.target
      if (!target) return false
      return target.id !== bookId && Boolean(item.relation.sentence?.trim())
    })
    .sort((left, right) => (
      (right.relation.confidence ?? 0) - (left.relation.confidence ?? 0)
      || left.target.title.localeCompare(right.target.title, 'zh-CN')
      || left.target.id.localeCompare(right.target.id)
    ))
  const seenTargets = new Set<string>()
  return candidates
    .filter(({ target }) => !seenTargets.has(target.id) && seenTargets.add(target.id))
    .slice(0, limit)
}

export function BookObservatory({
  book,
  index,
  total,
  locationLabel = '书云交界处',
  semanticNeighbors = [],
  nearbyBooks = [],
  curatedThreads = [],
  canImprint,
  canDetour,
  hasRelationship,
  journeyLength = 0,
  isAtOrigin = false,
  onClose,
  onObserveNearby,
  onFollowCuratedThread,
  onDetour,
  onRestart,
  onAsk,
  onImprint,
  onReturn,
}: BookPanelProps) {
  const themes = book.themes.filter(Boolean)
  const summary = book.summary?.trim()
  const summaryChineseCharacters = chineseCharacterCount(summary)
  const contentReady = summaryChineseCharacters >= 120
  const hasSecondaryTitle = Boolean(book.originalTitle && book.originalTitle !== book.title)
  const collectionType = specificInstanceType(book)
  const country = book.country?.trim()
  const nearestSemantic = semanticNeighbors[0]
  const density = typeof book.localDensity === 'number' ? book.localDensity : undefined
  const densityWord = density === undefined
    ? '书云交界处'
    : density >= 0.72
      ? '书云深处'
      : density <= 0.3
        ? '星群边缘'
        : '书云过渡带'
  const whyHere = whyHereCopy(locationLabel, densityWord, nearestSemantic)

  const imprintDisabled = !canImprint
  const imprintCopy = journeyLength < 3
    ? `再走 ${3 - journeyLength} 本即可留下星图 · ${journeyLength}/3`
    : !canDetour
      ? '回到航迹尽头即可留下星图'
      : '留下这次迷路'
  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const metaChips: string[] = []
  const yearValid = typeof book.year === 'number' && Number.isInteger(book.year) && book.year !== 0
  const yearLabel = yearValid ? formatYear(book.year) : ''
  if (yearLabel && yearLabel !== '年代未注明') metaChips.push(yearLabel)
  const rawLang = book.language?.trim()
  if (rawLang && rawLang !== '未注明') {
    const formattedLang = formatLanguage(book.language)
    if (formattedLang !== '语种未注明') metaChips.push(formattedLang)
  }
  if (country) metaChips.push(country)
  if (collectionType) metaChips.push(collectionType)

  const revisionUrl = safeExternalUrl(book.provenance?.wikipediaRevisionUrl, 'wikipediaRevision')
  const sourceUrl = revisionUrl ?? safeExternalUrl(book.sourceUrl, 'source')
  const wikidataUrl = safeExternalUrl(book.wikidataUrl, 'wikidata')
  const coverSourceUrl = safeExternalUrl(book.coverSourceUrl, 'coverSource')

  return (
    <aside className="book-observatory" aria-labelledby="observed-book-title" onKeyDown={handlePanelKeyDown}>
      <div className="panel-heading">
        <span>观测对象 {String(index + 1).padStart(2, '0')} / {total.toLocaleString('zh-CN')}</span>
        <button type="button" onClick={onClose} aria-label="收起书籍信息"><Icon name="close" /></button>
      </div>
      <div className="book-identity">
        <BookCover book={book} />
        <div className="book-title-stack">
          <span className="book-title-label">{hasSecondaryTitle ? '中文题名' : '馆藏题名'}</span>
          <h2 id="observed-book-title" data-book-observatory-title tabIndex={-1}>{book.title}</h2>
          {hasSecondaryTitle && <p className="original-title"><span>外文题名</span>{book.originalTitle}</p>}
          <p className="book-byline">{book.author}</p>
          {metaChips.length > 0 && (
            <div className="book-meta-chips" aria-label="题名信息">
              {metaChips.map((chip, idx) => (
                <span key={`${chip}:${idx}`}><>{idx > 0 && <i aria-hidden="true" />}{chip}</></span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="book-record book-record-primary">
         <span className="book-record-label book-record-label-primary">书页一瞥</span>
        {contentReady ? (
          <p className="book-summary book-summary-primary">{summary}</p>
        ) : (
          <div className="book-content-missing" role="status">
            <strong>内容尚未显影</strong>
            <p>这颗书星的故事还没有显影，暂不开放偏航。</p>
          </div>
        )}
      </div>
      {curatedThreads.length > 0 && (
        <div className="book-record gravity-thread-record hidden-thread-record" aria-labelledby="gravity-thread-title">
          <div className="gravity-thread-header">
            <h3 id="gravity-thread-title" className="gravity-thread-title">引力书线</h3>
            <small className="gravity-thread-meta">逐书策展 · 阅读假说 · {curatedThreads.length}条</small>
          </div>
          <ul className="hidden-thread-list gravity-thread-list">
            {curatedThreads.map(({ relation, target }) => (
              <li key={`${relation.source}:${relation.target}`}>
                <button className="hidden-thread-item" type="button" onClick={() => onFollowCuratedThread(relation)}>
                  <small>{relation.kind}</small>
                  <strong>《{target.title}》</strong>
                  <span>{relation.sentence}</span>
                  <Icon name="arrow" />
                </button>
              </li>
            ))}
          </ul>
          <small className="gravity-thread-hint">点击一条书线，星海将显影这段相遇的航迹。</small>
        </div>
      )}
      {nearbyBooks.length > 0 && (
        <div className="book-record nearby-record" aria-label="附近书星">
           <span className="book-record-label">附近书星</span>
          <ul className="nearby-book-list">
            {nearbyBooks.slice(0, 3).map((nearby) => (
              <li key={nearby.id}>
                <button type="button" onClick={() => onObserveNearby(nearby)}>
                  <span>《{nearby.title}》</span>
                  <small>{nearby.author}{nearby.year ? ` · ${formatYear(nearby.year)}` : ''}</small>
                </button>
              </li>
            ))}
          </ul>
          <small className="nearby-note">点开可先观测；偏航或引力书线才会写入航迹。</small>
        </div>
      )}
      <div className="book-record whyhere-record" aria-label="星域定位">
         <span className="book-record-label">为什么在这里</span>
        <p className="book-summary whyhere-copy">{whyHere}</p>
      </div>
      <footer className="panel-footer">
        <details className="footer-legend">
          <summary>如何阅读这片星海</summary>
          <p>它在星海中的位置与光度来自共同气质、时代与地域；更亮的星代表更显眼的体量。偏航时，近处贴近熟悉，桥上换种目光，远处走向陌生但仍有依据的方向。</p>
          <a className="source-link source-link-secondary" href={`${import.meta.env.BASE_URL}data-license.html`}>资料说明 ↗</a>
        </details>
        <div className="panel-footer-source">
          <span className="panel-footer-label">出处</span>
          <div className="source-links source-links-compact">
            {sourceUrl ? (
              <a className="source-link" href={sourceUrl} target="_blank" rel="noreferrer noopener">
                {revisionUrl ? '中文维基百科 · 固定修订' : (book.source ?? '开放资料')} ↗
              </a>
            ) : <span className="source-unavailable">{book.source ?? '未提供核查链接'}</span>}
            {revisionUrl && safeExternalUrl('https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hans', 'license') && (
              <a className="source-link source-link-secondary" href="https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hans" target="_blank" rel="noreferrer noopener">
                CC BY-SA 4.0 ↗
              </a>
            )}
            {wikidataUrl && (
              <a className="source-link source-link-secondary" href={wikidataUrl} target="_blank" rel="noreferrer noopener">
                资料核查 ↗
              </a>
            )}
            {coverSourceUrl && (
              <a className="source-link source-link-secondary" href={coverSourceUrl} target="_blank" rel="noreferrer noopener">
                封面出处 ↗
              </a>
            )}
          </div>
        </div>
        {themes.length > 0 && (
          <div className="theme-row panel-footer-themes" aria-label="主题">
            {themes.slice(0, 4).map((theme) => <span key={theme}>{theme}</span>)}
          </div>
        )}
        <div className="panel-footer-location">星域 / {locationLabel}</div>
      </footer>
      <div className="panel-actions">
        <button
          className={canDetour ? 'primary-action' : 'restart-action'}
          type="button"
          disabled={!contentReady}
          data-overlay-trigger={contentReady && canDetour ? 'detour' : undefined}
          onClick={contentReady ? (canDetour ? onDetour : onRestart) : undefined}
        >
          {contentReady ? (canDetour ? '从这里偏航' : '另起一段航迹') : '内容尚未显影'} {contentReady && <Icon name="arrow" />}
        </button>
        {!canDetour && contentReady && <small className="restart-disclosure">将清空当前航迹，从此书重开</small>}
        <button type="button" data-overlay-trigger="librarian" onClick={onAsk}><Icon name="signal" /> {hasRelationship ? '请馆员说说这段缘分' : '听听这颗书星'}</button>
        <button type="button" data-overlay-trigger={canImprint ? 'chart' : undefined} onClick={canImprint ? onImprint : undefined} disabled={imprintDisabled}>{imprintCopy}</button>
        <button className="quiet-action" type="button" onClick={isAtOrigin ? undefined : onReturn} disabled={isAtOrigin}>{isAtOrigin ? '已在出发星' : '返回出发星'}</button>
      </div>
    </aside>
  )
}

function maskedTitle(title: string): string {
  const cleaned = title.replace(/[（(][^）)]*[）)]/gu, '').trim() || title
  const characters = [...cleaned]
  if (characters.length <= 5) return cleaned
  return `${characters.slice(0, 2).join('')}···${characters.slice(-2).join('')}`
}

const relationTechnicalTerms = /多维|语义|书目|模型|摘要|字段|相似度|邻接|可解释|证明|元数据/iu

function readableRelationClue(relation: BookRelation, target?: Book): string {
  const explicitTheme = relation.basis
    .map((item) => item.trim())
    .find((item) => /^主题[:：]/u.test(item) && !relationTechnicalTerms.test(item))
  const theme = explicitTheme?.replace(/^主题[:：]\s*/u, '').trim()
    || target?.themes.find((item) => item.trim() && !relationTechnicalTerms.test(item.trim()))?.trim()
  if (theme) return theme
  if (target?.country?.trim()) return `${target.country.trim()}的远岸`
  if (target?.year && Number.isFinite(target.year)) return `${formatYear(target.year)}的旧时光`
  return '一页未读的远方'
}

function readableRelationBasis(relation: BookRelation, target?: Book): string[] {
  const labels = relation.basis
    .map((item) => item.trim())
    .filter((item) => item && !relationTechnicalTerms.test(item))
    .map((item) => {
      if (item === '主题' || item === '时代' || item === '地域' || item === '作者') return item
      if (/^阅读联想/u.test(item)) return '阅读联想'
      const label = item.match(/^([^:：]{1,12})[:：]/u)?.[1]?.trim()
      return label || item.slice(0, 12)
    })
  const unique = [...new Set(labels)]
  if (unique.length > 0) return unique.slice(0, 3)
  const clue = readableRelationClue(relation, target)
  return clue === '一页未读的远方' ? [] : ['主题']
}

/** Only a reading hypothesis owns authored interpretation; other edges record travel facts. */
export function relationReading(relation: BookRelation, departure?: Book, arrival?: Book): string {
  const sentence = relation.sentence?.trim()
  if (relation.provenance === 'reading-hypothesis' && sentence) return sentence
  const from = departure ? `《${departure.title}》` : '出发星'
  const to = arrival ? `《${arrival.title}》` : '远方书星'
  return `这次航行从${from}抵达${to}。`
}

/** A detour card may excerpt authored curation, never generated navigation prose. */
export function relationExcerpt(relation: BookRelation, maxLength = 72): string {
  if (relation.provenance !== 'reading-hypothesis') return ''
  const sentence = relation.sentence?.trim() ?? ''
  const firstSentence = sentence.split(/[。！？]/u)[0]?.trim() || sentence
  const characters = [...firstSentence]
  return characters.length <= maxLength
    ? firstSentence
    : `${characters.slice(0, Math.max(1, maxLength - 1)).join('')}…`
}

export function directionCopy(
  relation: BookRelation,
  target?: Book,
  index = 0,
  total = 3,
): { band: string; title: string; description: string } {
  const targetHint = target ? `《${maskedTitle(target.title)}》` : '一颗待显影书星'
  const relativeBand = total >= 3 ? index : total === 2 ? index * 2 : 1
  const band = relativeBand === 0 ? '近' : relativeBand === 1 ? '桥' : '远'
  const routeCopy = {
    近: '留在相近的书云，看熟悉的方向如何变化。',
    桥: '越过一层书云，让另一种目光接住这段航行。',
    远: '驶向更陌生的远星，把答案留到抵达以后。',
  }[band]
  return {
    band,
    title: target ? `向 ${targetHint} 偏航` : '向远方偏航',
    description: relation.provenance === 'reading-hypothesis'
      ? relationReading(relation, undefined, target) || '一条尚未命名的阅读假说。'
      : routeCopy,
  }
}

const modalFocusableSelector = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getModalFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(modalFocusableSelector))
    .filter((element) => {
      if (element.tabIndex < 0 || element.hasAttribute('disabled')) return false
      if (element.closest('[hidden], [aria-hidden="true"]')) return false
      const style = window.getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden'
    })
}

function useModalFocusTrap<T extends HTMLElement>(
  headingRef: React.RefObject<T | null>,
  onClose: () => void,
  returnFocusSelector: string,
) {
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    // `aria-modal` describes the contract; inert plus pointer suppression
    // enforces it for browsers and input methods that do not honour the
    // attribute on their own.
    const background = dialog.parentElement
      ? Array.from(dialog.parentElement.children)
        .filter((element): element is HTMLElement => element !== dialog && element instanceof HTMLElement)
      : []
    const snapshots = background.map((element) => ({
      element,
      hadInertAttribute: element.hasAttribute('inert'),
      inert: Boolean((element as HTMLElement & { inert?: boolean }).inert),
      ariaHidden: element.getAttribute('aria-hidden'),
      pointerEvents: element.style.pointerEvents,
    }))
    background.forEach((element) => {
      ;(element as HTMLElement & { inert?: boolean }).inert = true
      element.setAttribute('inert', '')
      element.setAttribute('aria-hidden', 'true')
      element.style.pointerEvents = 'none'
    })
    headingRef.current?.focus()
    return () => {
      snapshots.forEach(({ element, hadInertAttribute, inert, ariaHidden, pointerEvents }) => {
        ;(element as HTMLElement & { inert?: boolean }).inert = inert
        if (hadInertAttribute) element.setAttribute('inert', '')
        else element.removeAttribute('inert')
        if (ariaHidden === null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', ariaHidden)
        element.style.pointerEvents = pointerEvents
      })
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(returnFocusSelector)?.focus({ preventScroll: true })
      })
    }
  }, [headingRef, returnFocusSelector])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return

    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = getModalFocusableElements(dialog)
    if (focusable.length === 0) return

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const activeIndex = active ? focusable.indexOf(active) : -1
    const shouldWrap = event.shiftKey
      ? activeIndex <= 0
      : activeIndex === focusable.length - 1 || activeIndex < 0

    if (shouldWrap) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
  }

  return { dialogRef, handleKeyDown }
}

export function DetourCompass({
  currentBook,
  booksById,
  relations,
  onChoose,
  onClose,
}: {
  currentBook?: Book
  booksById: ReadonlyMap<string, Book>
  relations: BookRelation[]
  onChoose: (relation: BookRelation) => void
  onClose: () => void
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const { dialogRef, handleKeyDown } = useModalFocusTrap(headingRef, onClose, '[data-overlay-trigger="detour"]')

  return (
    <section ref={dialogRef} className="detour-compass" role="dialog" aria-modal="true" aria-labelledby="detour-title" onKeyDown={handleKeyDown}>
      <div className="compass-heading">
        <span>选择偏航方向{currentBook ? ` / 《${currentBook.title}》` : ''}</span>
        <button type="button" onClick={onClose} aria-label="取消偏航"><Icon name="close" /></button>
      </div>
      <h2 id="detour-title" ref={headingRef} tabIndex={-1}>你愿意离熟悉多远？</h2>
      {relations.length > 0 ? (
        <div className="direction-list">
          {relations.map((relation, index) => {
            const target = booksById.get(otherBookId(relation, currentBook?.id ?? relation.source))
            const copy = directionCopy(relation, target, index, relations.length)
            return (
              <button key={`${relation.source}:${relation.target}`} type="button" onClick={() => onChoose(relation)}>
                <small>0{index + 1} / {copy.band}{relation.provenance === 'reading-hypothesis' ? ` · ${relation.kind}` : ''}</small>
                <strong>{copy.title}</strong>
                <span>{copy.description}</span>
                <Icon name="arrow" />
              </button>
            )
          })}
        </div>
      ) : (
        <div className="direction-empty" role="status">
          <strong>这颗书星暂时没有可去的远方</strong>
          <p>它周围的灯还没有汇成一条路。可以回到观测，或从这里重新出发。</p>
          <button type="button" onClick={onClose}>返回观测</button>
        </div>
      )}
    </section>
  )
}

export function voyageCopy(relation: BookRelation, departure?: Book, arrival?: Book): { label: string; route: string } {
  const curatedLabels: Record<BookRelation['kind'], string> = {
    回声: '远方有回声',
    镜像: '镜面翻转',
    暗河: '暗河开航',
    裂隙: '裂隙显影',
    余烬: '余温未熄',
    潮汐: '书海涨潮',
  }
  const navigationLabel = relation.distanceBand === 'near'
    ? '沿近路航行'
    : relation.distanceBand === 'mid'
      ? '越过书云'
      : '驶向远星'
  const from = departure ? `《${departure.title}》` : '出发星'
  const to = arrival ? `《${arrival.title}》` : '远方书星'
  return {
    label: relation.provenance === 'reading-hypothesis' ? curatedLabels[relation.kind] : navigationLabel,
    route: `${from}  ·  ${to}`,
  }
}

export function VoyageNarration({ relation, from, to }: { relation: BookRelation; from?: Book; to?: Book }) {
  const copy = voyageCopy(relation, from, to)
  return (
    <div className="voyage-narration" role="status" aria-live="polite">
      <small>{copy.label}</small>
      <p>{copy.route}</p>
      <span>按退出键可停下镜头</span>
    </div>
  )
}

export function JourneyRail({ books, onSelect }: { books: Book[]; onSelect?: (book: Book) => void }) {
  if (books.length === 0) return null
  const visibleBooks = books.slice(-6)
  const omitted = books.length - visibleBooks.length
  const progress = books.length >= 3 ? '可留星图' : `再走 ${3 - books.length} 本可留星图`
  return (
    <aside className="journey-rail" aria-label="本次航迹">
      <small>本次航迹 · {books.length}/3 · {progress}</small>
      <ol>
        {omitted > 0 && <li className="omitted"><span>此前 {omitted} 站 ···</span></li>}
        {visibleBooks.map((book, index) => {
          const isCurrent = index === visibleBooks.length - 1
          const clickable = Boolean(onSelect) && !isCurrent
          return (
            <li key={`${book.id}:${index}`} className={isCurrent ? 'current' : ''} aria-current={isCurrent ? 'step' : undefined}>
              <i />
              {clickable ? (
                <button type="button" onClick={() => onSelect?.(book)}>《{book.title}》</button>
              ) : (
                <span>《{book.title}》</span>
              )}
            </li>
          )
        })}
      </ol>
    </aside>
  )
}

export function LibrarianBand({
  relation,
  from,
  to,
  onClose,
  onlineAvailable = false,
  onAskOnline,
}: {
  relation?: BookRelation
  from?: Book
  to: Book
  onClose: () => void
  onlineAvailable?: boolean
  onAskOnline?: (question: string) => Promise<string | undefined>
}) {
  const [mode, setMode] = useState<'reading' | 'basis'>('reading')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string>()
  const [loading, setLoading] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const { dialogRef, handleKeyDown } = useModalFocusTrap(headingRef, onClose, '[data-overlay-trigger="librarian"]')

  const provenance = relation?.provenance === 'catalog'
    ? '书云相逢'
    : relation?.provenance === 'semantic'
      ? '书海暗线'
      : relation?.provenance === 'reading-hypothesis'
        ? '阅读联想'
        : '单书观测'
  const basis = relation ? readableRelationBasis(relation, to) : []
  return (
    <section ref={dialogRef} className="librarian-band" role="dialog" aria-modal="true" aria-labelledby="librarian-title" onKeyDown={handleKeyDown}>
      <div className="signal-rule"><span /><i /><span /></div>
      <div className="signal-meta"><Icon name="signal" /> 馆员来信</div>
      <button className="signal-close" type="button" onClick={onClose} aria-label="关闭馆员来信"><Icon name="close" /></button>
      <h2 id="librarian-title" ref={headingRef} tabIndex={-1}>{relation ? '为什么是这一本？' : '这颗书星正在说什么？'}</h2>
      {answer ? <p>{answer}</p> : mode === 'basis' && relation ? null : (
        <>
          <p>{relation ? relationReading(relation, from, to) : `你正在单独观测《${to.title}》。它还没有前一跳，先让它独自发光。`}</p>
          {!relation && <p className="signal-next">再偏航一次，馆员便能说说两本书为何相遇。</p>}
        </>
      )}
      {mode === 'basis' && relation && (
        <div className="signal-evidence">
          <span>{provenance}</span>
          {basis.map((item) => <span key={item}>{item}</span>)}
        </div>
      )}
      {relation && (
        <div className="signal-actions">
          <button
            type="button"
            aria-pressed={mode === 'basis'}
            onClick={() => {
              setAnswer(undefined)
              setMode((current) => current === 'basis' ? 'reading' : 'basis')
            }}
          >
            {mode === 'basis' ? '返回解读' : '显示依据'}
          </button>
        </div>
      )}
      {onlineAvailable && onAskOnline && (
        <>
          <form
            className="signal-question"
            onSubmit={async (event) => {
              event.preventDefault()
              if (!question.trim() || loading) return
              setLoading(true)
              const next = await onAskOnline(question.trim())
              setAnswer(next ?? '远方暂时没有回信，这颗书星仍在这里发光。')
              setLoading(false)
            }}
          >
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              maxLength={240}
              placeholder="继续问问这本书"
              aria-label="向馆员来信继续提问"
            />
            <button type="submit" disabled={loading}>{loading ? '接收中' : '发送'}</button>
          </form>
          <small className="signal-disclosure">这封问询只带走你的问题、眼前两本书，以及最近五站航迹。</small>
        </>
      )}
    </section>
  )
}

export function StarChartReveal({
  dataUrl,
  onDownload,
  onClose,
}: {
  dataUrl: string
  onDownload: () => void
  onClose: () => void
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const { dialogRef, handleKeyDown } = useModalFocusTrap(headingRef, onClose, '[data-overlay-trigger="chart"]')

  return (
    <section ref={dialogRef} className="star-chart-reveal" role="dialog" aria-modal="true" aria-labelledby="chart-title" onKeyDown={handleKeyDown}>
      <div className="exposure-curtain" />
      <div className="chart-copy">
        <small>书架星系 · 私人星图</small>
        <h2 id="chart-title" ref={headingRef} tabIndex={-1}>你的迷路，已经显影。</h2>
        <p>空间被压成纸面，经过的书成为一幅只属于本次航行的未刊星图。</p>
        <div>
          <button className="ink-action" type="button" onClick={onDownload}>保存高清星图</button>
          <button type="button" onClick={onClose}>返回星海</button>
        </div>
      </div>
      <figure className="chart-plate"><img src={dataUrl} alt="本次阅读旅程生成的未刊星图" /></figure>
      <div className="vermilion-seal" aria-hidden="true">迷<br />路</div>
    </section>
  )
}

export function ErrorFallback({ message, onReset }: { message: string; onReset: () => void }) {
  return (
    <section className="error-fallback" role="alert">
      <small>观测中断</small>
      <h1>星海暂时失去显影。</h1>
      <p>{message}</p>
      <button type="button" onClick={onReset}>重新观测</button>
    </section>
  )
}
