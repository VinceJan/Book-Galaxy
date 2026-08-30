import { describe, expect, it, vi } from 'vitest'
import { getIntroLoadingPhase, syncSoundscapeVisibility } from './soundscape'

describe('getIntroLoadingPhase', () => {
  it('reports catalog loading while catalog is loading', () => {
    expect(getIntroLoadingPhase('loading', false)).toBe('正在载入书目……')
    expect(getIntroLoadingPhase('loading', true)).toBe('正在载入书目……')
  })

  it('reports galaxy layout while catalog is ready but engine is not', () => {
    expect(getIntroLoadingPhase('ready', false)).toBe('正在编织星海……')
  })

  it('reports nothing when fully ready', () => {
    expect(getIntroLoadingPhase('ready', true)).toBeUndefined()
  })
})

describe('syncSoundscapeVisibility', () => {
  it('suspends while hidden and resumes only when enabled', () => {
    const sound = { suspend: vi.fn(), resumeIfEnabled: vi.fn() }
    syncSoundscapeVisibility(true, sound, true)
    expect(sound.suspend).toHaveBeenCalledOnce()
    expect(sound.resumeIfEnabled).not.toHaveBeenCalled()
  })

  it('resumes when becoming visible and enabled', () => {
    const sound = { suspend: vi.fn(), resumeIfEnabled: vi.fn() }
    syncSoundscapeVisibility(false, sound, true)
    expect(sound.resumeIfEnabled).toHaveBeenCalledOnce()
    expect(sound.suspend).not.toHaveBeenCalled()
  })

  it('does not resume when disabled', () => {
    const sound = { suspend: vi.fn(), resumeIfEnabled: vi.fn() }
    syncSoundscapeVisibility(false, sound, false)
    expect(sound.resumeIfEnabled).not.toHaveBeenCalled()
    expect(sound.suspend).not.toHaveBeenCalled()
  })

  it('handles missing sound gracefully', () => {
    expect(() => syncSoundscapeVisibility(true, undefined, true)).not.toThrow()
    expect(() => syncSoundscapeVisibility(false, undefined, false)).not.toThrow()
  })
})
