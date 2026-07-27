/**
 * The wire protocol Sasha Desktop speaks to a harness.
 *
 * This is deliberately NOT the Claude Code stream-json shape. It is a small neutral
 * vocabulary that every backend maps onto: Claude Code today, local Ollama beside it,
 * whatever comes next. Model-agnostic has to mean something structural, not a
 * dropdown that only ever changes one vendor's flag — so the renderer never sees a
 * vendor's message format, and adding a provider means writing one adapter rather
 * than touching the UI.
 */

/** What the user sees streaming into the transcript. */
export type SessionEvent =
  /** The backend is up; the session has an id we can resume later. */
  | { kind: 'ready'; sessionId: string; model: string; tools: string[]; cwd: string }
  /** A chunk of visible answer text. */
  | { kind: 'text'; text: string }
  /** A chunk of reasoning, rendered separately and collapsed by default. */
  | { kind: 'thinking'; text: string }
  /** The assistant is calling a tool — shown so the user can see what it is doing. */
  | { kind: 'tool'; name: string; summary: string; id: string }
  /** A tool finished. */
  | { kind: 'tool-result'; id: string; ok: boolean; summary: string }
  /** One assistant turn is complete. */
  | { kind: 'turn-end'; costUsd?: number; durationMs?: number; inputTokens?: number; outputTokens?: number }
  /** Something went wrong, in words a person can act on. */
  | { kind: 'error'; message: string }
  /** The backend process ended. */
  | { kind: 'closed'; code: number | null }
  /** Free-form status from the harness (hooks, rate limits) — shown in the status line. */
  | { kind: 'status'; text: string }

export interface Backend {
  /** Stable id for the UI and for `--resume`. */
  readonly id: string
  /** Human label shown in the picker, e.g. "Claude Fable 5" or "gemma4-e4b (local)". */
  readonly label: string
  /** Send one user message. Resolves when it has been handed to the harness. */
  send(text: string): Promise<void>
  /** Stop the current turn without killing the session, where the backend allows it. */
  interrupt(): void
  /** Tear the session down. */
  close(): void
  /** Subscribe to the event stream. */
  onEvent(listener: (event: SessionEvent) => void): void
}

/** A model the user can pick, from whichever backend provides it. */
export interface ModelChoice {
  /** Backend-scoped identifier, e.g. `claude:fable` or `ollama:gemma4-e4b-agent-64k`. */
  id: string
  label: string
  provider: 'claude' | 'ollama'
  /** Shown under the label — where this model actually runs. */
  detail: string
  /** True when inference happens entirely on this machine. */
  local: boolean
}

/** Split `claude:fable` into its parts. */
export function parseModelId(id: string): { provider: string; model: string } {
  const index = id.indexOf(':')
  if (index === -1) return { provider: 'claude', model: id }
  return { provider: id.slice(0, index), model: id.slice(index + 1) }
}
