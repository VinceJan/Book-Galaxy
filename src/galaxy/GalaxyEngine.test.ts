import { describe, expect, it } from 'vitest'
import { isProjectedBookVisible } from './GalaxyEngine'

describe('keyboard star navigation viewport guard', () => {
  it('accepts a fully visible projected book point', () => {
    expect(isProjectedBookVisible({ x: 0, y: 0, z: 0 })).toBe(true)
  })

  it('rejects points outside depth or the label-safe viewport margin', () => {
    expect(isProjectedBookVisible({ x: 0.97, y: 0, z: 0 })).toBe(false)
    expect(isProjectedBookVisible({ x: 0, y: -0.97, z: 0 })).toBe(false)
    expect(isProjectedBookVisible({ x: 0, y: 0, z: 1 })).toBe(false)
    expect(isProjectedBookVisible({ x: 0, y: 0, z: -1 })).toBe(false)
  })
})
