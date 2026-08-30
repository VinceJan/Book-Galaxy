import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { GalaxyCanvas, type GalaxyCanvasHandle } from './galaxy/GalaxyCanvas'
import {
  BookObservatory,
  curatedThreadsFor,
  DetourCompass,
  ErrorFallback,
  HoverLabel,
  IntroScreen,
  JourneyRail,
  LibrarianBand,
  ObservatoryHeader,
  StarChartReveal,
  VoyageNarration,
} from './components/ExperienceUI'
import { initialExperienceState, experienceReducer } from './app/experienceReducer'
import {
  loadGalaxyData,
  makeRelationResolver,
  type CatalogNeighbour,
  type GalaxyData,
  type RuntimeBook,
} from './data/loadGalaxy'
import { demoJourneys } from './data/demoJourneys'
import { otherBookId } from './lib/galaxyMath'
import { Soundscape } from './lib/soundscape'
import { downloadStarChart, renderStarChart } from './lib/starChart'
import { askOnlineCurator, hasOnlineCurator } from './ai/curator'
import type { Book, BookRelation } from './types'

type SemanticNeighbour = CatalogNeighbour & { book: RuntimeBook }
type SelectionSource = 'pointer' | 'keyboard'

type FailureKind = 'catalog' | 'renderer'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

const failureMessages: Record<FailureKind, string> = {
  catalog: '书海暂时无法显影，请刷新页面后重新观测。',
  renderer: '星海暂时失去显影，请刷新页面后重试。',
}

export function publicFailureMessage(kind: FailureKind): string {
  return failureMessages[kind]
}

export function silenceSoundscape(
  sound: Pick<Soundscape, 'disable'> | undefined,
  setEnabled: (enabled: boolean) => void,
): void {
  sound?.disable()
  setEnabled(false)
}

export async function enableSoundscape(
  sound: Pick<Soundscape, 'enable' | 'disable'> | undefined,
  setEnabled: (enabled: boolean) => void,
): Promise<void> {
  if (!sound) {
    console.error('Book Galaxy sound enable failure', new Error('Soundscape is not initialized'))
    setEnabled(false)
    return
  }
  try {
    await sound.enable()
    setEnabled(true)
  } catch (error) {
    console.error('Book Galaxy sound enable failure', error)
    silenceSoundscape(sound, setEnabled)
  }
}

export function observeReducedMotion(setReducedMotion: (value: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined
  const media = window.matchMedia(REDUCED_MOTION_QUERY)
  const sync = (event?: MediaQueryListEvent) => setReducedMotion(event?.matches ?? media.matches)
  sync()
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }
  if (typeof media.addListener === 'function') {
    media.addListener(sync)
    return () => media.removeListener(sync)
  }
  return () => undefined
}

function eraLocationLabel(year: number | undefined): string | undefined {
  if (typeof year !== 'number' || !Number.isFinite(year) || year === 0) return undefined
  if (year < 0) {
    const century = Math.floor((Math.abs(year) - 1) / 100) + 1
    return `公元前${century}世纪`
  }
  return `${Math.floor(year / 10) * 10}年代`
}

function locationLabel(book: RuntimeBook | undefined): string {
  if (!book) return '未命名星域'
  const labelled = (book as RuntimeBook & { clusterLabels?: string[] }).clusterLabels?.filter(Boolean)
  if (labelled?.length) return labelled.slice(0, 2).join(' · ')
  const theme = book.themes.find(Boolean)
  const year = eraLocationLabel(book.year)
  return [theme, year].filter(Boolean).join(' · ') || '书云交界处'
}

function semanticNeighboursFor(book: RuntimeBook | undefined, booksById: ReadonlyMap<string, RuntimeBook>): SemanticNeighbour[] {
  if (!book) return []
  return (book.neighbors ?? [])
    .map((neighbour) => ({ ...neighbour, book: booksById.get(neighbour.id) }))
    .filter((neighbour): neighbour is SemanticNeighbour => Boolean(neighbour.book))
    .sort((left, right) => (left.semanticRank ?? Number.MAX_SAFE_INTEGER) - (right.semanticRank ?? Number.MAX_SAFE_INTEGER))
}

const emptyData: GalaxyData = {
  books: [],
  curated: [],
  curatedRelations: [],
  catalogEdges: [],
  relationCount: 0,
  source: '正在载入中文书海',
}

