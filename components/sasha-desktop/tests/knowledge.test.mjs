import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readKnowledge, readDoc, confine } from '../out/main/aios/knowledge.js'

/**
 * The knowledge browser reads the user's own memory and me/ files.
 *
 * Two things are actually load-bearing here and get the attention: the path
 * confinement (an id from the renderer must never be able to read outside the
 * install) and the bounds (a workspace is a real directory and can contain anything).
 */

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sasha-knowledge-'))
  mkdirSync(join(root, 'me'))
  mkdirSync(join(root, 'memory'))
  writeFileSync(
    join(root, 'me', 'PROFILE.md'),
    '---\nname: profile\n---\n\n# Who I am\n\nCraig, 57, lives on a ranch.\n',
  )
  writeFileSync(join(root, 'memory', 'sleep.md'), 'Sleep is sacred: 9pm to 5am.\n')
  return root
}

test('reads both folders and describes each doc', () => {
  const root = fixture()
  const knowledge = readKnowledge(root)

  assert.equal(knowledge.me.length, 1)
  assert.equal(knowledge.memory.length, 1)
  assert.equal(knowledge.me[0].id, 'me/PROFILE.md')
  assert.equal(knowledge.me[0].folder, 'me')
  assert.ok(knowledge.me[0].bytes > 0)
  assert.ok(!Number.isNaN(Date.parse(knowledge.me[0].modified)))
  assert.equal(knowledge.problem, undefined)
})

test('the preview skips frontmatter and headings for the first real line', () => {
  const root = fixture()
  const knowledge = readKnowledge(root)
  // Not "---", not "name: profile", not "# Who I am" — the sentence.
  assert.equal(knowledge.me[0].preview, 'Craig, 57, lives on a ranch.')
})

test('a missing folder is said out loud, never rendered as "nothing here"', () => {
  const root = mkdtempSync(join(tmpdir(), 'sasha-knowledge-bare-'))
  const knowledge = readKnowledge(root)
  assert.deepEqual(knowledge.me, [])
  assert.deepEqual(knowledge.memory, [])
  assert.match(knowledge.problem ?? '', /me\/ or memory\//)
})

test('non-markdown and dotfiles are not listed', () => {
  const root = fixture()
  writeFileSync(join(root, 'me', '.hidden.md'), 'secret')
  writeFileSync(join(root, 'me', 'photo.png'), 'binary')
  const names = readKnowledge(root).me.map((doc) => doc.name)
  assert.deepEqual(names, ['PROFILE.md'])
})

// ---------------------------------------------------------------------------
// Path confinement — the load-bearing test in this file.
// ---------------------------------------------------------------------------

test('confine refuses anything that escapes the root', () => {
  const root = fixture()
  assert.equal(confine(root, '../../etc/passwd'), null)
  assert.equal(confine(root, '/etc/passwd'), null)
  assert.equal(confine(root, 'me/../../outside.md'), null)
  assert.equal(confine(root, ''), null)
  assert.equal(confine(root, 'me/PROFILE.md\0.txt'), null)
  assert.ok(confine(root, 'me/PROFILE.md'))
})

test('readDoc refuses ids outside the two folders even when the path is legal', () => {
  const root = fixture()
  writeFileSync(join(root, 'NOTES.md'), 'not part of the browser')
  // The file exists and is inside the root, but only me/ and memory/ are browsable.
  assert.equal(readDoc(root, 'NOTES.md'), null)
  assert.equal(readDoc(root, '../escape.md'), null)
  assert.match(readDoc(root, 'memory/sleep.md') ?? '', /Sleep is sacred/)
})

/**
 * The realistic version of the escape: not a hostile renderer, but a link inside a
 * folder the agent itself can write to. `me/` is a directory Sasha edits, so "a file
 * in me/" and "a file whose content is in me/" are different claims, and the panel
 * makes the second one. This is the test that keeps them the same.
 */
test('a symlink pointing outside the root is refused, not followed', (t) => {
  const root = fixture()
  const outside = mkdtempSync(join(tmpdir(), 'sasha-outside-'))
  writeFileSync(join(outside, 'secret.md'), 'SHOULD NOT BE READABLE')
  try {
    symlinkSync(join(outside, 'secret.md'), join(root, 'me', 'link.md'))
  } catch {
    t.skip('symlinks unavailable on this filesystem')
    return
  }
  assert.equal(confine(root, 'me/link.md'), null)
  assert.equal(readDoc(root, 'me/link.md'), null)
})

test('a symlink that stays inside the root still works', (t) => {
  const root = fixture()
  try {
    symlinkSync(join(root, 'memory', 'sleep.md'), join(root, 'me', 'sleep-link.md'))
  } catch {
    t.skip('symlinks unavailable on this filesystem')
    return
  }
  // Confinement is about where the bytes come from, not about banning links.
  assert.match(readDoc(root, 'me/sleep-link.md') ?? '', /Sleep is sacred/)
})

test('an oversized doc is truncated rather than loaded whole', () => {
  const root = fixture()
  writeFileSync(join(root, 'memory', 'huge.md'), 'x'.repeat(500_000))
  const text = readDoc(root, 'memory/huge.md')
  assert.ok(text)
  assert.ok(text.length < 500_000)
  assert.match(text, /truncated for display/)
})

test('the doc list is capped', () => {
  const root = mkdtempSync(join(tmpdir(), 'sasha-many-'))
  mkdirSync(join(root, 'memory'))
  for (let i = 0; i < 260; i += 1) {
    writeFileSync(join(root, 'memory', `note-${String(i).padStart(3, '0')}.md`), 'x')
  }
  assert.equal(readKnowledge(root).memory.length, 200)
})
