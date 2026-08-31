#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyApprovedCoversToSnapshot } from './lib/cover-policy.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_INPUT = resolve(ROOT, 'data/rich/books.json')
const DEFAULT_SIDECAR = resolve(ROOT, 'data/covers/approved-v1.json')

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const [key, inline] = arg.slice(2).split('=', 2)
    result[key] = inline ?? (argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true)
  }
  return result
}

async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, text, 'utf8')
  if (!existsSync(path)) return rename(temporary, path)
  const backup = `${path}.bak-${process.pid}`
  await rename(path, backup)
  try {
    await rename(temporary, path)
    await rm(backup, { force: true })
  } catch (error) {
    await rename(backup, path).catch(() => {})
    await rm(temporary, { force: true })
    throw error
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const input = resolve(ROOT, String(options.input || DEFAULT_INPUT))
  const output = resolve(ROOT, String(options.output || input))
  const sidecarPath = resolve(ROOT, String(options.sidecar || DEFAULT_SIDECAR))
  const [catalog, sidecar] = await Promise.all([
    readFile(input, 'utf8').then(JSON.parse),
    readFile(sidecarPath, 'utf8').then(JSON.parse),
  ])
  if (!Array.isArray(catalog.books)) throw new Error('input snapshot has no books array')
  const applied = applyApprovedCoversToSnapshot(catalog, sidecar)
  await writeAtomic(output, `${JSON.stringify(applied, null, 2)}\n`)
  console.log(JSON.stringify({
    ok: true,
    input: relative(ROOT, input),
    output: relative(ROOT, output),
    contentSha256: sidecar.contentSha256,
    exactEditions: sidecar.works.length,
    covers: applied.books.filter((book) => book.coverUrl).length,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
