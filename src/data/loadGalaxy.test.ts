import { describe, expect, it } from 'vitest'
import type { Book } from '../types'
import { makeRelationResolver, type GalaxyData } from './loadGalaxy'

const books: Book[] = ['root', 'author', 'theme', 'era', 'language'].map((id) => ({
  id,
  title: id,
  author: `${id}-author`,
  themes: [id],
}))

describe('catalog relation resolver', () => {
  it('turns metadata evidence into honest near, middle, and far surprise bands', () => {
    const data: GalaxyData = {
      books,
      curated: [],
      curatedRelations: [],
      relationCount: 4,
      source: 'test',
      catalogEdges: [
        { source: 'root', target: 'author', weight: 0.92, basis: ['作者:同一作者'] },
        { source: 'root', target: 'theme', weight: 0.88, basis: ['主题:共同主题'] },
        { source: 'root', target: 'era', weight: 0.62, basis: ['年代:1900'] },
        { source: 'root', target: 'language', weight: 0.3, basis: ['语言:en'] },
      ],
    }

    const options = makeRelationResolver(data).optionsFor('root', new Set(['root']))
    expect(options).toHaveLength(3)
    expect(options.map((relation) => relation.target)).toEqual(['author', 'era', 'language'])
    expect(options.map((relation) => relation.surprise)).toEqual([0.28, 0.7, 0.88])
  })
})
