import { useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import type { Book, BookRelation } from '../types'

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
  onStart: (book: Book) => void
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function IntroScreen({ books, ready, bookCount, relationCount, onStart }: IntroProps) {
  const [query, setQuery] = useState('')
  const suggestions = useMemo(() => {
    const normalized = normalizeSearch(query.trim())
    if (!normalized) return books.slice(0, 5)
    return books
      .filter((book) => normalizeSearch(`${book.title}${book.originalTitle ?? ''}${book.author}`).includes(normalized))
      .slice(0, 5)
  }, [books, query])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const hasQuery = Boolean(query.trim())
    const selected = hasQuery ? suggestions[0] : books[0]
    if (selected && ready) onStart(selected)
  }

  const noMatch = Boolean(query.trim()) && suggestions.length === 0

  return (
    <section className="intro" aria-labelledby="intro-title">
      <div className="intro-kicker">LIBRARY / AFTER SEARCH</div>
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
            onChange={(event) => setQuery(event.target.value)}
            placeholder="输入书名或作者"
            autoComplete="off"
          />
          <span aria-hidden="true">》</span>
          <button type="submit" disabled={!ready || books.length === 0 || noMatch}>
            {ready ? '开始偏航' : '星海显影中'}
            <Icon name="arrow" />
          </button>
        </div>
        {query && suggestions.length > 0 && (
          <div className="search-suggestions" role="listbox" aria-label="书籍建议">
            {suggestions.map((book) => (
              <button key={book.id} type="button" disabled={!ready} onClick={() => ready && onStart(book)} role="option">
                <span>《{book.title}》</span>
                <small>{book.author}</small>
              </button>
            ))}
          </div>
        )}
        {noMatch && <div className="search-empty" role="status">这片星海中暂未找到它。试试书名的一部分，或从下方熟悉的书出发。</div>}
      </form>
      <div className="intro-presets" aria-label="推荐出发点">
        {books.slice(0, 4).map((book) => (
          <button key={book.id} type="button" onClick={() => ready && onStart(book)}>
            《{book.title}》
          </button>
        ))}
      </div>
      <div className="intro-proof" aria-label="数据规模">
        <span><strong>{bookCount.toLocaleString('zh-CN')}</strong> 本真实书籍</span>
        <span><strong>{relationCount.toLocaleString('zh-CN')}</strong> 条潜在引力</span>
      </div>
      <div className="intro-challenges">CHALLENGE 02 × 03</div>
    </section>
  )
}

interface HeaderProps {
  bookCount: number
  relationCount: number
  soundEnabled: boolean
  reducedMotion: boolean
  onToggleSound: () => void
  onToggleMotion: () => void
  onReset: () => void
}

