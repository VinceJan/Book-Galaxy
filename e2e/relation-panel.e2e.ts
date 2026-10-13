import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const library = JSON.parse(readFileSync('public/data/relations.v2.json', 'utf8')) as {
  relations: Array<{ s: string; t: string; text: string; strength: number; type: string; wd?: string }>
}
const runtime = JSON.parse(readFileSync('public/data/catalog.runtime.json', 'utf8')) as {
  books: Array<{ id: string; title: string }>
}
import { collectErrors, departFrom } from './helpers'

test('a v2 relation opens accessible details with prose, strength and type', async ({ page }, testInfo) => {
  const errors = collectErrors(page)
  const title = runtime.books.find((book) => book.id === library.relations[0].s)!.title
  await departFrom(page, title)
  const item = page.getByTestId('relation-item').first()
  await expect(item).toBeVisible()
  const text = await item.locator('span').innerText()
  const record = library.relations.find((relation) => relation.text === text)!
  await item.click()
  const panel = page.getByTestId('relation-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toHaveAttribute('role', 'dialog')
  await expect(panel).toHaveAttribute('aria-label', '关系详情')
  await expect(panel).toContainText(record.text)
  await expect(panel).toContainText(`强度 ${record.strength}/5`)
  await expect(panel).toContainText(record.type)
  for (const id of [record.s, record.t]) {
    await expect(panel).toContainText(runtime.books.find((book) => book.id === id)!.title)
  }
  if ('wd' in record) await expect(panel).toContainText(record.wd!)
  await page.waitForTimeout(700)
  await page.screenshot({ scale: 'css', path: `/workspace/relation-panel-${testInfo.project.name === 'phone' ? 'mobile' : 'desktop'}.png` })
  await panel.getByRole('button', { name: '关闭关系详情' }).click()
  await expect(panel).not.toBeVisible()
  await item.click()
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible()
  expect(errors).toEqual([])
})
