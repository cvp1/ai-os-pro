import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverSkills } from '../out/main/aios/skills.js'

/**
 * Skill discovery. The panel it feeds must never show a capability this machine
 * does not have, and must never hide one it does — so the tests are about what
 * gets found, what wins a collision, and what the app refuses to claim.
 */

function makeSkill(dir, name, body) {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), body)
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sasha-home-'))
  const root = mkdtempSync(join(tmpdir(), 'sasha-install-'))
  mkdirSync(join(root, 'skills'))
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
  return { home, root }
}

test('finds skills in the install and in the harness, and says which is which', () => {
  const { home, root } = fixture()
  makeSkill(join(root, 'skills'), 'weather', '---\nname: weather\ndescription: The forecast.\n---\n')
  makeSkill(join(home, '.claude', 'skills'), 'triage', '---\nname: triage\ndescription: Your inbox.\n---\n')

  const skills = discoverSkills(root, home)
  assert.deepEqual(
    skills.map((s) => [s.name, s.source]),
    [['triage', 'harness'], ['weather', 'install']],
  )
  assert.equal(skills.find((s) => s.name === 'weather').description, 'The forecast.')
})

test('a name collision resolves to the install copy, and appears once', () => {
  const { home, root } = fixture()
  makeSkill(join(root, 'skills'), 'brief', '---\nname: brief\ndescription: install version\n---\n')
  makeSkill(join(home, '.claude', 'skills'), 'brief', '---\nname: brief\ndescription: harness version\n---\n')

  const skills = discoverSkills(root, home)
  assert.equal(skills.length, 1)
  assert.equal(skills[0].source, 'install')
  assert.equal(skills[0].description, 'install version')
})

test('quoted frontmatter values are unwrapped', () => {
  const { home, root } = fixture()
  makeSkill(join(root, 'skills'), 'q', '---\nname: "q"\ndescription: \'Has: a colon\'\n---\n')
  const skill = discoverSkills(root, home)[0]
  assert.equal(skill.name, 'q')
  assert.equal(skill.description, 'Has: a colon')
})

test('a folder without SKILL.md is not a skill', () => {
  const { home, root } = fixture()
  mkdirSync(join(root, 'skills', 'not-a-skill'))
  writeFileSync(join(root, 'skills', 'not-a-skill', 'README.md'), 'hi')
  assert.deepEqual(discoverSkills(root, home), [])
})

test('no install and no harness dir is an empty list, not a crash', () => {
  const home = mkdtempSync(join(tmpdir(), 'sasha-empty-home-'))
  assert.deepEqual(discoverSkills(undefined, home), [])
  assert.deepEqual(discoverSkills('/nonexistent/install', home), [])
})

test('the folder name is used when frontmatter omits a name', () => {
  const { home, root } = fixture()
  makeSkill(join(root, 'skills'), 'garden', '---\ndescription: The beds.\n---\n')
  assert.equal(discoverSkills(root, home)[0].name, 'garden')
})

// ---------------------------------------------------------------------------
// The command line behind the button — the D2 shape made visible.
// ---------------------------------------------------------------------------

test('a dispatch command in the body is surfaced for display', () => {
  const { home, root } = fixture()
  makeSkill(
    join(root, 'skills'),
    'visualize',
    '---\nname: visualize\ndescription: Diagrams.\n---\n\nRun this:\n\n' +
      'python3 ~/Github/CC/cc-skills/workflow-visualizer/visualize.py --file plan.json\n',
  )
  const skill = discoverSkills(root, home)[0]
  assert.equal(skill.command, 'python3 ~/Github/CC/cc-skills/workflow-visualizer/visualize.py --file plan.json')
})

test('a skill with no command claims none', () => {
  const { home, root } = fixture()
  makeSkill(join(root, 'skills'), 'prose', '---\nname: prose\ndescription: Just instructions.\n---\n\nThink carefully.\n')
  assert.equal(discoverSkills(root, home)[0].command, undefined)
})

test('an absurdly long line is not shown as a command', () => {
  const { home, root } = fixture()
  makeSkill(join(root, 'skills'), 'long', `---\nname: long\n---\n\npython3 ${'x'.repeat(400)}\n`)
  assert.equal(discoverSkills(root, home)[0].command, undefined)
})
