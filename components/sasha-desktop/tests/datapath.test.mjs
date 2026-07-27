import { test } from 'node:test'
import assert from 'node:assert/strict'

import { describeDataPath } from '../out/main/aios/datapath.js'

/**
 * The privacy panel.
 *
 * These tests exist to stop this panel drifting into an advertisement. The failure
 * mode is not a crash — it is a page that keeps saying reassuring things after they
 * stopped being true. So each test pins a claim to the state that must produce it,
 * and the most important one asserts that the UNCOMFORTABLE line appears.
 */

const CLOUD = {
  modelLabel: 'Claude Sonnet 5',
  provider: 'claude',
  local: false,
  harnessFound: true,
  harnessPath: '/usr/bin/claude',
  installRoot: '/home/someone/ai-os',
}

const LOCAL = { ...CLOUD, modelLabel: 'gemma4-e4b', provider: 'ollama', local: true }
const NOTHING = { modelLabel: null, provider: null, local: false, harnessFound: false }

test('a cloud model is described as leaving the machine, in those words', () => {
  const path = describeDataPath(CLOUD)
  const conversation = path.flows[0]
  assert.equal(conversation.what, 'Your conversation')
  assert.equal(conversation.direction, 'leaves')
  assert.match(conversation.detail, /Anthropic/)
  assert.match(conversation.detail, /Claude Sonnet 5/)
  // The bad news is the FIRST row, not buried under the reassuring ones.
  assert.equal(path.flows.findIndex((f) => f.direction === 'leaves'), 0)
})

test('a local model is described as staying, and does not name a company', () => {
  const path = describeDataPath(LOCAL)
  assert.equal(path.flows[0].direction, 'stays')
  assert.doesNotMatch(path.flows[0].detail, /Anthropic/)
  assert.equal(path.summary, 'Nothing leaves this machine.')
})

test('with no harness the panel says nothing is running rather than describing a path', () => {
  const path = describeDataPath(NOTHING)
  assert.equal(path.flows[0].direction, 'unknown')
  assert.match(path.summary, /nothing is running/i)
  assert.ok(!path.flows.some((flow) => flow.direction === 'leaves'))
})

test('the app\'s own zero-telemetry claim is always present', () => {
  for (const inputs of [CLOUD, LOCAL, NOTHING]) {
    const row = describeDataPath(inputs).flows.find((flow) =>
      /analytics/i.test(flow.what),
    )
    assert.ok(row, 'the telemetry row must appear in every state')
    assert.equal(row.direction, 'stays')
    assert.match(row.detail, /no account/i)
  }
})

test('file content is disclosed as part of what gets sent to a cloud model', () => {
  const cloud = describeDataPath(CLOUD).flows.find((flow) => flow.what === 'Your files')
  assert.equal(cloud.direction, 'leaves')
  // The subtle one people miss: "it can read my notes" also means "my notes are sent".
  assert.match(cloud.detail, /part of what is sent/i)

  const local = describeDataPath(LOCAL).flows.find((flow) => flow.what === 'Your files')
  assert.equal(local.direction, 'stays')
  assert.match(local.detail, /Nothing is uploaded/i)
})

test('the workspace path is reported when there is one', () => {
  assert.equal(describeDataPath(CLOUD).workspace, '/home/someone/ai-os')
  assert.equal(describeDataPath(NOTHING).workspace, undefined)
})

test('memory and me/ are always described as staying on disk', () => {
  for (const inputs of [CLOUD, LOCAL, NOTHING]) {
    const row = describeDataPath(inputs).flows.find((flow) => /knows about you/.test(flow.what))
    assert.ok(row)
    assert.equal(row.direction, 'stays')
    assert.match(row.detail, /markdown/i)
  }
})

test('every flow carries a direction the UI knows how to render', () => {
  for (const inputs of [CLOUD, LOCAL, NOTHING]) {
    for (const flow of describeDataPath(inputs).flows) {
      assert.ok(['stays', 'leaves', 'unknown'].includes(flow.direction), flow.direction)
      assert.ok(flow.what.length > 0)
      assert.ok(flow.detail.length > 20, 'a detail line must actually explain')
    }
  }
})
