import type { ModelChoice } from './protocol.js'

/**
 * What can answer you right now: the Claude aliases, through the user's own
 * Claude Code login. Aliases rather than dated model ids — Claude Code resolves
 * them itself, so nothing rots here.
 *
 * No local models are listed. The bridge that served them failed its pre-stated
 * reliability gate on 2026-07-27 and was deleted (see session/manager.ts for the
 * full record); listing models this app can no longer drive would be a menu of
 * broken promises. The local path is opencode.
 */
const CLAUDE_ALIASES: { model: string; label: string; detail: string }[] = [
  { model: 'fable', label: 'Claude Fable 5', detail: 'Most capable — hard reasoning and long tool use' },
  { model: 'opus', label: 'Claude Opus 5', detail: 'Strong general work' },
  { model: 'sonnet', label: 'Claude Sonnet 5', detail: 'Fast and capable — a good default' },
  { model: 'haiku', label: 'Claude Haiku 4.5', detail: 'Quickest and cheapest' },
]

export async function availableModels(harnessFound: boolean): Promise<ModelChoice[]> {
  if (!harnessFound) return []
  return CLAUDE_ALIASES.map((alias) => ({
    id: `claude:${alias.model}`,
    label: alias.label,
    provider: 'claude' as const,
    detail: `${alias.detail} · your Claude Code login`,
    local: false,
  }))
}

/**
 * Pick a sensible starting model: the user's last choice if it is still available,
 * otherwise Sonnet, otherwise the first option. Returns null when there is genuinely
 * nothing — which the UI must say plainly rather than hiding.
 */
export function defaultModel(choices: ModelChoice[], remembered?: string): string | null {
  if (remembered && choices.some((choice) => choice.id === remembered)) return remembered
  const sonnet = choices.find((choice) => choice.id === 'claude:sonnet')
  if (sonnet) return sonnet.id
  return choices[0]?.id ?? null
}
