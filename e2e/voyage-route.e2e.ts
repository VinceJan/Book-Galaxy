import { expect, test } from '@playwright/test'
import { collectErrors, departFrom, driftOnce } from './helpers'

test('copying a voyage route reconstitutes the rail and last book', async ({ page, context }) => {
  const errors = collectErrors(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await departFrom(page, '三体')
  await driftOnce(page, 2)
  await driftOnce(page, 3)

  const copy = page.locator('.journey-rail button', { hasText: '复制航迹' })
  await expect(copy).toBeVisible()
  await copy.click()
  await expect(page.locator('.journey-rail button', { hasText: '航迹已抄进剪贴板' })).toBeVisible()

  const shared = await page.evaluate(() => navigator.clipboard.readText())
  expect(shared).toMatch(/[?&]route=Q\d+(?:,Q\d+)+/)

  await page.goto(shared)
  await expect(page.locator('.intro')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.locator('.journey-rail ol > li:not(.omitted)')).toHaveCount(3)
  await expect(page.locator('.book-observatory #observed-book-title')).toBeVisible({ timeout: 60_000 })
  // Shared view must not surface mechanical labels.
  await expect(page.locator('body')).not.toContainText('Share URL')
  await expect(page.locator('body')).not.toContainText('强度')
  expect(errors).toEqual([])
})

test('star chart offers an in-world share control', async ({ page, context }) => {
  const errors = collectErrors(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await departFrom(page, '三体')
  await driftOnce(page, 2)
  await driftOnce(page, 3)
  await page.locator('button[data-overlay-trigger="chart"]', { hasText: '留下这次迷路' }).click()
  const chart = page.locator('.star-chart-reveal')
  await expect(chart).toBeVisible()
  await chart.locator('button', { hasText: '分享这次迷路' }).click()
  await expect(chart.locator('button', { hasText: '航迹已抄进剪贴板' })).toBeVisible()
  const shared = await page.evaluate(() => navigator.clipboard.readText())
  expect(shared).toMatch(/route=Q\d+/)
  expect(errors).toEqual([])
})
