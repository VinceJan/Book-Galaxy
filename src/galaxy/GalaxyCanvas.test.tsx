import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GalaxyCanvas } from './GalaxyCanvas'
import type { Book } from '../types'

const book: Book = { id: 'Q1', title: '测试作品', author: '测试作者', themes: ['文学'] }
const commonProps = {
  books: [book],
  emphasisIds: [],
  reducedMotion: true,
  onHover: () => undefined,
  onSelect: () => undefined,
  onReady: () => undefined,
  onError: () => undefined,
}

describe('GalaxyCanvas keyboard surface', () => {
  it('stays out of the tab order while the intro or an overlay owns focus', () => {
    const markup = renderToStaticMarkup(<GalaxyCanvas {...commonProps} keyboardEnabled={false} />)
    expect(markup).toContain('tabindex="-1"')
    expect(markup).toContain('aria-hidden="true"')
  })

  it('becomes the single keyboard surface only when exploration is clear', () => {
    const markup = renderToStaticMarkup(<GalaxyCanvas {...commonProps} keyboardEnabled />)
    expect(markup).toContain('tabindex="0"')
    expect(markup).not.toContain('aria-hidden="true"')
  })
})
