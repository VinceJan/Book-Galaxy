/**
 * Zoom-level and anti-overlap rules for star-sea region labels.
 *
 * Pure functions so they can be tested without WebGL.  The rules follow
 * docs/region-naming.md:
 *   L0 overview  (d >= 160): primary names only        desktop 6 / phone 4
 *   L1 mid       (100..160): names + subtitle line      desktop 8 / phone 5
 *   L2 near      (72..100):  names dimmed to 30 %       in view only
 *   L3 close     (< 72, or a book is open): only the focused region, dimmed
 * Level switches use ±8 % hysteresis so a small camera move never flickers.
 */

export type LabelLevel = 0 | 1 | 2 | 3

const THRESHOLDS = [160, 100, 72] as const
const HYSTERESIS = 0.08

export function labelLevelFor(distance: number, previous: LabelLevel | undefined, bookOpen = false): LabelLevel {
  if (bookOpen) return 3
  const raw: LabelLevel = distance >= THRESHOLDS[0] ? 0 : distance >= THRESHOLDS[1] ? 1 : distance >= THRESHOLDS[2] ? 2 : 3
  if (previous === undefined || previous === raw || previous === 3) return raw
  // Only leave the previous level once the distance clears its boundary by
  // the hysteresis margin.
  const upper = previous === 0 ? Infinity : THRESHOLDS[previous - 1]
  const lower = THRESHOLDS[previous] ?? 0
  if (distance < upper * (1 + HYSTERESIS) && distance >= lower * (1 - HYSTERESIS)) return previous
  return raw
}

export interface LabelCandidate {
  id: string
  /** Screen-space centre in CSS pixels. */
  x: number
  y: number
  width: number
  height: number
  /** True when the anchor is in front of the camera. */
  inFront: boolean
  size: number
  focused: boolean
}

export interface LabelViewport {
  width: number
  height: number
  /** Areas covered by chrome (header, journey rail, sheets). */
  reserved?: Array<{ left: number; top: number; right: number; bottom: number }>
}

export interface LabelPlacement {
  id: string
  visible: boolean
  opacity: number
  showSubtitle: boolean
}

const GAP_X = 12
const GAP_Y = 10
const EDGE = 8

export function labelCap(level: LabelLevel, phone: boolean): number {
  if (level === 0) return phone ? 4 : 6
  if (level === 1) return phone ? 5 : 8
  if (level === 2) return phone ? 5 : 8
  return 1
}

export function layoutRegionLabels(candidates: readonly LabelCandidate[], viewport: LabelViewport, level: LabelLevel): LabelPlacement[] {
  const phone = viewport.width < 760
  const cap = labelCap(level, phone)
  const centreX = viewport.width / 2
  const centreY = viewport.height / 2
  // Stable priority: focused region, then size, then closeness to centre.
  const ordered = [...candidates].sort((left, right) => (
    Number(right.focused) - Number(left.focused)
    || right.size - left.size
    || Math.hypot(left.x - centreX, left.y - centreY) - Math.hypot(right.x - centreX, right.y - centreY)
    || left.id.localeCompare(right.id)
  ))
  const placed: Array<{ left: number; top: number; right: number; bottom: number }> = []
  const result = new Map<string, LabelPlacement>()
  for (const candidate of ordered) {
    const box = {
      left: candidate.x - candidate.width / 2,
      right: candidate.x + candidate.width / 2,
      top: candidate.y - candidate.height / 2,
      bottom: candidate.y + candidate.height / 2,
    }
    const whole = candidate.inFront
      && box.left >= EDGE && box.right <= viewport.width - EDGE
      && box.top >= EDGE && box.bottom <= viewport.height - EDGE
    const hitsChrome = (viewport.reserved ?? []).some((area) => !(box.right < area.left || box.left > area.right || box.bottom < area.top || box.top > area.bottom))
    const overlaps = placed.some((other) => !(box.right + GAP_X < other.left
      || box.left - GAP_X > other.right
      || box.bottom + GAP_Y < other.top
      || box.top - GAP_Y > other.bottom))
    const allowed = level === 3 ? candidate.focused : true
    const visible = allowed && whole && !hitsChrome && !overlaps && placed.length < cap
    if (visible) placed.push(box)
    const opacity = !visible ? 0 : level === 0 || level === 1 ? 0.78 : level === 2 ? (candidate.focused ? 0.6 : 0.3) : 0.34
    result.set(candidate.id, { id: candidate.id, visible, opacity, showSubtitle: visible && level === 1 })
  }
  return candidates.map((candidate) => result.get(candidate.id)!)
}
