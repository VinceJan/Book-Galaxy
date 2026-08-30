import type { BookRelation } from '../types'

export type ExperienceStatus = 'intro' | 'exploring' | 'travelling' | 'chart'

export interface ExperienceState {
  status: ExperienceStatus
  selectedId?: string
  journeyIds: string[]
  journeyRelations: BookRelation[]
  directionsOpen: boolean
  librarianOpen: boolean
  chartDataUrl?: string
  error?: string
  travelSequence: number
  pendingRelation?: BookRelation
}

export type ExperienceAction =
  | { type: 'START'; bookId: string }
  | { type: 'SELECT'; bookId: string }
  | { type: 'CLEAR_SELECTION' }
  | { type: 'OPEN_DIRECTIONS' }
  | { type: 'CLOSE_DIRECTIONS' }
  | { type: 'TRAVEL'; relation: BookRelation }
  | { type: 'CANCEL_TRAVEL'; sequence: number }
  | { type: 'ARRIVE'; bookId: string; relation: BookRelation; sequence: number }
  | { type: 'TOGGLE_LIBRARIAN'; open?: boolean }
  | { type: 'SHOW_CHART'; dataUrl: string }
  | { type: 'CLOSE_CHART' }
  | { type: 'RESET' }
  | { type: 'ERROR'; message?: string }

export const initialExperienceState: ExperienceState = {
  status: 'intro',
  journeyIds: [],
  journeyRelations: [],
  directionsOpen: false,
  librarianOpen: false,
  travelSequence: 0,
}

export function experienceReducer(
  state: ExperienceState,
  action: ExperienceAction,
): ExperienceState {
  switch (action.type) {
    case 'START':
      return {
        ...initialExperienceState,
        status: 'exploring',
        selectedId: action.bookId,
        journeyIds: [action.bookId],
      }
    case 'SELECT':
      return state.status === 'travelling'
        ? state
        : { ...state, selectedId: action.bookId, directionsOpen: false, librarianOpen: false }
    case 'CLEAR_SELECTION':
      return state.status === 'travelling'
        ? state
        : { ...state, selectedId: undefined, directionsOpen: false, librarianOpen: false }
    case 'OPEN_DIRECTIONS':
      return { ...state, directionsOpen: true, librarianOpen: false }
    case 'CLOSE_DIRECTIONS':
      return { ...state, directionsOpen: false }
    case 'TRAVEL': {
      const selectedIndex = state.selectedId ? state.journeyIds.lastIndexOf(state.selectedId) : -1
      const branchJourneyIds = selectedIndex >= 0
        ? state.journeyIds.slice(0, selectedIndex + 1)
        : state.selectedId
          ? [state.selectedId]
          : []
      const branchRelationCount = Math.max(0, branchJourneyIds.length - 1)
      return {
        ...state,
        status: 'travelling',
        directionsOpen: false,
        librarianOpen: false,
        travelSequence: state.travelSequence + 1,
        pendingRelation: action.relation,
        journeyIds: branchJourneyIds,
        journeyRelations: state.journeyRelations.slice(0, branchRelationCount),
      }
    }
    case 'ARRIVE':
      if (action.sequence !== state.travelSequence) return state
      return {
        ...state,
        status: 'exploring',
        selectedId: action.bookId,
        journeyIds: [...state.journeyIds, action.bookId],
        journeyRelations: [...state.journeyRelations, action.relation],
        pendingRelation: undefined,
      }
    case 'CANCEL_TRAVEL':
      if (action.sequence !== state.travelSequence) return state
      return { ...state, status: 'exploring', pendingRelation: undefined }
    case 'TOGGLE_LIBRARIAN':
      return {
        ...state,
        librarianOpen: action.open ?? !state.librarianOpen,
        directionsOpen: false,
      }
    case 'SHOW_CHART':
      return { ...state, status: 'chart', chartDataUrl: action.dataUrl, librarianOpen: false }
    case 'CLOSE_CHART':
      return { ...state, status: 'exploring', chartDataUrl: undefined }
    case 'RESET':
      return initialExperienceState
    case 'ERROR':
      return { ...state, error: action.message }
  }
}
