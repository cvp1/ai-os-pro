import { join } from 'node:path'
import { readProposals } from './proposals.js'
import { readDeadJobs } from './heartbeat.js'
import type { DeskState } from './state.js'
import type { BellItem } from '../types.js'

/**
 * The doorbell.
 *
 * Core's session-open bell rings when you show up. DESK's rings when the thing
 * happens — that is the one physics change the desktop surface buys, and it is the
 * entire reason this component exists (D71). Every other discipline that made the
 * bell safe is carried over verbatim:
 *
 *   · AT MOST ONE item — never a list, never a digest, never a feed.
 *   · SILENCE IS THE DEFAULT — no "all quiet", no heartbeat ping, no daily summary.
 *     A bell that rings every day is a bell you stop hearing.
 *   · NEVER RE-RAISE A DISMISSAL — waved off once is waved off forever.
 *   · EDGE-TRIGGERED — ring on change, not on poll. Polling every 30s must not
 *     produce a notification every 30s.
 *   · QUIET HOURS WIN — inside the window nothing rings; items wait, they are not lost.
 */

export interface Scan {
  /** Everything currently waiting, dismissals already removed, best-first. */
  items: BellItem[]
  /** The single item worth ringing for right now, if any. */
  bell: BellItem | null
}

/**
 * Rank by PUSH-1's classes: "something is broken" outranks "something is waiting".
 * A job that died silently is costing the user something right now; a staged draft
 * is patiently doing no harm.
 */
function rank(item: BellItem): number {
  return item.kind === 'dead-job' ? 0 : 1
}

function bestFirst(a: BellItem, b: BellItem): number {
  const byKind = rank(a) - rank(b)
  if (byKind !== 0) return byKind
  return Date.parse(b.at) - Date.parse(a.at)
}

/** Everything waiting right now, minus anything the user has waved off. */
export function collect(root: string, now: Date): BellItem[] {
  const heartbeatPath = join(root, '.aios-heartbeat.jsonl')
  const items = [...readDeadJobs(heartbeatPath, now), ...readProposals(root)]
  items.sort(bestFirst)
  return items
}

/**
 * Decide what — if anything — to ring for.
 *
 * Returns null when there is nothing new, which is the normal case and the whole point.
 *
 * ONE OUTSTANDING BELL AT A TIME. Two rules combine here, and the second one is the
 * subtle one:
 *
 *  · Edge-trigger: an item already rung for is still in `items` (it is still waiting,
 *    and the window should show it) but it does not ring again.
 *
 *  · No queue-draining: if ANY rung item is still sitting there unhandled, nothing
 *    new rings either. Without this, three waiting items on a 30-second poll produce
 *    three notifications in 90 seconds — technically "one item each" and exactly the
 *    burst the doctrine forbids. The bell's message is "something needs you", not
 *    "here is item 2 of 3"; repeating it before you have dealt with the first one
 *    adds no information and spends the attention that makes it work.
 *
 * Handle the outstanding item — open it or wave it off — and the next arrival rings.
 */
export function scan(root: string, state: DeskState, now: Date): Scan {
  const items = collect(root, now).filter((item) => !(item.id in state.dismissed))

  const outstanding = items.some((item) => item.id in state.notified)
  if (outstanding) return { items, bell: null }

  const unrung = items.filter((item) => !(item.id in state.notified))
  return { items, bell: unrung[0] ?? null }
}
