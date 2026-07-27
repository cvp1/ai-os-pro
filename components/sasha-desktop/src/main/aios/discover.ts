import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { InstallState } from '../types.js'

/**
 * Find the AI-OS install.
 *
 * Tolerant by design: installs in the wild are partial. A machine may have the
 * secrets broker and me/ files but no build stamp; another may have skills but no
 * projects yet. DESK reports what it actually found and says plainly what it did
 * not — it never infers a version it cannot read, and it never renders "unknown" as
 * if it were a measurement.
 */

/** `AIOS_HOME` wins, then the conventional location. */
export function aiosRoot(): string {
  const override = process.env.AIOS_HOME?.trim()
  if (override) return override
  return join(homedir(), 'ai-os')
}

/**
 * The build stamp, when one is discoverable. Core stamps its installed prompt with a
 * date-ish version (`2026.07.18a`). Several layouts have carried it; we look in the
 * ones that have existed and give up quietly rather than guess.
 */
function findBuildStamp(root: string): string | undefined {
  const candidates = ['.aios-build', 'VERSION', join('me', 'CAPABILITIES.md'), 'CLAUDE.md']
  for (const candidate of candidates) {
    const path = join(root, candidate)
    if (!existsSync(path)) continue
    try {
      const head = readFileSync(path, 'utf8').slice(0, 2000)
      const match = /\b(20\d{2}\.\d{2}\.\d{2}[a-z]?)\b/.exec(head)
      if (match) return match[1]
    } catch {
      // Unreadable is the same as absent for this purpose.
    }
  }
  return undefined
}

/** Signals that this directory really is an AI-OS workspace, not just a coincidence. */
function markers(root: string): string[] {
  const found: string[] = []
  for (const marker of ['me', 'bin', 'projects', 'memory', 'CLAUDE.md']) {
    if (existsSync(join(root, marker))) found.push(marker)
  }
  return found
}

export function discoverInstall(root = aiosRoot()): InstallState {
  if (!existsSync(root)) {
    return {
      found: false,
      root,
      problem:
        `No AI-OS install at ${root}. Sasha Desktop is a window onto an existing AI-OS — ` +
        'set one up first (it is a single copy-paste, and the desktop Claude Code app is ' +
        'the gentlest way in), then reopen this.',
    }
  }

  const found = markers(root)
  if (found.length === 0) {
    return {
      found: false,
      root,
      problem:
        `${root} exists but does not look like an AI-OS workspace — none of me/, bin/, ` +
        'projects/, memory/ or CLAUDE.md are there. If your install lives elsewhere, set ' +
        'AIOS_HOME to point at it.',
    }
  }

  const state: InstallState = { found: true, root }
  const build = findBuildStamp(root)
  if (build) state.build = build
  return state
}

/** Count of staged proposal directories — a cheap "is anything wired up" signal. */
export function workspaceSummary(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((entry) => !entry.startsWith('.'))
      .slice(0, 40)
  } catch {
    return []
  }
}
