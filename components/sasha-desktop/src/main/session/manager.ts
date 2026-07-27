import { ClaudeBackend } from './claude-backend.js'
import { parseModelId, type Backend, type ModelChoice, type SessionEvent } from './protocol.js'

/**
 * Holds the one live conversation and swaps the model under it.
 *
 * Claude Code is the only engine. Local models were served for two days by an
 * Anthropic→Ollama bridge (v0.3); it FAILED its pre-stated gate on 2026-07-27 —
 * two live trials on dogma-2 against gemma4-e4b, 1/2 task completion where the
 * bar was 2/2 — and was deleted per that falsifier, not patched until green.
 * The honest record: the protocol translation itself held (11 multi-turn tool
 * round-trips, one trial 4/4), but 50% task reliability is not a shippable
 * surface whoever's fault it is. The local path belongs to opencode (gate-passed
 * co-equal harness, LOCAL_FLEET.md §4s); it returns HERE only behind a new gate,
 * with a stronger local model or the portability work that lets another harness
 * carry Sasha's context. History: `git log -- '*anthropic-bridge*'`.
 *
 * Switching models ends the current backend and starts the next. That is honest
 * rather than clever: sessions do not transfer between models, and silently
 * replaying a transcript into a model that never saw it would make the picker lie
 * about what the new model knows. The UI says the switch happened; the transcript
 * stays as history.
 */
export class SessionManager {
  private backend: Backend | null = null
  private listeners: ((event: SessionEvent) => void)[] = []
  private currentModelId: string | null = null

  constructor(
    private readonly harnessPath: string | undefined,
    private readonly cwd: string,
    private readonly permissionMode: string,
  ) {}

  onEvent(listener: (event: SessionEvent) => void): void {
    this.listeners.push(listener)
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  get modelId(): string | null {
    return this.currentModelId
  }

  /** Point the session at a model, tearing down whatever was running. */
  async select(modelId: string, choices: ModelChoice[]): Promise<void> {
    if (this.currentModelId === modelId && this.backend) return

    this.backend?.close()
    this.backend = null
    this.currentModelId = modelId

    const { provider, model } = parseModelId(modelId)

    if (provider === 'ollama') {
      // Not silently ignored and not half-supported: say what happened and where
      // the local path lives now.
      this.emit({
        kind: 'error',
        message:
          'Local models are no longer served by this app — the bridge that carried ' +
          'them failed its reliability gate (1/2 task completion, bar was 2/2) and ' +
          'was removed rather than shipped flaky. For a local agent, use opencode ' +
          'with your Ollama models; Sasha herself stays on Claude Code here.',
      })
      return
    }

    if (!this.harnessPath) {
      this.emit({
        kind: 'error',
        message:
          'Claude Code is not installed. Install it and reopen this window — Sasha ' +
          'Desktop is a window onto your own Claude Code, not a replacement for it.',
      })
      return
    }

    const label = choices.find((choice) => choice.id === modelId)?.label ?? model
    this.backend = new ClaudeBackend(this.harnessPath, this.cwd, model, this.permissionMode, label)
    this.backend.onEvent((event) => this.emit(event))
  }

  async send(text: string): Promise<boolean> {
    if (!this.backend) {
      this.emit({ kind: 'error', message: 'Pick a model first — nothing is selected.' })
      return false
    }
    try {
      await this.backend.send(text)
      return true
    } catch (error) {
      this.emit({
        kind: 'error',
        message: error instanceof Error ? error.message : 'The message could not be sent.',
      })
      return false
    }
  }

  interrupt(): void {
    this.backend?.interrupt()
  }

  close(): void {
    this.backend?.close()
    this.backend = null
  }
}
