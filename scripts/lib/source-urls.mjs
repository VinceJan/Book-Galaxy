/**
 * Closed-world validators for every external URL written into the book data.
 *
 * These checks are deliberately stricter than `new URL()` or an `https://`
 * prefix check: a URL is trusted only when its scheme, exact host, port,
 * userinfo, path and query shape match the source field that owns it.
 */

export const CC_BY_SA_4_URL = 'https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hans'
export const ATTRIBUTION_NOTICE = '中文维基百科导语按 CC BY-SA 4.0 许可使用；请保留原作者署名并以相同方式共享。'

const WIKIPEDIA_HOST = 'zh.wikipedia.org'
const WIKIDATA_HOSTS = new Set(['www.wikidata.org', 'wikidata.org'])
const WDQS_HOST = 'query.wikidata.org'
const OPEN_LIBRARY_HOST = 'openlibrary.org'
const OPEN_LIBRARY_COVERS_HOST = 'covers.openlibrary.org'

function parseHttps(value, hosts) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || (hosts && !hosts.has(url.hostname.toLowerCase()))) return null
  // URL.port is empty for the default https port (443), so this allows only
  // the default port while rejecting :80, :8443, and all other overrides.
  if (url.username || url.password || url.port || url.hostname !== url.hostname.toLowerCase()) return null
  return url
}

function wikipediaPageKeyFromUrl(url) {
  if (!url.pathname.startsWith('/wiki/') || url.pathname.length <= '/wiki/'.length) return null
  let title
  try {
    title = decodeURIComponent(url.pathname.slice('/wiki/'.length))
  } catch {
    return null
  }
  title = title.replace(/\/+$/u, '').replace(/\s+/gu, '_')
  if (!title || title === '.' || title === '..' || title.includes('\\')) return null
  return `${WIKIPEDIA_HOST}/wiki/${title}`
}

/** Return true only for a canonical Chinese Wikipedia article URL. */
export function isWikipediaSourceUrl(value) {
  const url = parseHttps(value, new Set([WIKIPEDIA_HOST]))
  return Boolean(url && !url.search && !url.hash && wikipediaPageKeyFromUrl(url))
}

/** Return the normalized page identity for a Wikipedia source/revision URL. */
export function wikipediaPageKey(value) {
  const url = parseHttps(value, new Set([WIKIPEDIA_HOST]))
  return url && wikipediaPageKeyFromUrl(url)
}

/** Return true only when revision is the same article and has numeric oldid. */
export function isWikipediaRevisionUrl(sourceUrl, revisionUrl) {
  const source = parseHttps(sourceUrl, new Set([WIKIPEDIA_HOST]))
  const revision = parseHttps(revisionUrl, new Set([WIKIPEDIA_HOST]))
  if (!source || !revision || source.search || source.hash || revision.hash) return false
  const query = [...revision.searchParams.entries()]
  if (query.length !== 1 || query[0][0] !== 'oldid' || !/^\d+$/u.test(query[0][1])) return false
  const sourceKey = wikipediaPageKeyFromUrl(source)
  const revisionKey = wikipediaPageKeyFromUrl(revision)
  return Boolean(sourceKey && revisionKey && sourceKey === revisionKey)
}

/** Return true only for the Wikidata item URL matching the expected Q-id. */
export function isWikidataUrl(value, expectedId = null) {
  const url = parseHttps(value, WIKIDATA_HOSTS)
  if (!url || url.search || url.hash) return false
  const match = /^\/wiki\/(Q\d+)$/u.exec(url.pathname)
  return Boolean(match && (!expectedId || match[1] === expectedId))
}

/** Return true only for a canonical Open Library work URL. */
export function isOpenLibraryWorkUrl(value, expectedId = null) {
  const url = parseHttps(value, new Set([OPEN_LIBRARY_HOST]))
  if (!url || url.search || url.hash) return false
  const match = /^\/works\/(OL\d+W)$/u.exec(url.pathname)
  return Boolean(match && (!expectedId || match[1] === expectedId))
}

/** Return true only for an Open Library Covers image URL used by this app. */
export function isOpenLibraryCoverUrl(value) {
  const url = parseHttps(value, new Set([OPEN_LIBRARY_COVERS_HOST]))
  return Boolean(url && !url.search && !url.hash && /^\/b\/id\/\d+-[SML]\.jpg$/u.test(url.pathname))
}

