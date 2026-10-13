import { expect, type Page } from '@playwright/test'

export function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

/** Load, search for a title and depart from it; resolves once the book page is open. */
export async function departFrom(page: Page, title: string): Promise<void> {
  await page.goto('./')
  const start = page.locator('.intro button', { hasText: '开始偏航' }).first()
  await expect(start).toBeEnabled({ timeout: 60_000 })
  await page.locator('.intro input').first().fill(title)
  await expect(page.locator('.intro')).toContainText(`《${title}》`)
  await start.click()
  await expect(page.locator('.book-observatory #observed-book-title')).toContainText(title)
}

/** Take the first offered heading and wait until the journey rail shows the new stop. */
export async function driftOnce(page: Page, nextStop: number): Promise<void> {
  await page.locator('button', { hasText: '从这里偏航' }).first().click()
  const option = page.locator('.detour-compass .direction-list button').first()
  await expect(option).toBeVisible()
  await option.click()
  // The rail counts "n/3" until the third stop, which reads "3 站 · 可留星图".
  await expect(page.locator('.journey-rail')).toContainText(nextStop < 3 ? `${nextStop}/3` : `${nextStop} 站`)
}
