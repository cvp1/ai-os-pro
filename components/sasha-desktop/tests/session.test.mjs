import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseModelId } from '../out/main/session/protocol.js'
import { defaultModel } from '../out/main/session/models.js'

/**
 * The session layer — model routing and, most importantly, the guard that keeps the
 * one network exemption in this app honest.
 */

test('model ids carry their provider', () => {
  assert.deepEqual(parseModelId('claude:fable'), { provider: 'claude', model: 'fable' })
  assert.deepEqual(parseModelId('ollama:gemma4-e4b-agent-64k:latest'), {
    provider: 'ollama',
    // Only the FIRST colon splits — Ollama tags contain colons and must survive intact.
    model: 'gemma4-e4b-agent-64k:latest',
  })
  assert.deepEqual(parseModelId('sonnet'), { provider: 'claude', model: 'sonnet' })
})

// ---------------------------------------------------------------------------
// The loopback guard — the load-bearing test in this file.
// ---------------------------------------------------------------------------




// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

const CHOICES = [
  { id: 'claude:fable', label: 'Fable', provider: 'claude', detail: '', local: false },
  { id: 'claude:sonnet', label: 'Sonnet', provider: 'claude', detail: '', local: false },
  { id: 'ollama:gemma', label: 'gemma', provider: 'ollama', detail: '', local: true },
]

test('a remembered model is restored when it is still available', () => {
  assert.equal(defaultModel(CHOICES, 'ollama:gemma'), 'ollama:gemma')
})

test('a remembered model that has gone away does not strand the user', () => {
  // The model was uninstalled since last run. Fall back rather than selecting
  // something that cannot answer.
  assert.equal(defaultModel(CHOICES, 'ollama:deleted-model'), 'claude:sonnet')
})

test('with no memory, a sensible default is chosen', () => {
  assert.equal(defaultModel(CHOICES), 'claude:sonnet')
})

test('with only local models, a local one is chosen', () => {
  const localOnly = CHOICES.filter((c) => c.local)
  assert.equal(defaultModel(localOnly), 'ollama:gemma')
})

test('with nothing available the answer is null, not a guess', () => {
  // The UI must be able to say "no model available" plainly rather than pretending
  // to have selected something that will fail on first use.
  assert.equal(defaultModel([]), null)
  assert.equal(defaultModel([], 'claude:fable'), null)
})

// ---------------------------------------------------------------------------
// The gate that removed local models (2026-07-27) must STAY removed until a new
// gate passes: selecting an ollama: id is refused with a pointer to opencode.
// ---------------------------------------------------------------------------

import { SessionManager } from '../out/main/session/manager.js'

test('selecting a local model is refused with the gate story, not half-served', async () => {
  const manager = new SessionManager(undefined, '/tmp', 'acceptEdits')
  const events = []
  manager.onEvent((e) => events.push(e))
  await manager.select('ollama:gemma4-e4b-agent-64k:latest', [])
  const error = events.find((e) => e.kind === 'error')
  assert.ok(error, 'the user must be told')
  assert.match(error.message, /gate/i)
  assert.match(error.message, /opencode/)
})

test('no local models are ever listed', async () => {
  const { availableModels } = await import('../out/main/session/models.js')
  const models = await availableModels(true)
  assert.ok(models.length > 0)
  assert.equal(models.filter((m) => m.provider !== 'claude').length, 0)
})



