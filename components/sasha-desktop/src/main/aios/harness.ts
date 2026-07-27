import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, delimiter } from 'node:path'
import { execFile } from 'node:child_process'
import type { HarnessState } from '../types.js'

/**
 * The harness bridge — finding and driving the user's own Claude Code.
 *
 * DESK never ships a model, never holds a key, and never authenticates anything. It
 * runs the `claude` binary the user already installed, under the login they already
 * have. That is the whole sovereignty story in one design choice: there is no
 * gateway to route through because there is no gateway.
 */

/** Where `claude` lives when PATH is not inherited (the GUI-launch case on macOS). */
function candidatePaths(): string[] {
  const home = homedir()
  const names = platform() === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']
  const dirs = [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    ...(process.env.PATH?.split(delimiter) ?? []),
  ]
  const out: string[] = []
  for (const dir of dirs) {
    if (!dir) continue
    for (const name of names) out.push(join(dir, name))
  }
  return out
}

export function findHarness(): HarnessState {
  for (const path of candidatePaths()) {
    if (existsSync(path)) return { found: true, path }
  }
  return {
    found: false,
    problem:
      'Claude Code was not found on this machine. Sasha Desktop drives your own ' +
      'Claude Code install — it does not bundle one, and it never signs in on your ' +
      'behalf. Install Claude Code, then reopen this window.',
  }
}

/** Bound every run: a hung harness must not become a hung app. */
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 1_000_000

export interface RunResult {
  ok: boolean
  output: string
  problem?: string
}

/**
 * Run one prompt headlessly and return its text.
 *
 * `execFile` (not `exec`) — arguments are passed as an array, never interpolated into
 * a shell string, so a prompt containing shell metacharacters is data and stays data.
 */
export function runHeadless(
  harnessPath: string,
  cwd: string,
  prompt: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      harnessPath,
      ['-p', prompt],
      { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        const output = (stdout || '').trim()
        if (error) {
          const timedOut = (error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
          resolve({
            ok: false,
            output,
            problem: timedOut
              ? `The harness did not finish within ${Math.round(timeoutMs / 1000)}s. It may be waiting on a permission prompt — try the same command in your terminal to see.`
              : (stderr || '').trim() || error.message,
          })
          return
        }
        resolve({ ok: true, output })
      },
    )
  })
}

export function harnessVersion(harnessPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(harnessPath, ['--version'], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(undefined)
        return
      }
      resolve(stdout.trim().split('\n')[0] ?? undefined)
    })
  })
}
