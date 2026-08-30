export type RelationKind = '回声' | '镜像' | '暗河' | '裂隙' | '余烬' | '潮汐'

export type BookPosition = readonly [number, number, number]

export type BookShape = 'soft' | 'cross' | 'double-halo' | 'ring' | 'eccentric'

export interface Book {
  id: string
  title: string
  originalTitle?: string
  author: string
  year?: number
  language?: string
  summary?: string
  themes: string[]
  mood?: string[]
  coverUrl?: string
  sourceUrl?: string
  source?: string
  downloads?: number

  /** Precomputed semantic coordinates. Older catalogs may omit all visual fields. */
  position?: BookPosition
  localDensity?: number
  outlierScore?: number
  magnitude?: number
  halo?: number
  shape?: BookShape | number
  temperature?: number
  clusterWeights?: Record<string, number> | readonly number[]
}

export interface BookRelation {
  source: string
  target: string
  kind: RelationKind
  sentence: string
  basis: string[]
  surprise: number
  confidence: number
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
