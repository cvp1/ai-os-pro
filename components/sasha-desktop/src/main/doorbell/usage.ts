import { appendFileSync, existsSync } from 'node:fs'

/**
 * The counter — the ONLY thing DESK ever writes inside ~/ai-os.
 *
 * Everything else this app does is a read. That asymmetry is the whole
 * "filesystem is the API" guarantee: uninstall Sasha Desktop and your AI-OS is
 * byte-for-byte what it was, minus a few aggregate counts you opted into.
 *
 * Three rules carried verbatim from the Core convention:
 *
 *  1. COUNTS ONLY, NEVER CONTENT. No path, no filename, no headline, no workspace
 *     name — an event is a timestamp and an event name. The counter file must stay
 *     safe to read, share, or paste.
 *
 *  2. ONLY IF IT ALREADY EXISTS. Core says "if a counter file ~/ai-os/.aios-usage.jsonl
 *     exists, append…". DESK never creates it. A user who has not opted into counting
 *     does not get opted in by installing a GUI.
 *
 *  3. USER ACTIONS ONLY. We write `proposal_accepted` and `proposal_dismissed` —
 *     things the person actually did. We deliberately do NOT write `proposal_surfaced`:
 *     the CLI doorbell already owns that event, and a second surface writing it would
 *     inflate the denominator ACCEL-4's trust ledger divides by. Two surfaces, one
 *     count.
 */

export type UsageEvent = 'proposal_accepted' | 'proposal_dismissed'

export function recordUsage(usagePath: string, event: UsageEvent, now: Date): void {
  // Rule 2: never create the file.
  if (!existsSync(usagePath)) return

  // Rule 1: timestamp and event name. Nothing else is permitted in this object.
  const line = JSON.stringify({ ts: now.toISOString(), event }) + '\n'
  try {
    appendFileSync(usagePath, line, 'utf8')
  } catch {
    // A counter is telemetry for the user's own benefit; failing to write one must
    // never break the thing they actually asked for.
  }
}
