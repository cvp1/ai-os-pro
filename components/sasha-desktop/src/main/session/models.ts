import type { ModelChoice } from './protocol.js'
import type { LocalState } from '../aios/local.js'

/**
 * What can answer you right now.
 *
 * Two real providers, listed side by side: the Claude aliases through the user's own
 * Claude Code login, and whatever models their own Ollama holds, driven by opencode.
 * Aliases rather than dated model ids on the Claude side — Claude Code resolves them
 * itself, so nothing rots here.
 *
 * Local models are back (v0.5) by a different road than the one that failed. v0.3
 * tried to make Claude Code drive local weights through a bridge we wrote; it failed
 * its gate and was deleted. The control run then showed a native opencode arm scoring
 * identically on the same model — the tier was the limit, not the transport — so the
 * local path is now opencode, spawned like any other binary. See opencode-backend.ts.
 *
 * The detail lines carry the difference in capability rather than hiding it: a Claude
 * session is Sasha, with the prompt stack, skills and memory; a local session is a
 * capable agent that can read your files and does not have any of that.
 */
const CLAUDE_ALIASES: { model: string; label: string; detail: string }[] = [
  { model: 'fable', label: 'Claude Fable 5', detail: 'Most capable — hard reasoning and long tool use' },
  { model: 'opus', label: 'Claude Opus 5', detail: 'Strong general work' },
  { model: 'sonnet', label: 'Claude Sonnet 5', detail: 'Fast and capable — a good default' },
  { model: 'haiku', label: 'Claude Haiku 4.5', detail: 'Quickest and cheapest' },
]

/** `gemma3n:e4b` → `gemma3n` reads better in a dropdown than the full tag. */
function prettyLocal(tag: string): string {
  const base = tag.split(':')[0] ?? tag
  return base.replace(/[-_]/g, ' ')
}

export function claudeModels(harnessFound: boolean): ModelChoice[] {
  if (!harnessFound) return []
  return CLAUDE_ALIASES.map((alias) => ({
    id: `claude:${alias.model}`,
    label: alias.label,
    provider: 'claude' as const,
    detail: `${alias.detail} · your Claude Code login`,
    local: false,
  }))
}

export function localModels(local: LocalState): ModelChoice[] {
  if (!local.ready) return []
  return local.models.map((tag) => ({
    id: `ollama:${tag}`,
    label: `${prettyLocal(tag)} (local)`,
    provider: 'ollama' as const,
    // Says "can change" rather than "reads only" because that is the truth of the
    // configuration that actually runs — a read-only posture was attempted four ways
    // and every one hung the binary (opencode-backend.ts records the shapes). The
    // picker must describe the session the user is about to get, not the one intended.
    detail: 'Runs on your own hardware · can read and change files in your workspace',
    local: true,
  }))
}

export function availableModels(harnessFound: boolean, local: LocalState): ModelChoice[] {
  return [...claudeModels(harnessFound), ...localModels(local)]
}

/**
 * Pick a sensible starting model: the user's last choice if it is still available,
 * otherwise Sonnet, otherwise the first option. Returns null when there is genuinely
 * nothing — which the UI must say plainly rather than hiding.
 *
 * Note the default prefers a Claude model even when a local one exists. That is not a
 * thumb on the scale for the cloud: it is the model that can actually be Sasha, and a
 * first-run user who has not chosen yet should meet the product at its full strength.
 * Choosing local is one click, and the choice is remembered.
 */
export function defaultModel(choices: ModelChoice[], remembered?: string): string | null {
  if (remembered && choices.some((choice) => choice.id === remembered)) return remembered
  const sonnet = choices.find((choice) => choice.id === 'claude:sonnet')
  if (sonnet) return sonnet.id
  return choices[0]?.id ?? null
}
