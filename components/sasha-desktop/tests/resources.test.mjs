import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Shipped assets exist and are real.
 *
 * Regression: `resources/` was created empty and the tray fell back to an empty
 * image. On Linux that is merely ugly; on macOS an empty tray image renders an
 * INVISIBLE menu-bar item — and since the app lives in the tray, the first Mac run
 * would have looked like the app simply failed to start. Nothing caught it because a
 * missing file took a silent fallback path.
 *
 * A referenced asset is part of the build. It gets a test.
 */

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** PNG magic number — proves the file is an image, not an empty or truncated stub. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const REQUIRED = [
  { file: 'resources/trayTemplate.png', why: 'the menu-bar icon' },
  { file: 'resources/trayTemplate@2x.png', why: 'the retina menu-bar icon' },
]

for (const asset of REQUIRED) {
  test(`${asset.file} exists and is a real PNG (${asset.why})`, () => {
    const path = join(ROOT, asset.file)
    assert.ok(existsSync(path), `${asset.file} is referenced by the app but not present`)

    const bytes = readFileSync(path)
    assert.ok(bytes.length > 0, `${asset.file} is empty`)
    assert.deepEqual(
      bytes.subarray(0, 8),
      PNG_MAGIC,
      `${asset.file} is not a PNG — the tray would fall back to an invisible icon`,
    )
    assert.ok(statSync(path).size > 100, `${asset.file} is suspiciously small`)
  })
}

test('every resource path referenced in main is one we actually ship', () => {
  // Catches the inverse failure: code pointing at an asset nobody added.
  const source = readFileSync(join(ROOT, 'src', 'main', 'index.ts'), 'utf8')
  const referenced = [...source.matchAll(/resources\/([A-Za-z0-9@._-]+)/g)].map((m) => m[1])

  assert.ok(referenced.length > 0, 'expected main to reference at least the tray icon')

  for (const name of new Set(referenced)) {
    assert.ok(
      existsSync(join(ROOT, 'resources', name)),
      `src/main/index.ts references resources/${name}, which does not exist`,
    )
  }
})
