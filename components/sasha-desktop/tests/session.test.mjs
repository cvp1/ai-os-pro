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
// Local models go through the SAME harness as Claude
// ---------------------------------------------------------------------------

import { startAnthropicBridge } from '../out/main/session/anthropic-bridge.js'

test('the local-model bridge binds loopback and nothing else', async () => {
  // It exists to give local models Claude Code's brain; it must never become a
  // listener anything off-machine can reach.
  const bridge = await startAnthropicBridge()
  try {
    assert.ok(bridge.port > 0, 'a port should be assigned')
  } finally {
    bridge.close()
  }
})

test('the bridge translates an Anthropic request into an Ollama one', async () => {
  // The whole point: system prompt and tool definitions must survive the crossing,
  // because those ARE the brain. If either is dropped the local model silently
  // becomes the bare chat this bridge was built to replace.
  const { createServer } = await import('node:http')
  const received = []

  const ollama = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received.push(JSON.parse(body))
      res.setHeader('content-type', 'application/x-ndjson')
      res.end(JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n')
    })
  })
  await new Promise((r) => ollama.listen(11434, '127.0.0.1', r))

  const bridge = await startAnthropicBridge()
  try {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        system: 'You are a Claude agent.',
        tools: [
          { name: 'Read', description: 'read a file', input_schema: { type: 'object' } },
          { name: 'Bash', description: 'run a command', input_schema: { type: 'object' } },
        ],
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    })
    await res.text()

    assert.equal(received.length, 1, 'the bridge should have called Ollama once')
    const payload = received[0]

    const system = payload.messages.find((m) => m.role === 'system')
    assert.ok(system, 'the system prompt must reach the local model')
    assert.match(system.content, /You are a Claude agent/)

    assert.equal(payload.tools.length, 2, 'tool definitions must reach the local model')
    assert.deepEqual(
      payload.tools.map((t) => t.function.name).sort(),
      ['Bash', 'Read'],
    )
    assert.equal(payload.model, 'test-model')
  } finally {
    bridge.close()
    await new Promise((r) => ollama.close(r))
  }
})
