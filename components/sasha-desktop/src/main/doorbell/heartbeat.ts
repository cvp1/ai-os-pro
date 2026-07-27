import { readFileSync } from 'node:fs'
import type { BellItem } from '../types.js'

/**
 * Heartbeat reading — "did a scheduled check-in go silently dead?"
 *
 * Reads the shipped Core convention verbatim (`core/second-act/projects.txt`):
 *   {"ts":"<ISO>","job":"projects-checkin","status":"ok","every":"7d","note":"..."}
 *
 * A job is dead when it has been silent for more than half again its own cadence —
 * a "7d" job silent past ~10 days. That threshold is the Core doorbell's, not ours;
 * DESK is a second surface for the same rule, never a second rule.
 */

const DEAD_MULTIPLIER = 1.5

/** Bound the read: heartbeats are append-only and we only need the latest per job. */
const MAX_LINES = 2000

const UNITS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

/**
 * Parse a cadence string ("7d", "24h", "30m") to milliseconds.
 * Returns null for anything unrecognised — an unknown cadence means we cannot
 * judge liveness, which is NOT the same as knowing the job is dead.
 */
export function parseCadence(every: unknown): number | null {
  if (typeof every !== 'string') return null
  const match = /^\s*(\d+(?:\.\d+)?)\s*([mhdw])\s*$/i.exec(every)
  if (!match) return null
  const value = Number(match[1])
  const unit = UNITS[match[2]!.toLowerCase()]
  if (!Number.isFinite(value) || value <= 0 || unit === undefined) return null
  return value * unit
}

export interface HeartbeatRecord {
  job: string
  ts: string
  status?: string
  every?: string
  note?: string
}

/**
 * Is this job overdue by more than half again its cadence?
 * Unknown cadence or unparseable timestamp → false. We never report a job dead on
 * evidence we could not read; a silent instrument is not a silent job.
 */
export function isDead(record: HeartbeatRecord, now: Date): boolean {
  const cadence = parseCadence(record.every)
  if (cadence === null) return false
  const last = Date.parse(record.ts)
  if (!Number.isFinite(last)) return false
  return now.getTime() - last > cadence * DEAD_MULTIPLIER
}

/** Keep only the most recent record per job. */
export function latestPerJob(records: HeartbeatRecord[]): Map<string, HeartbeatRecord> {
  const latest = new Map<string, HeartbeatRecord>()
  for (const record of records) {
    const previous = latest.get(record.job)
    if (!previous || Date.parse(record.ts) >= Date.parse(previous.ts)) {
      latest.set(record.job, record)
    }
  }
  return latest
}

/** Parse JSONL text; malformed lines are skipped, never fatal. */
export function parseHeartbeatLines(text: string): HeartbeatRecord[] {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const recent = lines.slice(-MAX_LINES)
  const records: HeartbeatRecord[] = []
  for (const line of recent) {
    try {
      const parsed: unknown = JSON.parse(line)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as HeartbeatRecord).job === 'string' &&
        typeof (parsed as HeartbeatRecord).ts === 'string'
      ) {
        records.push(parsed as HeartbeatRecord)
      }
    } catch {
      // A corrupt line is a corrupt line, not an outage. Skip it.
    }
  }
  return records
}

function daysSince(ts: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(ts)) / 86_400_000)
}

/** Read the heartbeat file and return one BellItem per dead job. */
export function readDeadJobs(heartbeatPath: string, now: Date): BellItem[] {
  let text: string
  try {
    text = readFileSync(heartbeatPath, 'utf8')
  } catch {
    // No heartbeat file means nothing has ever scheduled itself. Not a problem.
    return []
  }

  const latest = latestPerJob(parseHeartbeatLines(text))
  const dead: BellItem[] = []

  for (const record of latest.values()) {
    if (!isDead(record, now)) continue
    const days = daysSince(record.ts, now)
    // "hasn't run in 30 days" reads better than "since 30 days ago"; under a day,
    // name the date instead of saying "in 0 days".
    const elapsed =
      days >= 2 ? `in ${days} days` : `since ${new Date(record.ts).toLocaleDateString()}`
    const lastRun = days >= 2 ? `${days} days ago` : new Date(record.ts).toLocaleDateString()

    dead.push({
      id: `heartbeat:${record.job}`,
      // Job names are already noun-shaped ("projects-checkin"), so no suffix — adding
      // "check-in" produced "projects-checkin check-in".
      kind: 'dead-job',
      headline: `Your ${record.job} hasn't run ${elapsed} — it may have stopped.`,
      at: record.ts,
      detail:
        `Expected about every ${record.every}. Last run ${lastRun}` +
        (record.status && record.status !== 'ok' ? `, reporting "${record.status}"` : '') +
        `.${record.note ? ` Last note: ${record.note}` : ''}`,
    })
  }

  return dead
}
