import { forwardRef, useEffect, useImperativeHandle, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Book } from '../types'
import { GalaxyEngine } from './GalaxyEngine'

export interface GalaxyCanvasHandle {
  focusBook: (id: string, duration?: number) => Promise<boolean | undefined>
  focusStage: () => void
  revealRelation: (sourceId: string, targetId: string) => void
  clearRelation: () => void
  resetView: () => void
}

interface GalaxyCanvasProps {
  books: Book[]
  emphasisIds: string[]
  keyboardEnabled: boolean
  reducedMotion: boolean
  onHover: (book: Book | null, position?: { x: number; y: number }) => void
  onSelect: (book: Book, source?: 'pointer' | 'keyboard') => void
  onReady: () => void
  onError: (message: string) => void
}

export const GalaxyCanvas = forwardRef<GalaxyCanvasHandle, GalaxyCanvasProps>(function GalaxyCanvas(
  { books, emphasisIds, keyboardEnabled, reducedMotion, onHover, onSelect, onReady, onError },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const keyboardStatusRef = useRef<HTMLSpanElement>(null)
  const engineRef = useRef<GalaxyEngine | null>(null)
  const callbacksRef = useRef({ onHover, onSelect, onReady, onError })
  callbacksRef.current = { onHover, onSelect, onReady, onError }

  useEffect(() => {
    if (!containerRef.current || books.length === 0) return
    try {
      const engine = new GalaxyEngine(
        containerRef.current,
        books,
        {
          onHover: (...args) => callbacksRef.current.onHover(...args),
          onSelect: (...args) => callbacksRef.current.onSelect(...args),
          onReady: () => callbacksRef.current.onReady(),
          onError: (...args) => callbacksRef.current.onError(...args),
        },
        reducedMotion,
      )
      engineRef.current = engine
      return () => {
        engine.dispose()
        engineRef.current = null
      }
    } catch (error) {
      callbacksRef.current.onError(error instanceof Error ? error.message : '星海初始化失败')
    }
  }, [books])

  useEffect(() => {
    engineRef.current?.setEmphasis(emphasisIds)
  }, [emphasisIds])

  useEffect(() => {
    engineRef.current?.setReducedMotion(reducedMotion)
  }, [reducedMotion])

  useImperativeHandle(ref, () => ({
    focusBook: async (id, duration) => engineRef.current?.focusBook(id, duration),
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
