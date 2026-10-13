/**
 * Deterministic map regions for the star sea.
 *
 * k-means (k = 12) over the offline semantic layout, seeded with a fixed
 * farthest-point initialisation so the same catalog always yields the same
 * regions.  Each region is keyed by its medoid book id, which is what the
 * hand-named table in data/regions/names.json refers to.
 */
const GENERIC = new Set(['文本叙事', '作品语境', '20世纪作品', '21世纪作品', '19世纪作品', '18世纪作品', '17世纪作品'])
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

export function buildRegions(books, k = 12, iterations = 60) {
  const sorted = [...books].filter((book) => book.position?.length === 3).sort((a, b) => a.id.localeCompare(b.id))
  const points = sorted.map((book) => book.position)
  const mean = [0, 1, 2].map((axis) => points.reduce((sum, point) => sum + point[axis], 0) / points.length)
  const centers = []
  // Farthest-point initialisation starting from the point nearest the mean.
  let first = 0
  points.forEach((point, index) => { if (dist2(point, mean) < dist2(points[first], mean)) first = index })
  centers.push([...points[first]])
  while (centers.length < k) {
    let best = 0
    let bestDistance = -1
    points.forEach((point, index) => {
      const nearest = Math.min(...centers.map((center) => dist2(point, center)))
      if (nearest > bestDistance) { bestDistance = nearest; best = index }
    })
    centers.push([...points[best]])
  }
  let assignment = new Array(points.length).fill(0)
  for (let step = 0; step < iterations; step += 1) {
    assignment = points.map((point) => {
      let best = 0
      centers.forEach((center, index) => { if (dist2(point, center) < dist2(point, centers[best])) best = index })
      return best
    })
    centers.forEach((center, index) => {
      const members = points.filter((_, pointIndex) => assignment[pointIndex] === index)
      if (members.length === 0) return
      for (let axis = 0; axis < 3; axis += 1) center[axis] = members.reduce((sum, point) => sum + point[axis], 0) / members.length
    })
  }
  return centers.map((center, index) => {
    const members = sorted.filter((_, pointIndex) => assignment[pointIndex] === index)
    const medoid = members.reduce((best, book) => (dist2(book.position, center) < dist2(best.position, center) ? book : best), members[0])
    const themes = new Map()
    members.forEach((book) => (book.themes ?? []).forEach((theme) => {
      if (!GENERIC.has(theme)) themes.set(theme, (themes.get(theme) ?? 0) + 1)
    }))
    return {
      key: medoid.id,
      size: members.length,
      density: members.reduce((sum, book) => sum + (book.localDensity ?? 0.5), 0) / members.length,
      topThemes: [...themes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5),
      bookIds: members.map((book) => book.id),
      examples: [...members].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || a.id.localeCompare(b.id)).slice(0, 10).map((book) => book.title),
    }
  }).filter((region) => region.size > 0).sort((a, b) => b.size - a.size || a.key.localeCompare(b.key))
}
