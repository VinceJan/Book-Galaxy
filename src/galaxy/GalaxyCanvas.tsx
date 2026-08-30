import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { Book } from '../types'
import { GalaxyEngine } from './GalaxyEngine'

export interface GalaxyCanvasHandle {
  focusBook: (id: string, duration?: number) => Promise<boolean | undefined>
  revealRelation: (sourceId: string, targetId: string) => void
  clearRelation: () => void
  resetView: () => void
}

interface GalaxyCanvasProps {
  books: Book[]
  emphasisIds: string[]
  reducedMotion: boolean
  onHover: (book: Book | null, position?: { x: number; y: number }) => void
  onSelect: (book: Book) => void
  onReady: () => void
  onError: (message: string) => void
}

export const GalaxyCanvas = forwardRef<GalaxyCanvasHandle, GalaxyCanvasProps>(function GalaxyCanvas(
  { books, emphasisIds, reducedMotion, onHover, onSelect, onReady, onError },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
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
    revealRelation: (sourceId, targetId) => engineRef.current?.revealRelation(sourceId, targetId),
    clearRelation: () => engineRef.current?.clearRelation(),
    resetView: () => engineRef.current?.resetView(),
  }))

  return <div className="galaxy-stage" ref={containerRef} aria-hidden="true" />
})
