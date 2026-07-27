import { listOllamaModels } from './ollama-backend.js'
import type { ModelChoice } from './protocol.js'

/**
 * What can answer you right now.
 *
 * The list is built from what is actually on this machine, not from a hardcoded
 * vendor menu: Claude aliases when Claude Code is installed, plus every model Ollama
 * currently has pulled. If Ollama is not running you simply do not see local options
 * — no greyed-out upsell for something you have not installed.
 */

/**
 * Claude Code resolves these aliases to the current model itself, which is why we
 * pass the alias through rather than pinning a dated model id that would rot here.
 */
const CLAUDE_ALIASES: { model: string; label: string; detail: string }[] = [
  { model: 'fable', label: 'Claude Fable 5', detail: 'Most capable — hard reasoning and long tool use' },
  { model: 'opus', label: 'Claude Opus 5', detail: 'Strong general work' },
  { model: 'sonnet', label: 'Claude Sonnet 5', detail: 'Fast and capable — a good default' },
  { model: 'haiku', label: 'Claude Haiku 4.5', detail: 'Quickest and cheapest' },
]

export async function availableModels(harnessFound: boolean): Promise<ModelChoice[]> {
  const choices: ModelChoice[] = []

  if (harnessFound) {
    for (const alias of CLAUDE_ALIASES) {
      choices.push({
        id: `claude:${alias.model}`,
        label: alias.label,
        provider: 'claude',
        detail: `${alias.detail} · your Claude Code login`,
        local: false,
      })
    }
  }

  for (const name of await listOllamaModels()) {
    choices.push({
      id: `ollama:${name}`,
      label: name,
      provider: 'ollama',
      // Local models now run through Claude Code via the loopback bridge, so they get
      // the same system prompt, tools, skills and memory. What differs is the weights
      // — and how well a smaller model actually USES a large tool surface.
      detail: 'Runs on this machine — same tools and skills, nothing leaves the box',
      local: true,
    })
  }

  return choices
}

/**
 * Pick a sensible starting model: the user's last choice if it is still available,
 * otherwise the first Claude option, otherwise the first local one. Returns null when
 * there is genuinely nothing — which the UI must say plainly rather than hiding.
 */
export function defaultModel(choices: ModelChoice[], remembered?: string): string | null {
  if (remembered && choices.some((choice) => choice.id === remembered)) return remembered
  const sonnet = choices.find((choice) => choice.id === 'claude:sonnet')
  if (sonnet) return sonnet.id
  return choices[0]?.id ?? null
}
