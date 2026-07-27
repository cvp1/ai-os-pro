#!/usr/bin/env node
/**
 * audit:deps — zero runtime dependencies, enforced.
 *
 * The secrets broker is bash + python stdlib. This component holds the same line
 * in a language that makes it much easier not to: Sasha Desktop ships with an
 * EMPTY `dependencies` block. Everything it needs is Electron, Node's stdlib, and
 * code you can read in this repo.
 *
 * That is a supply-chain claim, so it gets a test rather than a sentence in the
 * README. Dev dependencies (typescript, electron, @types/node) are allowed — they
 * build the app, they don't ship inside it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const runtime = Object.keys(pkg.dependencies ?? {})
const ALLOWED_DEV = new Set(['typescript', 'electron', '@types/node', 'electron-builder'])
const unexpectedDev = Object.keys(pkg.devDependencies ?? {}).filter((d) => !ALLOWED_DEV.has(d))

const problems = []
if (runtime.length > 0) {
  problems.push(
    `runtime dependencies present: ${runtime.join(', ')}\n` +
      '      Sasha Desktop ships zero runtime deps by design — every added package is\n' +
      "      code the user can't audit running against their files. If one is truly\n" +
      '      needed, that is a decision record, not a package install.',
  )
}
if (unexpectedDev.length > 0) {
  problems.push(
    `unreviewed dev dependencies: ${unexpectedDev.join(', ')}\n` +
      '      Add it to ALLOWED_DEV here once it has been looked at deliberately.',
  )
}

if (problems.length > 0) {
  console.error('\n✗ audit:deps FAILED\n')
  for (const p of problems) console.error(`  - ${p}\n`)
  process.exit(1)
}

console.log(`✓ audit:deps — 0 runtime dependencies; ${Object.keys(pkg.devDependencies ?? {}).length} reviewed dev dependencies.`)
