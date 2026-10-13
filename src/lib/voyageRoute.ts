/**
 * Shareable roaming routes: encode a journey as ?route=id1,id2,id3 and restore it.
 * Book ids only — no mechanical metadata in the URL or the restored view.
 */

const ROUTE_PARAM = 'route'
const ID_PATTERN = /^Q\d+$/u

export function encodeVoyageRoute(bookIds: readonly string[]): string {
  const ids = bookIds.filter((id) => ID_PATTERN.test(id))
  return ids.join(',')
}

export function parseVoyageRoute(raw: string | null | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const part of raw.split(',')) {
    const id = part.trim()
    if (!ID_PATTERN.test(id) || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

export function readVoyageRouteFromSearch(search: string): string[] {
  try {
    const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
    return parseVoyageRoute(params.get(ROUTE_PARAM))
  } catch {
    return []
  }
}

export function buildVoyageShareUrl(
  bookIds: readonly string[],
  base: { origin: string; pathname: string } = typeof window !== 'undefined'
    ? window.location
    : { origin: '', pathname: '/' },
): string | undefined {
  const encoded = encodeVoyageRoute(bookIds)
  if (!encoded) return undefined
  const path = base.pathname || '/'
  // Keep commas literal so shared links stay readable (?route=Q1,Q2,Q3).
  return `${path}?${ROUTE_PARAM}=${encoded}`
}

export function absoluteVoyageShareUrl(bookIds: readonly string[]): string | undefined {
  if (typeof window === 'undefined') return buildVoyageShareUrl(bookIds)
  const relative = buildVoyageShareUrl(bookIds, window.location)
  if (!relative) return undefined
  return new URL(relative, window.location.origin).toString()
}

/** Keep only ids that exist in the catalog, in route order. */
export function resolveVoyageRoute(
  bookIds: readonly string[],
  knownIds: ReadonlySet<string>,
): string[] {
  return bookIds.filter((id) => knownIds.has(id))
}

export async function copyVoyageRoute(bookIds: readonly string[]): Promise<boolean> {
  const url = absoluteVoyageShareUrl(bookIds)
  if (!url) return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url)
      return true
    }
  } catch {
    // fall through to execCommand
  }
  try {
    const input = document.createElement('textarea')
    input.value = url
    input.setAttribute('readonly', '')
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    document.body.appendChild(input)
    input.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(input)
    return ok
  } catch {
    return false
  }
}

export { ROUTE_PARAM }
