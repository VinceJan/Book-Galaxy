import { expect, test } from '@playwright/test'

// Golden path: load → search → arrive → librarian → far drift.
test('golden path reaches a far star with no page errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('./')
  const start = page.locator('.intro button', { hasText: '开始偏航' }).first()
  await expect(start).toBeEnabled({ timeout: 60_000 })

  // Search
  await page.locator('.intro input').first().fill('三体')
  await expect(page.locator('.intro')).toContainText('《三体》')
  await start.click()

  // Arrive
  const panel = page.locator('.book-observatory')
  await expect(panel.locator('#observed-book-title')).toContainText('三体')
  await expect(panel.locator('.book-hook')).not.toBeEmpty()

  // Librarian: speaks without repeating the page hook
  await page.locator('button[data-overlay-trigger="librarian"]').first().click()
  const librarian = page.locator('.librarian-band')
  await expect(librarian).toBeVisible()
  const hook = (await panel.locator('.book-hook').textContent())?.trim() ?? ''
  expect(await librarian.innerText()).not.toContain(hook.slice(0, 24))
  await page.locator('.signal-close').click()
  await expect(librarian).toBeHidden()

  // Far drift: the destination stays unnamed until arrival
  await page.locator('button', { hasText: '从这里偏航' }).first().click()
  const far = page.locator('.detour-compass button', { hasText: '一颗未名远星' })
  await expect(far).toBeVisible()
  await far.click()
  await expect(page.locator('.journey-rail ol > li:not(.omitted)')).toHaveCount(2)
  await expect(panel.locator('#observed-book-title')).not.toContainText('三体')

  expect(errors).toEqual([])
})
