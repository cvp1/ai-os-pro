import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { scan, collect } from '../out/main/doorbell/watcher.js'
import { readProposals } from '../out/main/doorbell/proposals.js'
import { recordUsage } from '../out/main/doorbell/usage.js'
import { loadState, saveState } from '../out/main/doorbell/state.js'

const NOW = new Date('2026-07-27T12:00:00Z')
const DAY = 86_400_000

/** Build a throwaway AI-OS workspace. Returns its root. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sasha-desk-test-'))
  return root
}

function stageProposal(root, domain, name, body) {
  const dir = join(root, domain, 'proposals')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), body, 'utf8')
  return join(dir, name)
}

function stageProjectProposal(root, slug, name, body) {
  const dir = join(root, 'projects', slug, 'proposals')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), body, 'utf8')
  return join(dir, name)
}

function writeHeartbeat(root, records) {
  writeFileSync(
    join(root, '.aios-heartbeat.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  )
}

const emptyState = () => ({ dismissed: {}, notified: {}, settings: {} })

// ---------------------------------------------------------------------------

test('an empty workspace rings nothing — silence is the normal case', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = scan(root, emptyState(), NOW)
  assert.deepEqual(result.items, [])
  assert.equal(result.bell, null)
})

test('a staged draft is found in both conventional locations', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  stageProposal(root, 'career', '2026-07-20-outreach.md', '# Outreach draft\n\nbody')
  stageProjectProposal(root, 'ranch-site', '2026-07-21-status.md', '# Weekly status\n\nbody')

  const items = readProposals(root)
  assert.equal(items.length, 2)
  const headlines = items.map((i) => i.headline)
  assert.ok(
    headlines.some((h) => h.includes('Weekly status') && h.includes('ranch-site')),
    'project proposals name their project slug',
  )
  assert.ok(
    headlines.some((h) => h.includes('Outreach draft') && h.includes('career')),
    'domain proposals name their domain',
  )
})

test('the headline comes from the draft, not the filename', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  stageProposal(root, 'career', '2026-07-20-x7f.md', '# Your conference talk pitch\n\nbody')
  const [item] = readProposals(root)
  assert.ok(item.headline.includes('Your conference talk pitch'))
})

test('AT MOST ONE item ever rings, even with many waiting', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  for (let i = 0; i < 5; i++) {
    stageProposal(root, 'career', `draft-${i}.md`, `# Draft ${i}\n`)
  }

  const result = scan(root, emptyState(), NOW)
  assert.equal(result.items.length, 5, 'the window shows everything waiting')
  assert.ok(result.bell, 'and exactly one of them rings')
  assert.equal(typeof result.bell.id, 'string')
})

test('broken outranks waiting — a dead job rings before a staged draft', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  stageProposal(root, 'career', 'draft.md', '# A draft\n')
  writeHeartbeat(root, [
    { ts: new Date(NOW.getTime() - 30 * DAY).toISOString(), job: 'projects-checkin', status: 'ok', every: '7d' },
  ])

  const result = scan(root, emptyState(), NOW)
  assert.equal(result.bell.kind, 'dead-job', 'something stopped working beats something waiting')
})

test('EDGE-TRIGGERED — an item already rung does not ring again', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  stageProposal(root, 'career', 'draft.md', '# A draft\n')

  const first = scan(root, emptyState(), NOW)
  assert.ok(first.bell, 'rings the first time')

  const after = { dismissed: {}, notified: { [first.bell.id]: NOW.toISOString() }, settings: {} }
  const second = scan(root, after, NOW)

  assert.equal(second.bell, null, 'polling again must not ring again')
  assert.equal(second.items.length, 1, 'but it is still waiting, and still shown')
})

test('NO QUEUE-DRAINING — three waiting items do not become three notifications', (t) => {
  // Regression: the single-scan "at most one" check passed while the app still rang
  // once per poll, walking the queue — three bells in ninety seconds. The bell says
  // "something needs you"; it must not repeat that until the user has dealt with it.
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  stageProposal(root, 'career', 'a.md', '# Draft A\n')
  stageProposal(root, 'career', 'b.md', '# Draft B\n')
  stageProposal(root, 'career', 'c.md', '# Draft C\n')

  const state = { dismissed: {}, notified: {}, settings: {} }

  const first = scan(root, state, NOW)
  assert.ok(first.bell, 'the first poll rings')
  state.notified[first.bell.id] = NOW.toISOString()

  // Simulate the poller running again and again while the user is away.
  for (let poll = 0; poll < 5; poll++) {
    const later = scan(root, state, NOW)
    assert.equal(later.bell, null, `poll ${poll + 2} must stay silent — one outstanding bell`)
    assert.equal(later.items.length, 3, 'all three are still shown in the window')
  }

  // The user deals with the one they were told about. Now the next may ring.
  state.dismissed[first.bell.id] = NOW.toISOString()
  const afterHandling = scan(root, state, NOW)
  assert.ok(afterHandling.bell, 'clearing the outstanding item unblocks the next bell')
  assert.notEqual(afterHandling.bell.id, first.bell.id)
})

test('headlines do not repeat the workspace name', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  stageProjectProposal(root, 'ranch-site', 'status.md', '# Weekly status for ranch-site\n')
  const [item] = readProposals(root)
  assert.equal(
    (item.headline.match(/ranch-site/g) ?? []).length,
    1,
    'a draft already naming its project must not get the name appended again',
  )
})

test('dead-job headlines do not repeat the job noun', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeHeartbeat(root, [
    { ts: new Date(NOW.getTime() - 30 * DAY).toISOString(), job: 'projects-checkin', every: '7d' },
  ])
  const [item] = collect(root, NOW)
  assert.ok(!/checkin check-in/i.test(item.headline), item.headline)
  assert.ok(item.headline.includes('30 days'), item.headline)
})

test('NEVER RE-RAISE A DISMISSAL — waved off once is gone for good', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  stageProposal(root, 'career', 'draft.md', '# A draft\n')
  const { bell } = scan(root, emptyState(), NOW)

  const dismissed = { dismissed: { [bell.id]: NOW.toISOString() }, notified: {}, settings: {} }
  const after = scan(root, dismissed, NOW)

  assert.equal(after.bell, null, 'it does not ring')
  assert.equal(after.items.length, 0, 'and it does not linger in the window either')
})

test('a dismissal survives the draft being edited', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const path = stageProposal(root, 'career', 'draft.md', '# Version one\n')
  const { bell } = scan(root, emptyState(), NOW)
  const dismissed = { dismissed: { [bell.id]: NOW.toISOString() }, notified: {}, settings: {} }

  // The agent rewrites the draft in place. Identity is the path, not the contents,
  // so this must NOT resurrect a bell the user already waved off.
  writeFileSync(path, '# Version two, rather different\n', 'utf8')

  assert.equal(scan(root, dismissed, NOW).bell, null)
})

test('collect is bounded and sorted newest-first within a kind', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  stageProposal(root, 'career', 'old.md', '# Old\n')
  stageProposal(root, 'career', 'new.md', '# New\n')

  const items = collect(root, NOW)
  assert.equal(items.length, 2)
  assert.ok(Date.parse(items[0].at) >= Date.parse(items[1].at))
})

// ---------------------------------------------------------------------------
// The counter — the only write into ~/ai-os
// ---------------------------------------------------------------------------

test('the usage counter is NEVER created — only appended when the user already opted in', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const usagePath = join(root, '.aios-usage.jsonl')
  recordUsage(usagePath, 'proposal_accepted', NOW)

  assert.equal(
    existsSync(usagePath),
    false,
    'installing a GUI must not opt a user into counting they never enabled',
  )
})

test('the usage counter records counts only — never content', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const usagePath = join(root, '.aios-usage.jsonl')
  writeFileSync(usagePath, '', 'utf8') // the user opted in

  recordUsage(usagePath, 'proposal_accepted', NOW)
  recordUsage(usagePath, 'proposal_dismissed', NOW)

  const lines = readFileSync(usagePath, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)

  for (const line of lines) {
    const parsed = JSON.parse(line)
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ['event', 'ts'],
      'an event is a timestamp and a name — no path, no filename, no headline, ever',
    )
  }
})

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

test('a corrupt state file degrades to safe defaults, not to an undefined posture', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const path = join(root, 'desk-state.json')
  writeFileSync(path, '{ this is not json', 'utf8')

  const state = loadState(path)
  assert.deepEqual(state.dismissed, {})
  assert.equal(state.settings.notifications, true)
  assert.equal(state.settings.quietHours.enabled, true, 'quiet hours stay ON through corruption')
  assert.equal(state.settings.quietHours.startHour, 21)
})

test('a missing state file is not an error', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const state = loadState(join(root, 'does-not-exist.json'))
  assert.equal(state.settings.quietHours.startHour, 21)
})

test('state round-trips', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const path = join(root, 'desk-state.json')
  saveState(path, {
    dismissed: { 'career/proposals/x.md': NOW.toISOString() },
    notified: {},
    settings: { notifications: false, quietHours: { enabled: true, startHour: 22, endHour: 6 } },
  })

  const state = loadState(path)
  assert.equal(state.dismissed['career/proposals/x.md'], NOW.toISOString())
  assert.equal(state.settings.notifications, false)
  assert.equal(state.settings.quietHours.startHour, 22)
})

test('out-of-range settings are rejected rather than stored', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const path = join(root, 'desk-state.json')
  writeFileSync(
    path,
    JSON.stringify({ settings: { quietHours: { enabled: true, startHour: 99, endHour: -4 } } }),
    'utf8',
  )

  const state = loadState(path)
  assert.equal(state.settings.quietHours.startHour, 21, 'falls back to the default hour')
  assert.equal(state.settings.quietHours.endHour, 5)
})