export default function App() {
  const [state, dispatch] = useReducer(experienceReducer, initialExperienceState)
  const [data, setData] = useState<GalaxyData>(emptyData)
  const [catalogState, setCatalogState] = useState<'loading' | 'ready'>('loading')
  const [engineReady, setEngineReady] = useState(false)
  const [hovered, setHovered] = useState<{ book: Book; position: { x: number; y: number } }>()
  const [soundEnabled, setSoundEnabled] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(() => (
    typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia(REDUCED_MOTION_QUERY).matches
  ))
  const galaxyRef = useRef<GalaxyCanvasHandle>(null)
  const soundRef = useRef<Soundscape | undefined>(undefined)
  const onlineControllerRef = useRef<AbortController | undefined>(undefined)
  const keyboardSelectionRef = useRef(false)
  const lastSelectedIdRef = useRef<string | undefined>(undefined)

  const reportFailure = useCallback((kind: FailureKind, detail: unknown) => {
    console.error(`Book Galaxy ${kind} failure`, detail)
    dispatch({ type: 'ERROR', message: publicFailureMessage(kind) })
  }, [])

  useEffect(() => {
    soundRef.current = new Soundscape()
    return () => soundRef.current?.dispose()
  }, [])

  useEffect(() => observeReducedMotion(setReducedMotion), [])

  useEffect(() => {
    const controller = new AbortController()
    void loadGalaxyData(controller.signal)
      .then((loaded) => {
        setEngineReady(false)
        setData(loaded)
        setCatalogState('ready')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        reportFailure('catalog', error)
      })
    return () => controller.abort()
  }, [reportFailure])

  const booksById = useMemo(() => new Map(data.books.map((book) => [book.id, book])), [data.books])
  const indexById = useMemo(() => new Map(data.books.map((book, index) => [book.id, index])), [data.books])
  const resolver = useMemo(() => makeRelationResolver(data), [data])
  const selected = state.selectedId ? booksById.get(state.selectedId) : undefined

  useEffect(() => {
    const overlayOpen = state.directionsOpen || state.librarianOpen || state.status === 'chart'
    const selectedChanged = lastSelectedIdRef.current !== selected?.id
    lastSelectedIdRef.current = selected?.id
    if (!selectedChanged || overlayOpen || state.status !== 'exploring' || !selected) return

    let attempts = 0
    let frame = 0
    const focusTitle = () => {
      const title = document.querySelector<HTMLElement>('[data-book-observatory-title]')
        ?? document.querySelector<HTMLElement>('.book-observatory h1, .book-observatory h2, .book-observatory h3, .book-observatory h4, .book-observatory h5, .book-observatory h6')
      if (title) {
        title.focus({ preventScroll: true })
        return
      }
      if (attempts < 3) {
        attempts += 1
        frame = window.requestAnimationFrame(focusTitle)
      }
    }
    frame = window.requestAnimationFrame(focusTitle)
    return () => window.cancelAnimationFrame(frame)
  }, [selected?.id, state.directionsOpen, state.librarianOpen, state.status])

  const semanticNeighbors = useMemo(
    () => semanticNeighboursFor(selected, booksById),
    [booksById, selected],
  )
  const curatedThreads = useMemo(
    () => selected ? curatedThreadsFor(selected.id, data.curatedRelations, booksById) : [],
    [booksById, data.curatedRelations, selected],
  )
  const curatedRelationCount = data.curatedRelationStats?.relationCount ?? 0
  const nearbyBooks = useMemo(() => {
    if (!selected) return []
    const candidateIds = [
      ...(selected.spatialNeighbors ?? []),
      ...semanticNeighbors.map((neighbour) => neighbour.book.id),
    ]
    const seen = new Set<string>()
    return candidateIds
      .filter((id) => id !== selected.id && !seen.has(id) && Boolean(booksById.get(id)))
      .map((id) => {
        seen.add(id)
        return booksById.get(id)
      })
      .filter((book): book is RuntimeBook => Boolean(book))
      .slice(0, 3)
  }, [booksById, selected, semanticNeighbors])
  const selectedLocationLabel = useMemo(() => locationLabel(selected), [selected])
  const journeyBooks = state.journeyIds.map((id) => booksById.get(id)).filter((book): book is Book => Boolean(book))
  const visited = useMemo(() => new Set(state.journeyIds), [state.journeyIds])
  const directions = useMemo(() => {
    if (!selected) return []
    return resolver.optionsFor(selected.id, visited)
  }, [resolver, selected, visited])
  const journeyHeadId = state.journeyIds.at(-1)
  const selectedJourneyIndex = selected ? state.journeyIds.lastIndexOf(selected.id) : -1
  const observedRelation = selectedJourneyIndex > 0
    ? state.journeyRelations[selectedJourneyIndex - 1]
    : undefined
  const observedFrom = selectedJourneyIndex > 0 ? journeyBooks[selectedJourneyIndex - 1] : undefined
  const pendingDestination = state.pendingRelation && selected
    ? booksById.get(otherBookId(state.pendingRelation, selected.id))
    : undefined
  const selectedIsJourneyHead = Boolean(selected && selected.id === journeyHeadId)

  const emphasisIds = useMemo(() => {
    const ids = selected ? [selected.id] : []
    if (selected) ids.push(...nearbyBooks.map((book) => book.id))
    if (selected) ids.push(...curatedThreads.map(({ target }) => target.id))
    if (state.directionsOpen && selected) {
      ids.push(...directions.map((relation) => otherBookId(relation, selected.id)))
    }
    if (state.pendingRelation && selected) ids.push(otherBookId(state.pendingRelation, selected.id))
    return ids
  }, [curatedThreads, directions, nearbyBooks, selected, state.directionsOpen, state.pendingRelation])

  const stageKeyboardEnabled = state.status === 'exploring'
    && !selected
    && !state.directionsOpen
    && !state.librarianOpen

  const startFrom = useCallback(async (book: Book) => {
    galaxyRef.current?.clearRelation()
    keyboardSelectionRef.current = false
    dispatch({ type: 'START', bookId: book.id })
    setHovered(undefined)
    await galaxyRef.current?.focusBook(book.id, 1_450)
    soundRef.current?.focus(book.id.length)
  }, [])

  const selectBook = useCallback(async (book: Book, source: SelectionSource = 'pointer') => {
    if (state.status === 'intro') {
      if (catalogState !== 'loading') await startFrom(book)
      return
    }
    if (state.status !== 'exploring') return
    // The stage is intentionally removed from the tab order while the book
    // observatory is open.  Remember keyboard entry so closing the panel can
    // return the reader to the same keyboard surface.
    keyboardSelectionRef.current = source === 'keyboard'
    dispatch({ type: 'SELECT', bookId: book.id })
    setHovered(undefined)
    await galaxyRef.current?.focusBook(book.id, 900)
    soundRef.current?.focus(book.id.length)
  }, [catalogState, startFrom, state.status])

  const travel = useCallback(async (relation: BookRelation) => {
    if (!selected || state.status !== 'exploring') return
    const targetId = otherBookId(relation, selected.id)
    const target = booksById.get(targetId)
    if (!target) return
    const sequence = state.travelSequence + 1
    dispatch({ type: 'TRAVEL', relation })
    galaxyRef.current?.revealRelation(selected.id, targetId)
    soundRef.current?.detour(Math.floor(relation.surprise * 100))
    const completed = await galaxyRef.current?.focusBook(targetId, reducedMotion ? 0 : 1_650)
    if (completed === false) {
      dispatch({ type: 'CANCEL_TRAVEL', sequence })
      galaxyRef.current?.clearRelation()
      return
    }
    dispatch({ type: 'ARRIVE', bookId: targetId, relation, sequence })
    soundRef.current?.focus(targetId.length)
  }, [booksById, reducedMotion, selected, state.status, state.travelSequence])

  const followCuratedThread = useCallback(async (relation: BookRelation) => {
    if (!selected) return
    const targetId = otherBookId(relation, selected.id)
    const target = booksById.get(targetId)
    if (!target) return
    await travel(relation)
  }, [booksById, selected, travel])

  const returnToOrigin = useCallback(async () => {
    const originId = state.journeyIds[0]
    if (!originId) return
    dispatch({ type: 'SELECT', bookId: originId })
    galaxyRef.current?.clearRelation()
    await galaxyRef.current?.focusBook(originId, 1_050)
  }, [state.journeyIds])

  const reset = useCallback(() => {
    onlineControllerRef.current?.abort()
    keyboardSelectionRef.current = false
    silenceSoundscape(soundRef.current, setSoundEnabled)
    dispatch({ type: 'RESET' })
    setHovered(undefined)
    galaxyRef.current?.resetView()
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>('#departure')?.focus({ preventScroll: true })
    })
  }, [])

  const imprint = useCallback(() => {
    if (journeyBooks.length < 3) return
    const demo = demoJourneys.find((journey) => (
      journey.entryBookId === journeyBooks[0]?.id
      && journeyBooks.every((book, index) => journey.steps[index]?.bookId === book.id)
    ))
    const dataUrl = renderStarChart({
      books: journeyBooks,
      relations: state.journeyRelations,
      title: demo?.title ?? '一次有意义的偏航',
      subtitle: demo?.closingLine ?? '你没有找到答案，但带回了一条此前不存在的路。',
    })
    soundRef.current?.imprint()
    dispatch({ type: 'SHOW_CHART', dataUrl })
  }, [journeyBooks, state.journeyRelations])

  const toggleSound = useCallback(async () => {
    if (soundEnabled) {
      soundRef.current?.disable()
      setSoundEnabled(false)
      return
    }
    await enableSoundscape(soundRef.current, setSoundEnabled)
  }, [soundEnabled])

  const askOnline = useCallback(async (question: string) => {
    if (!selected) return undefined
    onlineControllerRef.current?.abort()
    const controller = new AbortController()
    onlineControllerRef.current = controller
    return askOnlineCurator({
      question,
      from: observedFrom,
      to: selected,
      relation: observedRelation,
      journey: journeyBooks,
    }, controller.signal)
  }, [journeyBooks, observedFrom, observedRelation, selected])

  const handleHover = useCallback((book: Book | null, position?: { x: number; y: number }) => {
    setHovered(book && position ? { book, position } : undefined)
  }, [])

  if (state.error) return <ErrorFallback message={state.error} onReset={() => window.location.reload()} />

  const ready = engineReady && catalogState === 'ready'
  return (
    <main className={`app-shell status-${state.status}${reducedMotion ? ' reduced-motion' : ''}`} aria-label="书架星系 · 暗物质图书馆">
      <GalaxyCanvas
        ref={galaxyRef}
        books={data.books}
        emphasisIds={emphasisIds}
        keyboardEnabled={stageKeyboardEnabled}
        reducedMotion={reducedMotion}
        onHover={handleHover}
        onSelect={selectBook}
        onReady={() => setEngineReady(true)}
        onError={(message) => reportFailure('renderer', message)}
      />

      {state.status === 'intro' ? (
        <IntroScreen
          books={data.books}
          ready={ready}
          bookCount={data.books.length}
          relationCount={data.relationCount}
          curatedRelationCount={curatedRelationCount}
          onStart={startFrom}
        />
      ) : (
        <>
          <ObservatoryHeader
            bookCount={data.books.length}
            relationCount={data.relationCount}
            soundEnabled={soundEnabled}
            reducedMotion={reducedMotion}
            onToggleSound={toggleSound}
            onToggleMotion={() => setReducedMotion((value) => !value)}
            onReset={reset}
          />
          {state.status === 'exploring' && <HoverLabel book={hovered?.book ?? null} position={hovered?.position} />}
          <JourneyRail books={journeyBooks} />
          {selected && state.status !== 'travelling' && (
            <BookObservatory
              book={selected}
              index={indexById.get(selected.id) ?? 0}
              total={data.books.length}
              locationLabel={selectedLocationLabel}
              semanticNeighbors={semanticNeighbors}
              nearbyBooks={nearbyBooks}
              curatedThreads={curatedThreads}
              canImprint={journeyBooks.length >= 3 && selectedIsJourneyHead}
              canDetour={selectedIsJourneyHead}
              hasRelationship={Boolean(observedRelation)}
              onClose={() => {
                keyboardSelectionRef.current = false
                dispatch({ type: 'CLEAR_SELECTION' })
                window.requestAnimationFrame(() => galaxyRef.current?.focusStage())
              }}
              onObserveNearby={selectBook}
              onFollowCuratedThread={followCuratedThread}
              onDetour={() => dispatch({ type: 'OPEN_DIRECTIONS' })}
              onRestart={() => startFrom(selected)}
              onAsk={() => dispatch({ type: 'TOGGLE_LIBRARIAN', open: true })}
              onImprint={imprint}
              onReturn={returnToOrigin}
            />
          )}
          {state.directionsOpen && (
            <DetourCompass
              currentBook={selected}
              booksById={booksById}
              relations={directions}
              onChoose={travel}
              onClose={() => dispatch({ type: 'CLOSE_DIRECTIONS' })}
            />
          )}
          {state.status === 'travelling' && state.pendingRelation && (
            <VoyageNarration relation={state.pendingRelation} from={selected} to={pendingDestination} />
          )}
          {state.librarianOpen && selected && (
            <LibrarianBand
              relation={observedRelation}
              from={observedFrom}
              to={selected}
              onlineAvailable={hasOnlineCurator()}
              onAskOnline={askOnline}
              onClose={() => dispatch({ type: 'TOGGLE_LIBRARIAN', open: false })}
            />
          )}
          {state.status === 'chart' && state.chartDataUrl && (
            <StarChartReveal
              dataUrl={state.chartDataUrl}
              onDownload={() => downloadStarChart(state.chartDataUrl!)}
              onClose={() => dispatch({ type: 'CLOSE_CHART' })}
            />
          )}
        </>
      )}
    </main>
  )
}
