import { expect, test } from '@playwright/test'
import { collectErrors, departFrom, driftOnce } from './helpers'

// Three stops develop the private star chart; it can be saved and dismissed.
test('three stops develop a star chart that can be saved', async ({ page }) => {
  const errors = collectErrors(page)
  await departFrom(page, '三体')
  await driftOnce(page, 2)
  await driftOnce(page, 3)

  const imprint = page.locator('button[data-overlay-trigger="chart"]', { hasText: '留下这次迷路' })
  await expect(imprint).toBeEnabled()
  await imprint.click()

  const chart = page.locator('.star-chart-reveal')
  await expect(chart).toBeVisible()
  await expect(chart.locator('#chart-title')).toContainText('已经显影')
  const plate = chart.locator('.chart-plate img')
  await expect(plate).toHaveAttribute('src', /^data:image\/png/)
  expect(await plate.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(600)

  const download = page.waitForEvent('download')
  await chart.locator('button', { hasText: '保存高清星图' }).click()
  expect((await download).suggestedFilename()).toMatch(/\.png$/)

  await chart.locator('button', { hasText: '返回星海' }).click()
  await expect(chart).toBeHidden()
  await expect(page.locator('.journey-rail ol > li:not(.omitted)')).toHaveCount(3)
  expect(errors).toEqual([])
})
