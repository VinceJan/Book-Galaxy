import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { enableSoundscape, observeReducedMotion, publicFailureMessage, silenceSoundscape } from './App'

afterEach(() => vi.unstubAllGlobals())

describe('public failure messages', () => {
  it('keeps catalog failures concise and actionable without internal details', () => {
    const message = publicFailureMessage('catalog')

    expect(message).toBe('书海暂时无法显影，请刷新页面后重新观测。')
    expect(message).not.toMatch(/HTTP|JSON|fetch|catalog\.json|data\//iu)
  })

  it('keeps renderer failures concise and actionable without internal details', () => {
    const message = publicFailureMessage('renderer')

    expect(message).toBe('星海暂时失去显影，请刷新页面后重试。')
    expect(message).not.toMatch(/HTTP|JSON|fetch|catalog\.json|data\//iu)
  })

  it('silences ambient audio when returning to the galaxy entry', () => {
    const sound = { disable: vi.fn() }
    const setEnabled = vi.fn()

    silenceSoundscape(sound, setEnabled)

    expect(sound.disable).toHaveBeenCalledOnce()
    expect(setEnabled).toHaveBeenCalledWith(false)
  })

  it('does not claim sound is enabled when browser audio resume fails', async () => {
    const error = new Error('AudioContext resume rejected')
    const sound = { enable: vi.fn().mockRejectedValue(error), disable: vi.fn() }
    const setEnabled = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await enableSoundscape(sound, setEnabled)

    expect(sound.disable).toHaveBeenCalledOnce()
    expect(setEnabled).toHaveBeenLastCalledWith(false)
    expect(errorSpy).toHaveBeenCalledWith('Book Galaxy sound enable failure', error)
    errorSpy.mockRestore()
  })

  it('updates reduced-motion preference when the media query changes', () => {
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    const matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener,
      removeEventListener,
    }))
    vi.stubGlobal('window', { matchMedia })
    const setReducedMotion = vi.fn()

    const stopObserving = observeReducedMotion(setReducedMotion)
    const listener = addEventListener.mock.calls[0]?.[1] as ((event: MediaQueryListEvent) => void)
    listener({ matches: true } as MediaQueryListEvent)
    stopObserving()

    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    expect(setReducedMotion).toHaveBeenNthCalledWith(1, false)
    expect(setReducedMotion).toHaveBeenNthCalledWith(2, true)
    expect(removeEventListener).toHaveBeenCalledWith('change', listener)
  })

  it('keeps render-boundary failures fixed even when the thrown error is internal', () => {
    expect(AppErrorBoundary.getDerivedStateFromError(new Error('GET /data/catalog.json 500: invalid JSON'))).toEqual({
      message: '星海暂时失去显影，请刷新页面后重试。',
    })
  })
})
