import { ClaudeBackend } from './claude-backend.js'
import { OllamaBackend } from './ollama-backend.js'
import { parseModelId, type Backend, type ModelChoice, type SessionEvent } from './protocol.js'

/**
 * Holds the one live conversation and swaps the model under it.
 *
 * Switching models ends the current backend and starts the next. That is honest
 * rather than clever: a Claude Code session and a local Ollama session do not share
 * state, and pretending otherwise — silently replaying a transcript into a different
 * model as if nothing happened — would make the model picker lie about what the
 * new model has actually seen. The UI says the switch happened; the transcript stays
 * on screen as history.
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
  select(modelId: string, choices: ModelChoice[]): void {
    if (this.currentModelId === modelId && this.backend) return

    this.backend?.close()
    this.backend = null
    this.currentModelId = modelId

    const { provider, model } = parseModelId(modelId)

    if (provider === 'ollama') {
      this.backend = new OllamaBackend(model)
    } else {
      if (!this.harnessPath) {
        this.emit({
          kind: 'error',
          message:
            'Claude Code is not installed, so Claude models are unavailable. Local ' +
            'models still work if Ollama is running.',
        })
        return
      }
      const label = choices.find((choice) => choice.id === modelId)?.label ?? model
      this.backend = new ClaudeBackend(this.harnessPath, this.cwd, model, this.permissionMode, label)
    }

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
