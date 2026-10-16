import { expect, test } from '@playwright/test'

// The first frame is plain HTML + inline CSS: it must read as the intro even
// before (or without) any script, which is what slow networks see first.
test('static first frame shows the intro before scripts run', async ({ page }) => {
  await page.route('**/*.js', (route) => route.abort())
  await page.goto('./')
  const frame = page.locator('.boot-shell')
  await expect(frame.locator('h1')).toContainText('不只帮你找到书')
  await expect(frame.locator('h1')).toBeVisible()
  await expect(frame.locator('.intro-thesis')).toBeVisible()
  // Same no-counts rule as the app: no count slots or challenge tags in the boot frame.
  await expect(frame.locator('.intro-proof, .intro-challenges')).toHaveCount(0)
  await expect(frame).not.toContainText('书海暗线')
  // Dark night sky, never a white flash.
  const channels = await page.evaluate(() => getComputedStyle(document.body).backgroundColor.match(/\d+/g)!.slice(0, 3).map(Number))
  expect(Math.max(...channels)).toBeLessThan(16)
})
