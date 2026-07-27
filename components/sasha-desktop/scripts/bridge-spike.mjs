#!/usr/bin/env node
/**
 * bridge-spike — the falsifier for the Anthropic→Ollama bridge, stated in advance.
 *
 * The bridge's whole claim is that Claude Code can drive a LOCAL model through it
 * well enough to do real agentic work — Sasha's brain on local weights. That claim
 * has only ever been proven against a stub, and the fleet's own harness gate
 * (ollama-tools LOCAL_FLEET.md §4s) scores task completion on the filesystem, not
 * protocol round-trips. So this script applies the same bar:
 *
 *   a 5-step file task, driven end-to-end, scored by POSTCONDITIONS on disk.
 *
 * PASS → the bridge stays: it is the one thing that gives Sasha-with-her-skills
 *        local weights, which opencode does not.
 * FAIL → the bridge gets DELETED, and opencode owns the local path entirely.
 *        No patching, no retries-until-green: the threshold was set before the run.
 *
 * Run on a machine with a live `ollama serve` (e.g. dogma-2):
 *   node scripts/bridge-spike.mjs <ollama-model>          # e.g. gemma4-e4b-agent-64k:latest
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const MODEL = process.argv[2]
if (!MODEL) {
  console.error('usage: node scripts/bridge-spike.mjs <ollama-model>')
  process.exit(2)
}

const { startAnthropicBridge } = await import(join(ROOT, 'out/main/session/anthropic-bridge.js'))

const workspace = mkdtempSync(join(tmpdir(), 'bridge-spike-'))
const TASK = [
  'Do exactly the following in the current directory, then stop:',
  '1. Create a directory named `notes`.',
  '2. Write a file `notes/animals.txt` containing exactly three lines: cat, dog, horse.',
  '3. Append a fourth line `mule` to notes/animals.txt.',
  '4. Copy notes/animals.txt to notes/backup.txt.',
  '5. Write a file `done.txt` containing the single word: finished',
].join('\n')

/** Postconditions — the score is the disk, not the transcript. */
function score() {
  const checks = [
    ['notes/ exists', () => existsSync(join(workspace, 'notes'))],
    ['animals.txt has 4 lines ending mule', () => {
      const t = readFileSync(join(workspace, 'notes/animals.txt'), 'utf8').trim().split('\n')
      return t.length === 4 && t[0] === 'cat' && t[3] === 'mule'
    }],
    ['backup.txt matches', () => {
      const a = readFileSync(join(workspace, 'notes/animals.txt'), 'utf8')
      const b = readFileSync(join(workspace, 'notes/backup.txt'), 'utf8')
      return a === b
    }],
    ['done.txt says finished', () =>
      readFileSync(join(workspace, 'done.txt'), 'utf8').trim() === 'finished'],
  ]
  let passed = 0
  for (const [name, check] of checks) {
    let ok = false
    try { ok = check() } catch { ok = false }
    console.log(`  ${ok ? '✓' : '✗'} ${name}`)
    if (ok) passed++
  }
  return passed === checks.length
}

console.log(`bridge-spike: model=${MODEL} workspace=${workspace}`)
const bridge = await startAnthropicBridge((m) => console.log(`  [bridge] ${m}`))
const started = Date.now()

const child = spawn('claude', ['-p', '--model', MODEL, '--permission-mode', 'acceptEdits', TASK], {
  cwd: workspace,
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridge.port}`,
    ANTHROPIC_AUTH_TOKEN: 'local-bridge',
    ANTHROPIC_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
child.stdout.on('data', (c) => (output += c))
child.stderr.on('data', (c) => (output += c))

const TIMEOUT_MS = 10 * 60_000
const timer = setTimeout(() => {
  console.log('✗ TIMEOUT — the model did not finish in 10 minutes')
  child.kill('SIGKILL')
}, TIMEOUT_MS)

child.on('close', () => {
  clearTimeout(timer)
  bridge.close()
  const wall = ((Date.now() - started) / 1000).toFixed(0)
  console.log(`\nwall: ${wall}s · transcript tail: ${output.trim().slice(-200)}\n`)
  console.log('POSTCONDITIONS:')
  const pass = score()
  console.log(pass
    ? `\nPASS — the bridge holds a real agentic loop with ${MODEL}. It stays.`
    : `\nFAIL — the bridge could not carry ${MODEL} through a 5-step task.\n` +
      'Per the pre-stated falsifier: delete the bridge; opencode owns local.')
  rmSync(workspace, { recursive: true, force: true })
  process.exit(pass ? 0 : 1)
})
