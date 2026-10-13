import { useRef } from 'react'
import type { Book, BookRelation } from '../types'
import { useModalFocusTrap } from './ExperienceUI'

export function RelationPanel({ relation, from, to, onClose }: {
  relation: BookRelation; from?: Book; to?: Book; onClose: () => void
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const { dialogRef, handleKeyDown } = useModalFocusTrap(headingRef, onClose, '[data-testid="relation-item"]')
  return (
    <section className="librarian-band" ref={dialogRef} role="dialog" aria-modal="true"
      aria-label="关系详情" data-testid="relation-panel" onKeyDown={handleKeyDown}>
      <button className="signal-close" type="button" onClick={onClose} aria-label="关闭关系详情">×</button>
      <div className="signal-meta">一条书线</div>
      <h2 ref={headingRef} tabIndex={-1}>《{from?.title}》 · 《{to?.title}》</h2>
      <p>{relation.sentence}</p>
    </section>
  )
}