/** Canonical site/API endpoints used in manifest metadata. */
export function isTrustedEndpointUrl(value, kind) {
  const url = (() => {
    if (kind === 'wikipedia') return parseHttps(value, new Set([WIKIPEDIA_HOST]))
    if (kind === 'wikidata-api') return parseHttps(value, new Set(['www.wikidata.org']))
    if (kind === 'wdqs') return parseHttps(value, new Set([WDQS_HOST]))
    if (kind === 'openlibrary-api') return parseHttps(value, new Set([OPEN_LIBRARY_HOST]))
    return null
  })()
  if (!url || url.search || url.hash) return false
  if (kind === 'wikipedia') return url.pathname === '/' || url.pathname === '/w/api.php'
  if (kind === 'wikidata-api') return url.pathname === '/w/api.php'
  if (kind === 'wdqs') return url.pathname === '/sparql'
  if (kind === 'openlibrary-api') return url.pathname === '/search.json'
  return false
}

/** Small dependency-free self-test, including hostile URL shapes. */
export function runSourceUrlSelfTest() {
  const valid = [
    isWikipediaSourceUrl('https://zh.wikipedia.org/wiki/%E7%BA%A2%E6%A5%BC%E6%A2%A6'),
    isWikipediaRevisionUrl(
      'https://zh.wikipedia.org/wiki/%E7%BA%A2%E6%A5%BC%E6%A2%A6',
      'https://zh.wikipedia.org/wiki/%E7%BA%A2%E6%A5%BC%E6%A2%A6?oldid=123456',
    ),
    isWikidataUrl('https://www.wikidata.org/wiki/Q123', 'Q123'),
    isOpenLibraryWorkUrl('https://openlibrary.org/works/OL123W', 'OL123W'),
    isOpenLibraryCoverUrl('https://covers.openlibrary.org/b/id/123-M.jpg'),
  ]
  if (valid.some((value) => !value)) throw new Error('source URL self-test 失败：合法 URL 被拒绝')

  const invalid = [
    isWikipediaSourceUrl('https://zh.wikipedia.org.evil.example/wiki/Q123'),
    isWikipediaSourceUrl('https://user:pass@zh.wikipedia.org/wiki/Q123'),
    isWikipediaSourceUrl('https://zh.wikipedia.org:8443/wiki/Q123'),
    isWikipediaRevisionUrl('https://zh.wikipedia.org/wiki/Q123', 'https://zh.wikipedia.org/wiki/Q123?oldid=abc'),
    isWikipediaRevisionUrl('https://zh.wikipedia.org/wiki/Q123', 'https://zh.wikipedia.org/wiki/Other?oldid=123'),
    isWikipediaRevisionUrl('https://zh.wikipedia.org/wiki/Q123', 'https://zh.wikipedia.org/wiki/Q123?oldid=123&x=1'),
    isWikidataUrl('https://www.wikidata.org.evil.example/wiki/Q123', 'Q123'),
    isWikidataUrl('https://www.wikidata.org:8443/wiki/Q123', 'Q123'),
    isWikidataUrl('https://www.wikidata.org/wiki/Q124', 'Q123'),
    isOpenLibraryWorkUrl('https://openlibrary.org/works/OL123M', 'OL123M'),
    isOpenLibraryWorkUrl('https://user@openlibrary.org/works/OL123W', 'OL123W'),
    isOpenLibraryCoverUrl('https://covers.openlibrary.org.evil.example/b/id/123-M.jpg'),
    isOpenLibraryCoverUrl('https://covers.openlibrary.org:8443/b/id/123-M.jpg'),
    isOpenLibraryCoverUrl('https://covers.openlibrary.org/b/id/123-M.jpg?redirect=https://evil.example'),
  ]
  if (invalid.some((value) => value)) throw new Error('source URL self-test 失败：恶意 URL 被接受')
  return true
}

if (process.argv[1] && process.argv[1].endsWith('source-urls.mjs') && process.argv.includes('--self-test')) {
  runSourceUrlSelfTest()
  console.log(JSON.stringify({ ok: true, mode: 'source-url-self-test' }, null, 2))
}
