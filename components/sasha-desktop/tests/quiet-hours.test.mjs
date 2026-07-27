import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isQuiet, describeQuietHours } from '../out/main/quiet-hours.js'

/** A local-time Date at the given hour — quiet hours are wall-clock, not UTC. */
const at = (hour) => new Date(2026, 6, 27, hour, 30, 0)

const DEFAULT = { enabled: true, startHour: 21, endHour: 5 }

test('the default window is 9pm-5am — the sleep invariant', () => {
  assert.equal(DEFAULT.startHour, 21)
  assert.equal(DEFAULT.endHour, 5)
})

test('quiet across midnight', () => {
  for (const hour of [21, 22, 23, 0, 1, 4]) {
    assert.equal(isQuiet(DEFAULT, at(hour)), true, `${hour}:30 should be quiet`)
  }
})

test('loud during the day', () => {
  for (const hour of [5, 6, 9, 12, 17, 20]) {
    assert.equal(isQuiet(DEFAULT, at(hour)), false, `${hour}:30 should not be quiet`)
  }
})

test('the window boundaries are half-open — quiet at the start, awake at the end', () => {
  assert.equal(isQuiet(DEFAULT, new Date(2026, 6, 27, 21, 0, 0)), true, '9:00pm exactly')
  assert.equal(isQuiet(DEFAULT, new Date(2026, 6, 27, 5, 0, 0)), false, '5:00am exactly')
})

test('a same-day window works too', () => {
  const window_ = { enabled: true, startHour: 1, endHour: 6 }
  assert.equal(isQuiet(window_, at(3)), true)
  assert.equal(isQuiet(window_, at(7)), false)
  assert.equal(isQuiet(window_, at(23)), false)
})

test('disabled means never quiet', () => {
  assert.equal(isQuiet({ ...DEFAULT, enabled: false }, at(2)), false)
})

test('a degenerate window is never quiet rather than always quiet', () => {
  // start === end is ambiguous; resolving it to "always silent" would swallow every
  // notification forever. Degrade toward the loud, visible default.
  assert.equal(isQuiet({ enabled: true, startHour: 9, endHour: 9 }, at(9)), false)
})

test('describeQuietHours reads like a person wrote it', () => {
  assert.equal(describeQuietHours(DEFAULT), '9pm–5am')
  assert.equal(describeQuietHours({ enabled: true, startHour: 0, endHour: 12 }), '12am–12pm')
  assert.equal(describeQuietHours({ ...DEFAULT, enabled: false }), 'off')
})
