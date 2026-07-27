import type { QuietHours } from './types.js'

/**
 * Quiet hours — the sleep invariant, productized.
 *
 * During the window the app stays SILENT: no OS notification fires. Items are not
 * dropped, they queue and appear in the window whenever the user next opens it, and
 * the bell may ring for them after the window ends. Silence here is a delay, never
 * a loss.
 *
 * Windows that wrap midnight (the normal case — 21:00 to 05:00) are the reason this
 * is a function and not a comparison.
 */
export function isQuiet(quiet: QuietHours, now: Date): boolean {
  if (!quiet.enabled) return false

  const { startHour, endHour } = quiet
  if (startHour === endHour) return false

  const hour = now.getHours()
  if (startHour < endHour) {
    // Same-day window, e.g. 01:00–06:00.
    return hour >= startHour && hour < endHour
  }
  // Wrapping window, e.g. 21:00–05:00: quiet if we're past the start OR before the end.
  return hour >= startHour || hour < endHour
}

/** Human-readable window, for the tray tooltip and settings line. */
export function describeQuietHours(quiet: QuietHours): string {
  if (!quiet.enabled) return 'off'
  const fmt = (h: number) => {
    const suffix = h < 12 ? 'am' : 'pm'
    const twelve = h % 12 === 0 ? 12 : h % 12
    return `${twelve}${suffix}`
  }
  return `${fmt(quiet.startHour)}–${fmt(quiet.endHour)}`
}
