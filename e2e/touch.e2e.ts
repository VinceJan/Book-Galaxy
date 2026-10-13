import { expect, test, type Page } from '@playwright/test'
import { collectErrors, departFrom } from './helpers'

// Real touch input (CDP touch events) on the phone project only.
test.skip(({ hasTouch }) => !hasTouch, 'touch cases run on the phone project')

async function gesture(page: Page, frames: Array<Array<[number, number]>>) {
  const cdp = await page.context().newCDPSession(page)
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<[number, number]>) => cdp.send(
    'Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) },
  )
  await send('touchStart', frames[0])
  for (const frame of frames.slice(1)) {
    await send('touchMove', frame)
    await page.waitForTimeout(16)
  }
  await send('touchEnd', [])
  await cdp.detach()
}

const steps = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n)

async function canvasChanged(page: Page, act: () => Promise<void>): Promise<boolean> {
  const stage = page.locator('canvas').first()
  const before = await stage.screenshot()
  await act()
  await page.waitForTimeout(1_200)
  const after = await stage.screenshot()
  return !before.equals(after)
}

async function pageIsStill(page: Page) {
  const view = await page.evaluate(() => ({
    scale: window.visualViewport?.scale ?? 1,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  }))
  expect(view.scale).toBe(1)
  expect(view.scrollX).toBe(0)
  expect(view.scrollY).toBe(0)
  expect(view.overflow).toBeLessThanOrEqual(0)
}

test('drag and pinch move the star map, never the page', async ({ page }) => {
  const errors = collectErrors(page)
  await departFrom(page, '三体')
  const { width, height } = page.viewportSize()!

  // Fold the sheet away so the map has the screen.
  await page.locator('.book-observatory button[aria-label="收起书籍信息"]').first().tap()
  await expect(page.locator('.book-observatory')).toBeHidden()

  const cx = width / 2
  const cy = height / 2
  expect(await canvasChanged(page, () => gesture(page, steps(10).map((t) => [[width * (0.7 - 0.4 * t), cy]])))).toBe(true)
  await pageIsStill(page)
  expect(await canvasChanged(page, () => gesture(page, steps(10).map((t) => {
    const r = 40 + 110 * t
    return [[cx - r, cy], [cx + r, cy]]
  })))).toBe(true)
  await pageIsStill(page)

  // The current stop on the rail brings the sheet back.
  await page.locator('.journey-rail li[aria-current] button').first().tap()
  await expect(page.locator('.book-observatory #observed-book-title')).toContainText('三体')
  expect(errors).toEqual([])
})

test('book sheet scrolls by touch and the librarian fits the screen', async ({ page }) => {
  const errors = collectErrors(page)
  await departFrom(page, '三体')
  const sheet = page.locator('.book-observatory')
  const box = (await sheet.boundingBox())!
  const x = box.x + box.width / 2
  const before = await sheet.evaluate((element) => element.scrollTop)
  await gesture(page, steps(10).map((t) => [[x, box.y + box.height - 60 - (box.height - 180) * t]]))
  await expect.poll(() => sheet.evaluate((element) => element.scrollTop)).toBeGreaterThan(before)
  await pageIsStill(page)

  await page.locator('button[data-overlay-trigger="librarian"]').first().tap()
  const librarian = page.locator('.librarian-band')
  await expect(librarian).toBeVisible()
  // Polled: the band slides in, so it settles inside the screen a moment later.
  await expect.poll(() => librarian.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return rect.left >= 0 && rect.right <= window.innerWidth + 1 && rect.top >= 0 && rect.bottom <= window.innerHeight + 1
  })).toBe(true)
  await page.locator('.signal-close').tap()
  await expect(librarian).toBeHidden()
  expect(errors).toEqual([])
})
