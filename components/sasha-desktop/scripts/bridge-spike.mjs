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
 * Upgraded after the second Grok eval-pass (2026-07-27), BEFORE any run — two of its
 * structural objections were right and cheap:
 *   · TWO bridge trials, not one (matches §4s's t1/t2; a single flake proves nothing)
 *   · an optional CONTROL ARM: `--control` runs the SAME task on the SAME model
 *     through opencode, scored by the SAME postconditions — so a bridge FAIL can be
 *     attributed (bridge's fault vs the model can't do the task at all), and a PASS
 *     has a comparator. Without it, n=1-no-control was fairly called uninterpretable.
 * What was NOT adopted: the claim that disk postconditions "bypass the bridge
 * surface". They cannot — mkdir/write/copy are tool_use blocks that MUST round-trip
 * through the bridge's translation for the files to exist. Disk state is downstream
 * proof the stream translation worked, which is exactly why §4s scores this way.
 *
 * Run on a machine with a live `ollama serve` (e.g. dogma-2):
 *   node scripts/bridge-spike.mjs <ollama-model> [--control]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const MODEL = process.argv[2]
const WITH_CONTROL = process.argv.includes('--control')
if (!MODEL) {
  console.error('usage: node scripts/bridge-spike.mjs <ollama-model> [--control]')
  process.exit(2)
}

const { startAnthropicBridge } = await import(join(ROOT, 'out/main/session/anthropic-bridge.js'))

const TASK = [
  'Do exactly the following in the current directory, then stop:',
  '1. Create a directory named `notes`.',
  '2. Write a file `notes/animals.txt` containing exactly three lines: cat, dog, horse.',
  '3. Append a fourth line `mule` to notes/animals.txt.',
  '4. Copy notes/animals.txt to notes/backup.txt.',
  '5. Write a file `done.txt` containing the single word: finished',
].join('\n')

/** Postconditions — the score is the disk, not the transcript. */
function score(workspace) {
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
    console.log(`    ${ok ? '✓' : '✗'} ${name}`)
    if (ok) passed++
  }
  return passed === checks.length
}

const TIMEOUT_MS = 10 * 60_000

/** Run one command in a fresh workspace; resolve {pass, wall}. */
function trial(label, command, args, env) {
  const workspace = mkdtempSync(join(tmpdir(), 'bridge-spike-'))
  const started = Date.now()
  console.log(`\n[${label}] workspace=${workspace}`)
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: workspace, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (c) => (output += c))
    child.stderr.on('data', (c) => (output += c))
    const timer = setTimeout(() => {
      console.log(`  ✗ TIMEOUT after ${TIMEOUT_MS / 60000} min`)
      child.kill('SIGKILL')
    }, TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      console.log(`  ✗ could not start ${command}: ${error.message}`)
      rmSync(workspace, { recursive: true, force: true })
      resolve({ pass: false, wall: 0, startFailed: true })
    })
    child.on('close', () => {
      clearTimeout(timer)
      const wall = ((Date.now() - started) / 1000).toFixed(0)
      console.log(`  wall ${wall}s · tail: ${output.trim().slice(-140).replace(/\n/g, ' ')}`)
      const pass = score(workspace)
      rmSync(workspace, { recursive: true, force: true })
      resolve({ pass, wall: Number(wall) })
    })
  })
}

console.log(`bridge-spike: model=${MODEL} trials=2 control=${WITH_CONTROL ? 'opencode' : 'none'}`)
const bridge = await startAnthropicBridge((m) => console.log(`  [bridge] ${m}`))
const bridgeEnv = {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridge.port}`,
  ANTHROPIC_AUTH_TOKEN: 'local-bridge',
  ANTHROPIC_API_KEY: '',
}
const claudeArgs = ['-p', '--model', MODEL, '--permission-mode', 'acceptEdits', TASK]

const t1 = await trial('bridge t1', 'claude', claudeArgs, bridgeEnv)
const t2 = await trial('bridge t2', 'claude', claudeArgs, bridgeEnv)
bridge.close()

let control = null
if (WITH_CONTROL) {
  // Same model, same task, same scorer — through opencode's native Ollama path.
  // §4s note: headless `opencode run` denies tools without --auto (verified 1.18.4).
  control = await trial('control (opencode)', 'opencode',
    ['run', '--auto', '-m', `ollama/${MODEL}`, TASK], {})
  if (control.startFailed) {
    console.log('  (control arm unavailable on this host — bridge verdict stands alone; say so in the report)')
    control = null
  }
}

const passes = [t1, t2].filter((t) => t.pass).length
console.log(`\nVERDICT: bridge ${passes}/2 pass` +
  (control ? ` · control(opencode same model): ${control.pass ? 'PASS' : 'FAIL'} ${control.wall}s` : ''))

if (passes === 2) {
  console.log('PASS — the bridge holds a real agentic loop on both trials. It stays.')
  process.exit(0)
}
if (control && !control.pass) {
  console.log('INCONCLUSIVE — the bridge failed but so did the control: this MODEL cannot do the task on this host. Verdict attaches to the model, not the bridge; rerun with a stronger local model before any deletion.')
  process.exit(3)
}
console.log('FAIL — per the pre-stated falsifier: delete the bridge; opencode owns local.')
process.exit(1)
