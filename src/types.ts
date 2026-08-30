export type RelationKind = '回声' | '镜像' | '暗河' | '裂隙' | '余烬' | '潮汐'

export type BookPosition = readonly [number, number, number]

export interface BookInstanceType {
  id: string
  label: string
}

export interface BookEligibility {
  accepted: boolean
  reason: string
}

export type ThemeProvenance = 'wikidata-claim' | 'summary-rule' | 'contextual-metadata' | 'generic-last-resort'

/**
 * Shape values emitted by the semantic layout, plus names understood by the
 * renderer's legacy fallback mapper.  The numeric form remains supported on
 * Book because early snapshots stored the shader bucket directly.
 */
export type BookShape =
  | 'orb'
  | 'ring'
  | 'diamond'
  | 'petal'
  | 'seed'
  | 'cross'
  | 'flare'
  | 'soft'
  | 'double-halo'
  | 'eccentric'
  | 'core'
  | 'point'
  | 'spike'
  | 'cross-star'
  | 'double'
  | 'halo'
  | 'orbit'

export interface BookProvenance {
  workId?: string
  wikipediaPageId?: number | null
  wikipediaRevisionId?: number | null
  wikipediaRevisionUrl?: string | null
  wikipediaVariant?: string
  variantTitleSource?: string
  relationEvidence?: string
  summaryMethod?: string
}

export interface BookNeighbor {
  id: string
  semanticRank?: number
  similarity?: number
  surprise?: number
  navigable?: boolean
  basis?: string[]
}

export interface Book {
  id: string
  title: string
  /** Canonical page title when the source keeps a traditional-variant name. */
  wikipediaTitle?: string
  originalTitle?: string
  foreignTitle?: string
  aliases?: string[]
  author: string
  year?: number
  language?: string
  country?: string
  summary?: string
  themes: string[]
  /** Auditable origin for every user-visible theme label. */
  themeProvenance?: Record<string, ThemeProvenance>
  /** Exact source phrase or structured field that caused each theme match. */
  themeEvidence?: Record<string, string>
  /** Wikidata P31 evidence, ordered as returned by the rich-catalog build. */
  instanceOf?: BookInstanceType[]
  eligibility?: BookEligibility
  mood?: string[]
  coverUrl?: string
  coverSourceUrl?: string | null
  imageKind?: string
  sourceUrl?: string
  wikidataUrl?: string
  openLibraryId?: string
  source?: string
  downloads?: number
  popularity?: number
  contentLength?: number
  metadataCompleteness?: number
  provenance?: BookProvenance

  /** Precomputed semantic coordinates. Older catalogs may omit all visual fields. */
  position?: BookPosition
  localDensity?: number
  outlierScore?: number
  magnitude?: number
  halo?: number
  shape?: BookShape | number
  temperature?: number
  clusterWeights?: Record<string, number> | readonly number[]
  /** Semantic k-neighbours used for explainable detours. */
  neighbors?: BookNeighbor[]
  /** Spatial neighbours in the projected 3D field, independent of semantics. */
  spatialNeighbors?: string[]
  spatialSemanticOverlap?: number
}

export interface BookRelation {
  source: string
  target: string
  kind: RelationKind
  sentence: string
  basis: string[]
  surprise: number
  confidence: number
  similarity?: number
  weight?: number
  evidence?: Record<string, number | boolean | string | string[]>
  distanceBand?: 'near' | 'mid' | 'far' | 'distant'
  /** v2 snapshots use semantic; the other values remain for old curated data. */
  provenance?: 'catalog' | 'semantic' | 'reading-hypothesis'
}

export interface CatalogSnapshot {
  generatedAt: string
  source: string
  sourceUrl: string
  books: Book[]
  relations: Array<Pick<BookRelation, 'source' | 'target'> & { weight?: number; basis?: string[] }>
}

export interface DemoJourney {
  id: string
  title: string
  subtitle: string
  bookIds: string[]
  closingTitle: string
}
