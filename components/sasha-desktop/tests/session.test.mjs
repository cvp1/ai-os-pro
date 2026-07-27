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
// SUPERSEDED, ON PURPOSE (v0.4 → v0.5).
//
// Two tests lived here asserting the OPPOSITE of what follows: that selecting a local
// model was refused with the bridge's gate story, and that no local model was ever
// listed. Both were correct for v0.4, when the only local path was a bridge we wrote
// that had failed its pre-stated gate and been deleted.
//
// They are replaced rather than quietly dropped, so the reversal stays legible: local
// models returned in v0.5 through opencode — a spawned binary, not a protocol we
// translate — after the control run showed the 1/2 failure belonged to the model tier
// rather than the transport. The bridge is still deleted; what changed is that there
// is now a second engine, so "refused" stopped being the honest answer.
// ---------------------------------------------------------------------------

import { SessionManager } from '../out/main/session/manager.js'

test('selecting a local model the machine cannot run explains why, with the fix', async () => {
  const manager = new SessionManager(undefined, '/tmp', 'acceptEdits', {
    ready: false,
    ollamaUrl: 'http://127.0.0.1:11434',
    models: [],
    problem: 'Ollama is here, but opencode is not — install it from opencode.ai.',
  })
  const events = []
  manager.onEvent((e) => events.push(e))
  await manager.select('ollama:gemma4-e4b-agent-64k:latest', [])
  const error = events.find((e) => e.kind === 'error')
  assert.ok(error, 'the user must be told')
  // The discovered reason, carrying the next step — not a generic refusal.
  assert.match(error.message, /opencode\.ai/)
})

test('a local model IS offered once the machine can run one', async () => {
  const { availableModels } = await import('../out/main/session/models.js')
  const models = availableModels(true, {
    ready: true,
    opencodePath: '/usr/bin/opencode',
    ollamaUrl: 'http://127.0.0.1:11434',
    models: ['gemma3n:e4b'],
  })
  const local = models.filter((m) => m.local)
  assert.equal(local.length, 1)
  assert.equal(local[0].provider, 'ollama')
})

test('switching to a local model warns it is not Sasha and cannot change files', async () => {
  const manager = new SessionManager(undefined, '/tmp', 'acceptEdits', {
    ready: true,
    opencodePath: '/bin/true',
    ollamaUrl: 'http://127.0.0.1:11434',
    models: ['gemma3n:e4b'],
  })
  const events = []
  manager.onEvent((e) => events.push(e))
  await manager.select('ollama:gemma3n:e4b', [
    { id: 'ollama:gemma3n:e4b', label: 'gemma3n (local)', provider: 'ollama', detail: '', local: true },
  ])
  const status = events.find((e) => e.kind === 'status')
  assert.ok(status, 'the difference must be stated at the moment of switching')
  assert.match(status.text, /not Sasha/i)
  assert.match(status.text, /cannot change/i)
  manager.close()
})



