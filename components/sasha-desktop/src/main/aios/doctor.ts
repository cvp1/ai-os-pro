import { findHarness, runHeadless } from './harness.js'
import type { DoctorResult, InstallState } from '../types.js'

/**
 * `/doctor`, run headlessly and rendered as-is.
 *
 * DESK deliberately does not parse, score, or summarise the result. `/doctor` is a
 * Core skill whose whole value is that it explains itself in plain words and routes
 * the fix; re-interpreting its output in a GUI would put a second, dumber opinion
 * between the user and their own system. We run it and show what it said.
 *
 * On failure the app renders a visible red state with the reason — never a crash,
 * and never a green box hiding an unread result.
 */
export async function runDoctor(install: InstallState): Promise<DoctorResult> {
  const ranAt = new Date().toISOString()

  if (!install.found || !install.root) {
    return { ok: false, output: '', ranAt, problem: install.problem ?? 'No AI-OS install found.' }
  }

  const harness = findHarness()
  if (!harness.found || !harness.path) {
    return { ok: false, output: '', ranAt, problem: harness.problem ?? 'Claude Code not found.' }
  }

  const result = await runHeadless(harness.path, install.root, '/doctor')
  if (!result.ok) {
    const failure: DoctorResult = { ok: false, output: result.output, ranAt }
    if (result.problem !== undefined) failure.problem = result.problem
    return failure
  }

  if (result.output === '') {
    return {
      ok: false,
      output: '',
      ranAt,
      problem:
        '/doctor produced no output. That usually means the skill is not installed in ' +
        'this workspace — run /doctor once in your terminal to confirm.',
    }
  }

  return { ok: true, output: result.output, ranAt }
}
