import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { GalaxyCanvas, type GalaxyCanvasHandle } from './galaxy/GalaxyCanvas'
import {
  BookObservatory,
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
  initialCuratedBooks,
  loadGalaxyData,
  makeRelationResolver,
  richCuratedRelations,
  type GalaxyData,
} from './data/loadGalaxy'
import { demoJourneys } from './data/demoJourneys'
import { otherBookId } from './lib/galaxyMath'
import { Soundscape } from './lib/soundscape'
import { downloadStarChart, renderStarChart } from './lib/starChart'
import { askOnlineCurator, hasOnlineCurator } from './ai/curator'
import type { Book, BookRelation } from './types'

const fallbackData: GalaxyData = {
  books: initialCuratedBooks,
  curated: initialCuratedBooks,
  curatedRelations: richCuratedRelations,
  catalogEdges: [],
  relationCount: richCuratedRelations.length,
  source: '精修策展书目',
}

export default function App() {
  const [state, dispatch] = useReducer(experienceReducer, initialExperienceState)
  const [data, setData] = useState<GalaxyData>(fallbackData)
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'fallback'>('loading')
  const [engineReady, setEngineReady] = useState(false)
  const [hovered, setHovered] = useState<{ book: Book; position: { x: number; y: number } }>()
  const [soundEnabled, setSoundEnabled] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const galaxyRef = useRef<GalaxyCanvasHandle>(null)
  const soundRef = useRef<Soundscape | undefined>(undefined)
  const onlineControllerRef = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    soundRef.current = new Soundscape()
    return () => soundRef.current?.dispose()
  }, [])

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
        console.warn('Falling back to curated catalog:', error)
        setCatalogState('fallback')
      })
    return () => controller.abort()
  }, [])

  const booksById = useMemo(() => new Map(data.books.map((book) => [book.id, book])), [data.books])
  const indexById = useMemo(() => new Map(data.books.map((book, index) => [book.id, index])), [data.books])
  const resolver = useMemo(() => makeRelationResolver(data), [data])
  const selected = state.selectedId ? booksById.get(state.selectedId) : undefined
  const journeyBooks = state.journeyIds.map((id) => booksById.get(id)).filter((book): book is Book => Boolean(book))
  const visited = useMemo(() => new Set(state.journeyIds), [state.journeyIds])
  const directions = useMemo(() => {
    if (!selected) return []
    const options = resolver.optionsFor(selected.id, visited)
    const directedJourney = demoJourneys.find((journey) => journey.entryBookId === state.journeyIds[0])
    const stepIndex = directedJourney?.steps.findIndex((step) => step.bookId === selected.id) ?? -1
    const nextId = stepIndex >= 0 ? directedJourney?.steps[stepIndex + 1]?.bookId : undefined
    if (!nextId || visited.has(nextId)) return options
    const directedRelation = data.curatedRelations.find((relation) =>
      (relation.source === selected.id && relation.target === nextId)
      || (relation.target === selected.id && relation.source === nextId),
    )
    if (!directedRelation || options.includes(directedRelation)) return options

    const result = options.filter((relation) => otherBookId(relation, selected.id) !== nextId)
    const surpriseBands = [0.32, 0.67, 0.86]
    const band = surpriseBands.reduce((best, value, index) => (
      Math.abs(value - directedRelation.surprise) < Math.abs(surpriseBands[best] - directedRelation.surprise)
        ? index
        : best
    ), 0)
    const insertionIndex = Math.min(band, result.length)
    result.splice(insertionIndex, result.length >= 3 ? 1 : 0, directedRelation)
    return result.slice(0, 3)
  }, [data.curatedRelations, resolver, selected, state.journeyIds, visited])
  const journeyHeadId = state.journeyIds.at(-1)
  const selectedJourneyIndex = selected ? state.journeyIds.lastIndexOf(selected.id) : -1
  const observedRelation = selectedJourneyIndex > 0
    ? state.journeyRelations[selectedJourneyIndex - 1]
    : undefined
  const observedFrom = selectedJourneyIndex > 0 ? journeyBooks[selectedJourneyIndex - 1] : undefined
  const selectedIsJourneyHead = Boolean(selected && selected.id === journeyHeadId)

  const emphasisIds = useMemo(() => {
    const ids = selected ? [selected.id] : []
    if (state.directionsOpen && selected) {
      ids.push(...directions.map((relation) => otherBookId(relation, selected.id)))
    }
    if (state.pendingRelation && selected) ids.push(otherBookId(state.pendingRelation, selected.id))
    return ids
  }, [directions, selected, state.directionsOpen, state.pendingRelation])

  const startFrom = useCallback(async (book: Book) => {
    dispatch({ type: 'START', bookId: book.id })
    setHovered(undefined)
    await galaxyRef.current?.focusBook(book.id, 1_450)
    soundRef.current?.focus(book.id.length)
  }, [])

  const selectBook = useCallback(async (book: Book) => {
    if (state.status === 'intro') {
      if (catalogState !== 'loading') await startFrom(book)
      return
    }
    if (state.status !== 'exploring') return
    dispatch({ type: 'SELECT', bookId: book.id })
    setHovered(undefined)
    await galaxyRef.current?.focusBook(book.id, 900)
    soundRef.current?.focus(book.id.length)
  }, [catalogState, startFrom, state.status])

  const travel = useCallback(async (relation: BookRelation) => {
    if (!selected || selected.id !== journeyHeadId || state.status !== 'exploring') return
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
  }, [booksById, journeyHeadId, reducedMotion, selected, state.status, state.travelSequence])

  const returnToOrigin = useCallback(async () => {
    const originId = state.journeyIds[0]
    if (!originId) return
    dispatch({ type: 'SELECT', bookId: originId })
    galaxyRef.current?.clearRelation()
    await galaxyRef.current?.focusBook(originId, 1_050)
  }, [state.journeyIds])

  const reset = useCallback(() => {
    onlineControllerRef.current?.abort()
    dispatch({ type: 'RESET' })
    setHovered(undefined)
    galaxyRef.current?.resetView()
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
    await soundRef.current?.enable()
    setSoundEnabled(true)
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

  const ready = engineReady && catalogState !== 'loading'
  return (
    <main className={`app-shell status-${state.status}`} aria-label="书架星系 · 暗物质图书馆">
      <GalaxyCanvas
        ref={galaxyRef}
        books={data.books}
        emphasisIds={emphasisIds}
        reducedMotion={reducedMotion}
        onHover={handleHover}
        onSelect={selectBook}
        onReady={() => setEngineReady(true)}
        onError={(message) => dispatch({ type: 'ERROR', message })}
      />

      {state.status === 'intro' ? (
        <IntroScreen
          books={data.books}
          ready={ready}
          bookCount={data.books.length}
          relationCount={data.relationCount}
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
          {selected && state.status === 'exploring' && !state.directionsOpen && !state.librarianOpen && (
            <BookObservatory
              book={selected}
              index={indexById.get(selected.id) ?? 0}
              total={data.books.length}
              canImprint={journeyBooks.length >= 3 && selectedIsJourneyHead}
              canDetour={selectedIsJourneyHead}
              hasRelationship={Boolean(observedRelation)}
              onClose={() => dispatch({ type: 'CLEAR_SELECTION' })}
              onDetour={() => dispatch({ type: 'OPEN_DIRECTIONS' })}
              onRestart={() => startFrom(selected)}
              onAsk={() => dispatch({ type: 'TOGGLE_LIBRARIAN', open: true })}
              onImprint={imprint}
              onReturn={returnToOrigin}
            />
          )}
          {state.directionsOpen && (
            <DetourCompass
              relations={directions}
              onChoose={travel}
              onClose={() => dispatch({ type: 'CLOSE_DIRECTIONS' })}
            />
          )}
          {state.status === 'travelling' && state.pendingRelation && <VoyageNarration relation={state.pendingRelation} />}
          {state.librarianOpen && selected && (
            <LibrarianBand
              relation={observedRelation}
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
