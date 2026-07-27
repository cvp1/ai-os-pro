import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ollamaUrl, listOllamaModels, discoverLocal } from '../out/main/aios/local.js'
import { availableModels, defaultModel, localModels } from '../out/main/session/models.js'

/**
 * The local half of the product.
 *
 * The thing these tests protect is not the happy path — it is the FAILURE messages.
 * "Local models unavailable" is the sentence that makes someone give up on the whole
 * promise; each failure here has to name the one thing to do next, so each one is
 * pinned to the state that produces it.
 */

test('the Ollama URL follows Ollama\'s own convention, and normalises', () => {
  assert.equal(ollamaUrl({}), 'http://127.0.0.1:11434')
  assert.equal(ollamaUrl({ OLLAMA_HOST: '192.168.1.5:11434' }), 'http://192.168.1.5:11434')
  assert.equal(ollamaUrl({ OLLAMA_HOST: 'http://box:11434/' }), 'http://box:11434')
  // The app-specific override wins, for a machine whose OLLAMA_HOST means something else.
  assert.equal(
    ollamaUrl({ OLLAMA_HOST: 'http://a:1', SASHA_OLLAMA_URL: 'http://b:2' }),
    'http://b:2',
  )
})

test('an explicit model list covers the remote-Ollama case', async () => {
  const models = await listOllamaModels({ SASHA_OLLAMA_MODELS: 'gemma3n:e4b, qwen3:8b ,' })
  assert.deepEqual(models, ['gemma3n:e4b', 'qwen3:8b'])
})

test('no Ollama and no opencode explains BOTH pieces and where to get them', async () => {
  const state = await discoverLocal({ PATH: '/nonexistent', SASHA_OPENCODE_PATH: '/nope' })
  assert.equal(state.ready, false)
  assert.match(state.problem ?? '', /Ollama/)
  assert.match(state.problem ?? '', /opencode/)
})

test('models present but no opencode names opencode as the missing piece', async () => {
  const state = await discoverLocal({
    PATH: '/nonexistent',
    SASHA_OPENCODE_PATH: '/nope',
    SASHA_OLLAMA_MODELS: 'gemma3n:e4b',
  })
  assert.equal(state.ready, false)
  assert.match(state.problem ?? '', /opencode/)
  // It must NOT tell someone to install what they already have.
  assert.doesNotMatch(state.problem ?? '', /Install (Ollama|both)/i)
  assert.deepEqual(state.models, ['gemma3n:e4b'])
})

// ---------------------------------------------------------------------------
// What the picker offers
// ---------------------------------------------------------------------------

const READY = {
  ready: true,
  opencodePath: '/usr/bin/opencode',
  ollamaUrl: 'http://127.0.0.1:11434',
  models: ['gemma3n:e4b', 'qwen3:8b'],
}
const NOT_READY = { ready: false, ollamaUrl: 'http://127.0.0.1:11434', models: [], problem: 'nope' }

test('local models appear beside Claude models when the machine is ready', () => {
  const choices = availableModels(true, READY)
  assert.equal(choices.filter((c) => c.local).length, 2)
  assert.equal(choices.filter((c) => !c.local).length, 4)
  const local = choices.find((c) => c.local)
  assert.equal(local.provider, 'ollama')
  assert.equal(local.id, 'ollama:gemma3n:e4b')
  // The id keeps the full tag, colons and all — that is what opencode is handed.
  assert.match(local.label, /local/)
})

test('nothing local is offered when the machine cannot run it', () => {
  assert.deepEqual(localModels(NOT_READY), [])
  assert.equal(availableModels(true, NOT_READY).length, 4)
})

test('local models alone are enough to use the app', () => {
  const choices = availableModels(false, READY)
  assert.equal(choices.length, 2)
  assert.equal(defaultModel(choices), 'ollama:gemma3n:e4b')
})

/**
 * The disclosure test — and a small monument to a near-miss.
 *
 * This assertion was briefly INVERTED. A read-only posture appeared to fail four
 * different ways, so the picker was rewritten to admit that local sessions can write,
 * and this test was rewritten to demand that admission. All four measurements were
 * taken through a broken rig (an open stdin pipe the child sat reading forever); with
 * that fixed, the permission config works and writes really are blocked — verified
 * live: write/bash return `invalid`, no file appears, reads still work.
 *
 * So it asserts read-only again, on evidence this time. If a future change makes local
 * sessions able to write, this test should fail loudly and be flipped deliberately —
 * never quietly, and never on a single instrument's word.
 */
test('the local detail line promises reading and not writing', () => {
  const local = localModels(READY)[0]
  assert.match(local.detail, /own hardware/i)
  assert.match(local.detail, /reads your files/i)
  assert.match(local.detail, /cannot change/i)
})

test('a remembered local model is restored; the default otherwise prefers Sonnet', () => {
  const choices = availableModels(true, READY)
  assert.equal(defaultModel(choices, 'ollama:qwen3:8b'), 'ollama:qwen3:8b')
  assert.equal(defaultModel(choices), 'claude:sonnet')
})
