import { forwardRef, useEffect, useImperativeHandle, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Book, MapRegion } from '../types'
import type { GalaxyEngine } from './GalaxyEngine'

// three.js and the engine ship as their own chunk; start fetching it as soon
// as this module loads so it arrives alongside the catalog.
const engineModule = typeof window === 'undefined' ? undefined : import('./GalaxyEngine')

export interface GalaxyCanvasHandle {
  focusBook: (id: string, duration?: number, options?: { ceremony?: boolean }) => Promise<boolean | undefined>
  focusStage: () => void
  revealRelation: (sourceId: string, targetId: string) => void
  clearRelation: () => void
  resetView: () => void
}

interface GalaxyCanvasProps {
  books: Book[]
  regions?: MapRegion[]
  trails?: string[][]
  focusRegionId?: string
  bookOpen?: boolean
  introOpen?: boolean
  emphasisIds: string[]
  keyboardEnabled: boolean
  reducedMotion: boolean
  onHover: (book: Book | null, position?: { x: number; y: number }) => void
  onSelect: (book: Book, source?: 'pointer' | 'keyboard') => void
  onRelationClick?: (sourceId: string, targetId: string) => void
  onReady: () => void
  onError: (message: string) => void
}

export const GalaxyCanvas = forwardRef<GalaxyCanvasHandle, GalaxyCanvasProps>(function GalaxyCanvas(
  { books, regions, trails, focusRegionId, bookOpen = false, introOpen = false, emphasisIds, keyboardEnabled, reducedMotion, onHover, onSelect, onRelationClick, onReady, onError },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const keyboardStatusRef = useRef<HTMLSpanElement>(null)
  const engineRef = useRef<GalaxyEngine | null>(null)
  const callbacksRef = useRef({ onHover, onSelect, onRelationClick, onReady, onError })
  callbacksRef.current = { onHover, onSelect, onRelationClick, onReady, onError }
  // Latest props for an engine that finishes loading after they changed.
  const reducedMotionRef = useRef(reducedMotion)
  reducedMotionRef.current = reducedMotion
  const emphasisRef = useRef(emphasisIds)
  emphasisRef.current = emphasisIds
  const trailsRef = useRef(trails)
  trailsRef.current = trails
  const focusRef = useRef({ focusRegionId, bookOpen, introOpen })
  focusRef.current = { focusRegionId, bookOpen, introOpen }

  useEffect(() => {
    const container = containerRef.current
    if (!container || books.length === 0 || !engineModule) return
    let cancelled = false
    let engine: GalaxyEngine | undefined
    engineModule.then(({ GalaxyEngine: Engine }) => {
      if (cancelled) return
      try {
        engine = new Engine(
          container,
          books,
          {
            onHover: (...args) => callbacksRef.current.onHover(...args),
            onSelect: (...args) => callbacksRef.current.onSelect(...args),
            onRelationClick: (...args) => callbacksRef.current.onRelationClick?.(...args),
            onReady: () => callbacksRef.current.onReady(),
            onError: (...args) => callbacksRef.current.onError(...args),
          },
          reducedMotionRef.current,
          { regions },
        )
        engineRef.current = engine
        engine.setEmphasis(emphasisRef.current)
        engine.setTrails(trailsRef.current ?? [])
        engine.setRegionFocus(focusRef.current.focusRegionId, focusRef.current.bookOpen, focusRef.current.introOpen)
      } catch (error) {
        callbacksRef.current.onError(error instanceof Error ? error.message : '星海初始化失败')
      }
    }, () => callbacksRef.current.onError('星海模块载入失败'))
    return () => {
      cancelled = true
      engine?.dispose()
      engineRef.current = null
    }
  }, [books, regions])

  useEffect(() => {
    engineRef.current?.setTrails(trails ?? [])
  }, [trails, books, regions])

  useEffect(() => {
    engineRef.current?.setRegionFocus(focusRegionId, bookOpen, introOpen)
  }, [focusRegionId, bookOpen, introOpen, books, regions])

  useEffect(() => {
    engineRef.current?.setEmphasis(emphasisIds)
  }, [emphasisIds])

  useEffect(() => {
    engineRef.current?.setReducedMotion(reducedMotion)
  }, [reducedMotion])

  useImperativeHandle(ref, () => ({
    focusBook: async (id, duration, options) => engineRef.current?.focusBook(id, duration, options),
    focusStage: () => containerRef.current?.focus({ preventScroll: true }),
    revealRelation: (sourceId, targetId) => engineRef.current?.revealRelation(sourceId, targetId),
    clearRelation: () => engineRef.current?.clearRelation(),
    resetView: () => engineRef.current?.resetView(),
  }))

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!keyboardEnabled) return
    const target = event.target
    if (target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || (target instanceof HTMLElement && target.isContentEditable)) return

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const book = engineRef.current?.moveKeyboardSelection(event.key.slice(5).toLowerCase() as 'up' | 'down' | 'left' | 'right')
      if (book && keyboardStatusRef.current) {
        keyboardStatusRef.current.textContent = `已选中《${book.title}》，按 Enter 观测。`
      }
      const hover = engineRef.current?.getKeyboardSelectionHover()
      callbacksRef.current.onHover(hover?.book ?? null, hover?.position)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      const book = engineRef.current?.getKeyboardSelection()
      if (book) callbacksRef.current.onSelect(book, 'keyboard')
      else if (keyboardStatusRef.current) keyboardStatusRef.current.textContent = '请先用方向键选择一颗书星。'
    }
  }

  return (
    <div
      className="galaxy-stage"
      ref={containerRef}
      role="group"
      tabIndex={keyboardEnabled ? 0 : -1}
      aria-hidden={keyboardEnabled ? undefined : true}
      aria-label={`书架星系，${books.length}颗书星。聚焦后使用方向键选择书星，按 Enter 观测。`}
      aria-describedby="galaxy-keyboard-hint"
      onKeyDown={handleKeyDown}
    >
      <span
        id="galaxy-keyboard-hint"
        style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}
      >
        使用方向键在星海中选择书星，按 Enter 观测；拖动画面只会改变视角，不会误选书籍。
      </span>
      <span
        ref={keyboardStatusRef}
        aria-live="polite"
        style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}
      />
    </div>
  )
})
