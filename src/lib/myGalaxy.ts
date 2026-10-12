/**
 * 「我的星系」: the reader's trails, kept only on this device (localStorage).
 * Nothing leaves the browser.
 */
export interface StoredTrail {
  id: string
  startedAt: string
  updatedAt: string
  bookIds: string[]
}

export interface MyGalaxy {
  version: 1
  trails: StoredTrail[]
}

export const MY_GALAXY_KEY = 'book-galaxy:my-galaxy-v1'
const MAX_TRAILS = 24
const MAX_STOPS = 40

const empty = (): MyGalaxy => ({ version: 1, trails: [] })

export function parseMyGalaxy(raw: string | null | undefined, knownIds?: ReadonlySet<string>): MyGalaxy {
  if (!raw) return empty()
  try {
    const value = JSON.parse(raw) as Partial<MyGalaxy>
    if (value?.version !== 1 || !Array.isArray(value.trails)) return empty()
    const trails = value.trails
      .filter((trail): trail is StoredTrail => Boolean(trail && typeof trail.id === 'string' && Array.isArray(trail.bookIds)))
      .map((trail) => ({
        id: trail.id,
        startedAt: String(trail.startedAt ?? ''),
        updatedAt: String(trail.updatedAt ?? ''),
        bookIds: trail.bookIds.filter((id) => typeof id === 'string' && (!knownIds || knownIds.has(id))).slice(0, MAX_STOPS),
      }))
      .filter((trail) => trail.bookIds.length > 0)
      .slice(-MAX_TRAILS)
    return { version: 1, trails }
  } catch {
    return empty()
  }
}

export function upsertTrail(galaxy: MyGalaxy, trail: { id: string; bookIds: readonly string[] }, now = new Date()): MyGalaxy {
  const bookIds = trail.bookIds.slice(0, MAX_STOPS)
  if (bookIds.length < 2) return galaxy
  const existing = galaxy.trails.find((item) => item.id === trail.id)
  const stamp = now.toISOString()
  const next: StoredTrail = { id: trail.id, startedAt: existing?.startedAt ?? stamp, updatedAt: stamp, bookIds: [...bookIds] }
  const trails = [...galaxy.trails.filter((item) => item.id !== trail.id), next].slice(-MAX_TRAILS)
  return { version: 1, trails }
}

export function loadMyGalaxy(knownIds?: ReadonlySet<string>): MyGalaxy {
  try {
    return parseMyGalaxy(window.localStorage.getItem(MY_GALAXY_KEY), knownIds)
  } catch {
    return empty()
  }
}

export function saveMyGalaxy(galaxy: MyGalaxy): void {
  try {
    window.localStorage.setItem(MY_GALAXY_KEY, JSON.stringify(galaxy))
  } catch {
    // Storage full or disabled: the trail simply is not remembered.
  }
}

export function clearMyGalaxy(): MyGalaxy {
  try {
    window.localStorage.removeItem(MY_GALAXY_KEY)
  } catch {
    // ignore
  }
  return empty()
}

export function galaxyStats(galaxy: MyGalaxy): { trails: number; stars: number } {
  return { trails: galaxy.trails.length, stars: new Set(galaxy.trails.flatMap((trail) => trail.bookIds)).size }
}
