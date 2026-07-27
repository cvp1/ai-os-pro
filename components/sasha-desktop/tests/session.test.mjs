import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseModelId } from '../out/main/session/protocol.js'
import { defaultModel } from '../out/main/session/models.js'
import { assertLoopback, OLLAMA_HOST } from '../out/main/session/ollama-backend.js'

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

test('the local backend REFUSES any non-loopback host', () => {
  // audit:surface allows exactly one file in this app to open a socket. This guard is
  // the reason that permission is safe, so it gets tested like a security control:
  // if any of these were ever accepted, prompts would leave the user's machine.
  const offMachine = [
    'api.openai.com',
    'ollama.example.com',
    '10.0.0.5',
    '192.168.86.21', // another box on the LAN is STILL not this machine
    '0.0.0.0',
    'evil.test',
    '127.0.0.1.evil.test', // prefix that merely looks like loopback
  ]
  for (const host of offMachine) {
    assert.throws(
      () => assertLoopback(host),
      /refuses to send a prompt/,
      `${host} must be refused`,
    )
  }
})

test('the local backend accepts only real loopback names', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    assert.doesNotThrow(() => assertLoopback(host), `${host} should be allowed`)
  }
})

test('the configured Ollama host is itself loopback', () => {
  // Belt and braces: the constant the code actually uses must pass its own guard.
  assert.doesNotThrow(() => assertLoopback(OLLAMA_HOST))
  assert.equal(OLLAMA_HOST, '127.0.0.1')
})

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
// Slash commands must never be silently handed to a bare local model
// ---------------------------------------------------------------------------

import { SessionManager } from '../out/main/session/manager.js'

const LOCAL = [{ id: 'ollama:x', label: 'x', provider: 'ollama', detail: '', local: true }]

function capture(manager) {
  const events = []
  manager.onEvent((e) => events.push(e))
  return events
}

test('a slash command to a LOCAL model is refused, not silently answered', async () => {
  // The failure this prevents: "/brief" reaches a bare model as literal text, the
  // model invents a confident briefing, and the user cannot tell it is fiction.
  // A refusal is worse UX and far better behaviour.
  const manager = new SessionManager(undefined, '/tmp', 'acceptEdits')
  const events = capture(manager)
  manager.select('ollama:x', LOCAL)

  const sent = await manager.send('/brief')
  assert.equal(sent, false, 'the message must not be sent')

  const error = events.find((e) => e.kind === 'error')
  assert.ok(error, 'the user must be told why')
  assert.match(error.message, /\/brief/)
  assert.match(error.message, /cannot run skills/)
})

test('the refusal covers leading whitespace and arguments', async () => {
  const manager = new SessionManager(undefined, '/tmp', 'acceptEdits')
  capture(manager)
  manager.select('ollama:x', LOCAL)
  assert.equal(await manager.send('  /status --deep'), false)
})

test('ordinary questions to a local model are NOT refused', async () => {
  // The guard must be narrow: only slash commands, nothing else.
  const manager = new SessionManager(undefined, '/tmp', 'acceptEdits')
  const events = capture(manager)
  manager.select('ollama:x', LOCAL)
  await manager.send('what is 2 + 2?')
  assert.equal(
    events.some((e) => e.kind === 'error' && /cannot run skills/.test(e.message)),
    false,
    'a plain question must pass through',
  )
})
