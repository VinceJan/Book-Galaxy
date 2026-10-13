import { describe, expect, it } from 'vitest'
import { labelLevelFor, layoutRegionLabels, type LabelCandidate } from './regionLabelLayout'

const candidate = (id: string, x: number, y: number, size: number, focused = false): LabelCandidate => ({ id, x, y, width: 120, height: 30, inFront: true, size, focused })
const desktop = { width: 1440, height: 900 }

describe('region label levels', () => {
  it('maps camera distance to zoom levels', () => {
    expect(labelLevelFor(200, undefined)).toBe(0)
    expect(labelLevelFor(130, undefined)).toBe(1)
    expect(labelLevelFor(80, undefined)).toBe(2)
    expect(labelLevelFor(40, undefined)).toBe(3)
  })
  it('applies hysteresis around boundaries', () => {
    expect(labelLevelFor(155, 0)).toBe(0)
    expect(labelLevelFor(145, 0)).toBe(1)
    expect(labelLevelFor(165, 1)).toBe(1)
    expect(labelLevelFor(175, 1)).toBe(0)
  })
})

describe('region label layout', () => {
  it('never shows two overlapping labels and keeps the larger region', () => {
    const [small, big] = layoutRegionLabels([candidate('small', 400, 400, 10), candidate('big', 420, 405, 100)], desktop, 0)
    expect(small.visible).toBe(false)
    expect(big.visible).toBe(true)
  })
  it('prefers the focused region over a larger one', () => {
    const [focused, big] = layoutRegionLabels([candidate('f', 400, 400, 5, true), candidate('b', 410, 400, 100)], desktop, 1)
    expect(focused.visible).toBe(true)
    expect(big.visible).toBe(false)
  })
  it('hides labels that are partly off screen or under chrome', () => {
    const [edge, chrome] = layoutRegionLabels([candidate('e', 20, 400, 50), candidate('c', 700, 30, 50)], { ...desktop, reserved: [{ left: 0, top: 0, right: 1440, bottom: 70 }] }, 0)
    expect(edge.visible).toBe(false)
    expect(chrome.visible).toBe(false)
  })
  it('caps the count per level and device', () => {
    const many = Array.from({ length: 12 }, (_, index) => candidate(`r${index}`, 100 + (index % 4) * 300, 150 + Math.floor(index / 4) * 250, 100 - index))
    expect(layoutRegionLabels(many, desktop, 0).filter((item) => item.visible)).toHaveLength(6)
    expect(layoutRegionLabels(many, desktop, 1).filter((item) => item.showSubtitle)).toHaveLength(8)
    expect(layoutRegionLabels(many, { width: 390, height: 844 }, 0).filter((item) => item.visible).length).toBeLessThanOrEqual(4)
  })
  it('keeps up to three names when close, focused first', () => {
    const placements = layoutRegionLabels([candidate('a', 400, 400, 50, true), candidate('b', 900, 400, 90), candidate('c', 700, 700, 80), candidate('d', 1100, 200, 70)], desktop, 3)
    expect(placements.map((item) => item.visible)).toEqual([true, true, true, false])
    expect(placements[0].opacity).toBeGreaterThan(placements[1].opacity)
  })
  it('relaxes spacing rather than showing fewer than three names', () => {
    const tight = [candidate('a', 400, 400, 90), candidate('b', 400, 436, 80), candidate('c', 400, 472, 70)]
    expect(layoutRegionLabels(tight, desktop, 0).filter((item) => item.visible)).toHaveLength(3)
  })
})
