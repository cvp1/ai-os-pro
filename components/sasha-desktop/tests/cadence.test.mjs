import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCadence, isDead, latestPerJob, parseHeartbeatLines } from '../out/main/doorbell/heartbeat.js'

const NOW = new Date('2026-07-27T12:00:00Z')
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString()
const DAY = 86_400_000

test('parseCadence understands the units Core actually writes', () => {
  assert.equal(parseCadence('7d'), 7 * DAY)
  assert.equal(parseCadence('24h'), 24 * 3_600_000)
  assert.equal(parseCadence('30m'), 30 * 60_000)
  assert.equal(parseCadence('2w'), 2 * 604_800_000)
  assert.equal(parseCadence(' 7d '), 7 * DAY)
})

test('parseCadence returns null rather than guessing', () => {
  // An unknown cadence must not become a default cadence — that would let us
  // declare a job dead on a number we invented.
  for (const bad of ['', 'soon', '7', 'd7', '0d', '-3d', null, undefined, 42, {}]) {
    assert.equal(parseCadence(bad), null, `expected null for ${JSON.stringify(bad)}`)
  }
})

test('a job silent past half again its cadence is dead', () => {
  const job = { job: 'projects-checkin', ts: ago(11 * DAY), every: '7d' }
  assert.equal(isDead(job, NOW), true)
})

test('a job inside its cadence is alive', () => {
  assert.equal(isDead({ job: 'x', ts: ago(3 * DAY), every: '7d' }, NOW), false)
})

test('the boundary is exclusive — exactly 1.5x is not yet dead', () => {
  // 7d * 1.5 = 10.5d. At exactly 10.5 days we are not PAST the threshold.
  assert.equal(isDead({ job: 'x', ts: ago(10.5 * DAY), every: '7d' }, NOW), false)
  assert.equal(isDead({ job: 'x', ts: ago(10.6 * DAY), every: '7d' }, NOW), true)
})

test('unreadable evidence never reports a dead job', () => {
  // A silent instrument is not a silent job. Both of these must be false.
  assert.equal(isDead({ job: 'x', ts: ago(99 * DAY) }, NOW), false, 'no cadence')
  assert.equal(isDead({ job: 'x', ts: 'not-a-date', every: '7d' }, NOW), false, 'bad timestamp')
})

test('latestPerJob keeps the newest record for each job', () => {
  const records = [
    { job: 'a', ts: ago(9 * DAY), every: '7d' },
    { job: 'a', ts: ago(1 * DAY), every: '7d' },
    { job: 'b', ts: ago(30 * DAY), every: '7d' },
  ]
  const latest = latestPerJob(records)
  assert.equal(latest.size, 2)
  assert.equal(latest.get('a').ts, ago(1 * DAY))
  assert.equal(isDead(latest.get('a'), NOW), false, 'the recent run should clear the old one')
  assert.equal(isDead(latest.get('b'), NOW), true)
})

test('a corrupt line is skipped, not fatal', () => {
  const text = [
    JSON.stringify({ ts: ago(DAY), job: 'good', every: '7d' }),
    '{ not json at all',
    '',
    JSON.stringify({ ts: ago(DAY), missing: 'job field' }),
    JSON.stringify({ ts: ago(2 * DAY), job: 'also-good', every: '1d' }),
  ].join('\n')

  const records = parseHeartbeatLines(text)
  assert.equal(records.length, 2)
  assert.deepEqual(
    records.map((r) => r.job),
    ['good', 'also-good'],
  )
})
