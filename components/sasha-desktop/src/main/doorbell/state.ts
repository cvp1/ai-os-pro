import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '../types.js'

/**
 * DESK's own memory — what it has already shown you, and what you waved off.
 *
 * This lives in the app's own userData directory, NOT in ~/ai-os. The reason is the
 * filesystem-as-API guarantee: ~/ai-os belongs to AI-OS, and a GUI's private
 * bookkeeping is not an AI-OS concept. Delete this file and nothing is lost except
 * DESK's manners — you may see one bell you had already dismissed.
 *
 * "Never raise that same one again" is the Core doorbell's rule, so it needs durable
 * storage; keying on the proposal's path (not its contents) means editing a draft
 * does not resurrect a dismissal.
 */

export interface DeskState {
  /** id → ISO timestamp it was waved off. These never ring again. */
  dismissed: Record<string, string>
  /** id → ISO timestamp we last rang for it. Edge-trigger: ring on change, not on poll. */
  notified: Record<string, string>
  settings: Settings
}

const EMPTY: DeskState = { dismissed: {}, notified: {}, settings: DEFAULT_SETTINGS }

/** Bound the memory — a workspace churning proposals must not grow this file forever. */
const MAX_REMEMBERED = 1000

export function statePath(userDataDir: string): string {
  return join(userDataDir, 'desk-state.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function coerceStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function coerceSettings(value: unknown): Settings {
  if (!isRecord(value)) return DEFAULT_SETTINGS
  const quiet = isRecord(value.quietHours) ? value.quietHours : {}
  const hour = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23 ? v : fallback
  return {
    notifications: typeof value.notifications === 'boolean' ? value.notifications : DEFAULT_SETTINGS.notifications,
    quietHours: {
      enabled: typeof quiet.enabled === 'boolean' ? quiet.enabled : DEFAULT_SETTINGS.quietHours.enabled,
      startHour: hour(quiet.startHour, DEFAULT_SETTINGS.quietHours.startHour),
      endHour: hour(quiet.endHour, DEFAULT_SETTINGS.quietHours.endHour),
    },
  }
}

/**
 * Read state, degrading toward safety: a missing or corrupt file resolves to
 * defaults (quiet hours ON, notifications ON) rather than to an undefined posture.
 */
export function loadState(path: string): DeskState {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { ...EMPTY, settings: { ...DEFAULT_SETTINGS } }
  }
  if (!isRecord(parsed)) return { ...EMPTY, settings: { ...DEFAULT_SETTINGS } }
  return {
    dismissed: coerceStringMap(parsed.dismissed),
    notified: coerceStringMap(parsed.notified),
    settings: coerceSettings(parsed.settings),
  }
}

/** Keep only the newest N entries of a map, by ISO timestamp value. */
function trim(map: Record<string, string>): Record<string, string> {
  const entries = Object.entries(map)
  if (entries.length <= MAX_REMEMBERED) return map
  entries.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
  return Object.fromEntries(entries.slice(0, MAX_REMEMBERED))
}

/** Write atomically — a crash mid-write must not leave an unreadable state file. */
export function saveState(path: string, state: DeskState): void {
  const payload: DeskState = {
    dismissed: trim(state.dismissed),
    notified: trim(state.notified),
    settings: state.settings,
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.tmp`
    writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(temp, path)
  } catch {
    // Losing manners is survivable; crashing over it is not.
  }
}
