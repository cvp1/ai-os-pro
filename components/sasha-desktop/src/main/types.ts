/** The wire shape between main and renderer. Kept deliberately small. */

/** One thing worth the user's attention. At most one is ever notified at a time. */
export interface BellItem {
  /**
   * Stable identity across runs — this is what "never raise that same one again"
   * is keyed on. For a proposal: its path relative to the AI-OS root (so editing
   * the file does not resurrect a dismissal). For a dead job: `heartbeat:<job>`.
   */
  id: string
  kind: 'proposal' | 'dead-job'
  /** One plain line, in the Core doorbell's voice. This is what the user sees first. */
  headline: string
  /** Absolute path to the artifact, when there is one to open. */
  path?: string
  /** ISO timestamp the item became relevant (proposal mtime / last heartbeat). */
  at: string
  /** Longer context shown on the card, never in the notification. */
  detail?: string
}

export interface InstallState {
  found: boolean
  root?: string
  /** Build stamp from the installed prompt, when discoverable. */
  build?: string
  /** What is missing, in plain words, when found === false. */
  problem?: string
}

export interface HarnessState {
  found: boolean
  path?: string
  version?: string
  problem?: string
}

export interface QuietHours {
  enabled: boolean
  /** Local wall-clock hour, 0–23. Default 21 (9pm) — the sleep invariant. */
  startHour: number
  /** Local wall-clock hour, 0–23. Default 5 (5am). */
  endHour: number
}

export interface Settings {
  notifications: boolean
  quietHours: QuietHours
}

export interface DoctorResult {
  ok: boolean
  /** Raw text from the harness — rendered as-is, never parsed for meaning. */
  output: string
  ranAt: string
  problem?: string
}

export const DEFAULT_SETTINGS: Settings = {
  notifications: true,
  // 9pm–5am, on by default. Craig's sleep window ships as everyone's default:
  // a system that respects sleep without being asked is the product's posture.
  quietHours: { enabled: true, startHour: 21, endHour: 5 },
}
