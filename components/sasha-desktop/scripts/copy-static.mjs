#!/usr/bin/env node
/** Copy the renderer's static files (html/css) next to its compiled JS. */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = join(ROOT, 'src', 'renderer')
const OUT = join(ROOT, 'out', 'renderer')

mkdirSync(OUT, { recursive: true })
let n = 0
for (const entry of readdirSync(SRC)) {
  if (['.html', '.css'].includes(extname(entry))) {
    copyFileSync(join(SRC, entry), join(OUT, entry))
    n++
  }
}
console.log(`✓ copied ${n} static renderer file(s)`)