export function ObservatoryHeader({
  bookCount,
  relationCount,
  soundEnabled,
  reducedMotion,
  onToggleSound,
  onToggleMotion,
  onReset,
}: HeaderProps) {
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen()
  }
  return (
    <header className="observatory-header">
      <button className="wordmark" type="button" onClick={onReset} aria-label="返回星系入口">
        <span className="wordmark-mark">BG</span>
        <span><strong>书架星系</strong><small>暗物质图书馆</small></span>
      </button>
      <div className="catalog-state">
        <span>{bookCount.toLocaleString('zh-CN')} 颗书星</span>
        <i />
        <span>{relationCount.toLocaleString('zh-CN')} 条隐藏引力</span>
      </div>
      <nav className="observatory-tools" aria-label="观测工具">
        <button type="button" onClick={onToggleMotion} aria-pressed={reducedMotion} title="稳定镜头">
          <Icon name="motion" /><span>{reducedMotion ? '稳定镜头' : '动态镜头'}</span>
        </button>
        <button type="button" onClick={onToggleSound} aria-pressed={soundEnabled} title="声音">
          <Icon name={soundEnabled ? 'sound' : 'mute'} /><span>{soundEnabled ? '声音开启' : '开启声音'}</span>
        </button>
        <button type="button" onClick={fullscreen} title="全屏">
          <Icon name="expand" /><span>全屏</span>
        </button>
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

interface BookPanelProps {
  book: Book
  index: number
  total: number
  canImprint: boolean
  canDetour: boolean
  hasRelationship: boolean
  onClose: () => void
  onDetour: () => void
  onRestart: () => void
  onAsk: () => void
  onImprint: () => void
  onReturn: () => void
}

export function BookObservatory({
  book,
  index,
  total,
  canImprint,
  canDetour,
  hasRelationship,
  onClose,
  onDetour,
  onRestart,
  onAsk,
  onImprint,
  onReturn,
}: BookPanelProps) {
  return (
    <aside className="book-observatory" aria-labelledby="observed-book-title">
      <div className="panel-heading">
        <span>观测对象 {String(index + 1).padStart(2, '0')} / {total.toLocaleString('zh-CN')}</span>
        <button type="button" onClick={onClose} aria-label="收起书籍信息"><Icon name="close" /></button>
      </div>
      <div className="book-coordinate">{book.year ?? '年代未知'} · {book.language ?? '多语种'} · {book.themes[0] ?? '未命名星域'}</div>
      <h2 id="observed-book-title">{book.title}</h2>
      {book.originalTitle && <p className="original-title">{book.originalTitle}</p>}
      <p className="book-byline">{book.author}</p>
      <p className="book-summary">{book.summary ?? '这颗星只有书目信息。靠近它，关系会替它开口。'}</p>
      {book.sourceUrl && (
        <a className="source-link" href={book.sourceUrl} target="_blank" rel="noreferrer">
          核查书目来源 ↗
        </a>
      )}
      <div className="theme-row">
        {book.themes.slice(0, 4).map((theme) => <span key={theme}>{theme}</span>)}
      </div>
      <div className="panel-actions">
        <button className="primary-action" type="button" autoFocus onClick={canDetour ? onDetour : onRestart}>
          {canDetour ? '从这里偏航' : '以此为新的出发星'} <Icon name="arrow" />
        </button>
        <button type="button" onClick={onAsk}><Icon name="signal" /> {hasRelationship ? '询问引力来源' : '询问这颗书星'}</button>
        {canImprint && <button type="button" onClick={onImprint}>留下这次迷路</button>}
        <button className="quiet-action" type="button" onClick={onReturn}>返回出发星</button>
      </div>
    </aside>
  )
}

function directionCopy(relation: BookRelation): [string, string] {
  if (relation.surprise < 0.52) return ['沿着近处的回声', '先看见它们共享的问题']
  if (relation.surprise < 0.8) return ['穿过一条隐秘暗河', '跨过时代与类型的边界']
  return ['去最远但仍说得通', '让陌生抵达，但不让意义断裂']
}

export function DetourCompass({
  relations,
  onChoose,
  onClose,
}: {
  relations: BookRelation[]
  onChoose: (relation: BookRelation) => void
  onClose: () => void
}) {
  return (
    <section className="detour-compass" role="dialog" aria-modal="true" aria-labelledby="detour-title">
      <div className="compass-heading">
        <span>选择偏航方向</span>
        <button type="button" onClick={onClose} aria-label="取消偏航"><Icon name="close" /></button>
      </div>
      <h2 id="detour-title">你愿意离熟悉多远？</h2>
      <div className="direction-list">
        {relations.map((relation, index) => {
          const copy = directionCopy(relation)
          return (
            <button key={`${relation.source}:${relation.target}`} type="button" autoFocus={index === 0} onClick={() => onChoose(relation)}>
              <small>0{index + 1} / {relation.kind}</small>
              <strong>{copy[0]}</strong>
              <span>{copy[1]}</span>
              <Icon name="arrow" />
            </button>
          )
        })}
      </div>
    </section>
  )
}

export function VoyageNarration({ relation }: { relation: BookRelation }) {
  return (
    <div className="voyage-narration" role="status" aria-live="polite">
      <small>{relation.kind}正在改变航向</small>
      <p>“{relation.sentence}”</p>
      <span>ESC 可中止镜头</span>
    </div>
  )
}

export function JourneyRail({ books }: { books: Book[] }) {
  if (books.length === 0) return null
  const visibleBooks = books.slice(-6)
  const omitted = books.length - visibleBooks.length
  return (
    <aside className="journey-rail" aria-label="本次航迹">
      <small>本次航迹</small>
      <ol>
        {omitted > 0 && <li className="omitted"><span>此前 {omitted} 站 ···</span></li>}
        {visibleBooks.map((book, index) => (
          <li key={`${book.id}:${index}`} className={index === visibleBooks.length - 1 ? 'current' : ''}>
            <i /><span>《{book.title}》</span>
          </li>
        ))}
      </ol>
    </aside>
  )
}

export function LibrarianBand({
  relation,
  to,
  onClose,
  onlineAvailable = false,
  onAskOnline,
}: {
  relation?: BookRelation
  to: Book
  onClose: () => void
  onlineAvailable?: boolean
  onAskOnline?: (question: string) => Promise<string | undefined>
}) {
  const [mode, setMode] = useState<'reading' | 'basis' | 'bold'>('reading')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string>()
  const [loading, setLoading] = useState(false)
  const provenance = relation?.provenance === 'catalog'
    ? '书目邻接'
    : relation?.provenance === 'semantic'
      ? '语义推断'
      : relation?.provenance === 'reading-hypothesis'
        ? '阅读联想'
        : '单书观测'
  const boldReading = relation
    ? `再把这条引力推远一点：${relation.sentence} 它们也许并不相似，而是在不同语境里替同一个问题保留了两种相反的答案。`
    : `《${to.title}》暂时没有前一跳需要证明。把它当作新的出发星，星海才会为它寻找一条可解释的偏航。`
  const basisReading = relation
    ? `这条连接依据：${relation.basis.join('、')}。它被标记为“${provenance}”，不是文学史上的确定影响关系。`
    : `这颗书星的题名与作者来自${to.source ?? '开放书目'}；当前主题为${to.themes.slice(0, 3).join('、') || '尚未分类'}。单书信息不构成两本书之间的关系。`
  return (
    <section className="librarian-band" role="dialog" aria-modal="true" aria-labelledby="librarian-title">
      <div className="signal-rule"><span /><i /><span /></div>
      <div className="signal-meta"><Icon name="signal" /> 馆员波段 / SIGNAL 07</div>
      <button className="signal-close" type="button" autoFocus onClick={onClose} aria-label="关闭馆员波段"><Icon name="close" /></button>
      <h2 id="librarian-title">{relation ? '为什么是这一本？' : '这颗书星正在说什么？'}</h2>
      <p>
        {answer ?? (mode === 'basis'
          ? basisReading
          : mode === 'bold'
            ? boldReading
            : relation?.sentence ?? `你正在单独观测《${to.title}》。当前没有一条可供解释的前置引力，因此这里不会伪造关系。`)}
      </p>
      <div className="signal-evidence">
        <span>{provenance}</span>
        {relation?.basis.slice(0, 3).map((basis) => <span key={basis}>{basis}</span>)}
      </div>
      <div className="signal-actions">
        <button type="button" onClick={() => { setAnswer(undefined); setMode('bold') }}>再大胆一点</button>
        <button type="button" onClick={() => { setAnswer(undefined); setMode('basis') }}>显示依据</button>
      </div>
      {onlineAvailable && onAskOnline && (
        <>
          <form
            className="signal-question"
            onSubmit={async (event) => {
              event.preventDefault()
              if (!question.trim() || loading) return
              setLoading(true)
              const next = await onAskOnline(question.trim())
              setAnswer(next ?? '远方波段暂时没有回应，本地引力解释仍然有效。')
              setLoading(false)
            }}
          >
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              maxLength={240}
              placeholder="继续追问这条关系"
              aria-label="向馆员波段继续追问"
            />
            <button type="submit" disabled={loading}>{loading ? '接收中' : '发送'}</button>
          </form>
          <small className="signal-disclosure">发送时仅会离开浏览器：当前问题、两本书、关系依据与最近五站航迹。</small>
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
  return (
    <section className="star-chart-reveal" role="dialog" aria-modal="true" aria-labelledby="chart-title">
      <div className="exposure-curtain" />
      <div className="chart-copy">
        <small>BOOKSHELF GALAXY / PRIVATE PLATE</small>
        <h2 id="chart-title">你的迷路，已经显影。</h2>
        <p>空间被压成纸面，经过的书成为一幅只属于本次航行的未刊星图。</p>
        <div>
          <button className="ink-action" type="button" autoFocus onClick={onDownload}>保存高清星图</button>
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
      <small>OBSERVATION INTERRUPTED</small>
      <h1>星海暂时失去显影。</h1>
      <p>{message}</p>
      <button type="button" onClick={onReset}>重新观测</button>
    </section>
  )
}
