import type { Book, BookRelation } from '../types'

export interface CuratorContext {
  question: string
  from?: Book
  to: Book
  relation?: BookRelation
  journey: Book[]
}

export function hasOnlineCurator(): boolean {
  const endpoint = import.meta.env.VITE_AI_ENDPOINT
  if (!endpoint) return false
  try {
    const url = new URL(endpoint)
    return url.protocol === 'https:'
      || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  } catch {
    return false
  }
}

export function publicRelationContext(relation: BookRelation | undefined) {
  if (!relation) return undefined
  const navigation = {
    provenance: relation.provenance,
    distanceBand: relation.distanceBand,
  }
  if (relation.provenance === 'reading-hypothesis') {
    return { ...navigation, kind: relation.kind, sentence: relation.sentence, basis: relation.basis }
  }
  return navigation
}

export async function askOnlineCurator(
  context: CuratorContext,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const endpoint = import.meta.env.VITE_AI_ENDPOINT
  if (!endpoint || !hasOnlineCurator()) return undefined

  const timeout = new AbortController()
  const timer = window.setTimeout(() => timeout.abort(), 8_000)
  const abort = () => timeout.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: context.question.slice(0, 240),
        from: context.from ? { title: context.from.title, author: context.from.author, themes: context.from.themes } : undefined,
        to: { title: context.to.title, author: context.to.author, themes: context.to.themes },
        relation: publicRelationContext(context.relation),
        journey: context.journey.slice(-5).map((book) => ({ title: book.title, author: book.author })),
      }),
      signal: timeout.signal,
    })
    if (!response.ok) return undefined
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (declaredLength > 20_000) return undefined
    const responseText = await response.text()
    if (responseText.length > 20_000) return undefined
    const payload = JSON.parse(responseText) as { answer?: unknown }
    return typeof payload.answer === 'string' ? payload.answer.slice(0, 900) : undefined
  } catch {
    return undefined
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
