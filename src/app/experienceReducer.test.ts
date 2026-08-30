import { describe, expect, it } from 'vitest'
import type { BookRelation } from '../types'
import { experienceReducer, initialExperienceState } from './experienceReducer'

function relation(source: string, target: string, surprise = 0.72): BookRelation {
  return {
    source,
    target,
    kind: '镜像',
    sentence: `${source} 与 ${target} 在阅读中相遇`,
    basis: ['测试关系'],
    surprise,
    confidence: 0.9,
  }
}

describe('experienceReducer', () => {
  it('completes a journey and resets the experience', () => {
    const firstRelation = relation('origin', 'destination')
    const started = experienceReducer(initialExperienceState, {
      type: 'START',
      bookId: 'origin',
    })
    expect(started.status).toBe('exploring')
    expect(started.selectedId).toBe('origin')
    expect(started.journeyIds).toEqual(['origin'])

    const travelling = experienceReducer(started, { type: 'TRAVEL', relation: firstRelation })
    expect(travelling.status).toBe('travelling')
    expect(travelling.pendingRelation).toEqual(firstRelation)
    expect(travelling.travelSequence).toBe(1)

    const arrived = experienceReducer(travelling, {
      type: 'ARRIVE',
      bookId: 'destination',
      relation: firstRelation,
      sequence: travelling.travelSequence,
    })
    expect(arrived.status).toBe('exploring')
    expect(arrived.selectedId).toBe('destination')
    expect(arrived.journeyIds).toEqual(['origin', 'destination'])
    expect(arrived.journeyRelations).toEqual([firstRelation])
    expect(arrived.pendingRelation).toBeUndefined()

    const chart = experienceReducer(arrived, {
      type: 'SHOW_CHART',
      dataUrl: 'data:image/png;base64,chart',
    })
    expect(chart.status).toBe('chart')
    expect(chart.chartDataUrl).toBe('data:image/png;base64,chart')

    const closedChart = experienceReducer(chart, { type: 'CLOSE_CHART' })
    expect(closedChart.status).toBe('exploring')
    expect(closedChart.chartDataUrl).toBeUndefined()
    expect(closedChart.journeyIds).toEqual(['origin', 'destination'])

    expect(experienceReducer(closedChart, { type: 'RESET' })).toEqual(initialExperienceState)
  })

  it('ignores ARRIVE and CANCEL_TRAVEL from an expired travel sequence', () => {
    const firstRelation = relation('origin', 'destination')
    const started = experienceReducer(initialExperienceState, { type: 'START', bookId: 'origin' })
    const travelling = experienceReducer(started, { type: 'TRAVEL', relation: firstRelation })
    const staleSequence = travelling.travelSequence - 1

    expect(
      experienceReducer(travelling, {
        type: 'ARRIVE',
        bookId: 'destination',
        relation: firstRelation,
        sequence: staleSequence,
      }),
    ).toEqual(travelling)
    expect(
      experienceReducer(travelling, { type: 'CANCEL_TRAVEL', sequence: staleSequence }),
    ).toEqual(travelling)
  })

  it('does not allow selecting another book while travelling', () => {
    const travelling = experienceReducer(
      experienceReducer(initialExperienceState, { type: 'START', bookId: 'origin' }),
      { type: 'TRAVEL', relation: relation('origin', 'destination') },
    )

    expect(experienceReducer(travelling, { type: 'SELECT', bookId: 'other-book' })).toEqual(
      travelling,
    )
  })
})
