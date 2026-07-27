import { ClaudeBackend } from './claude-backend.js'
import { startAnthropicBridge, BRIDGE_HOST, type BridgeHandle } from './anthropic-bridge.js'
import { parseModelId, type Backend, type ModelChoice, type SessionEvent } from './protocol.js'

/**
 * Holds the one live conversation and swaps the model under it.
 *
 * BOTH providers now run through Claude Code. That is the important design decision
 * here, and it is what gives a local model a brain: instead of talking to Ollama's
 * bare completion endpoint — no system prompt, no tools, no memory, no loop — we
 * start a loopback bridge that speaks the Anthropic Messages API, point Claude Code
 * at it with ANTHROPIC_BASE_URL, and let the harness do what it is good at.
 *
 * So a local model gets the same system prompt, the same tools, the same skills and
 * the same memory as Claude does. The only difference is which weights answer.
 *
 * Switching models ends the current backend and starts the next. That is honest
 * rather than clever: sessions do not transfer between models, and silently replaying
 * a transcript into a model that never saw it would make the picker lie about what
 * the new model knows. The UI says the switch happened; the transcript stays as
 * history.
 */
export class SessionManager {
  private backend: Backend | null = null
  private bridge: BridgeHandle | null = null
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

  private teardown(): void {
    this.backend?.close()
    this.backend = null
    this.bridge?.close()
    this.bridge = null
  }

  /** Point the session at a model, tearing down whatever was running. */
  async select(modelId: string, choices: ModelChoice[]): Promise<void> {
    if (this.currentModelId === modelId && this.backend) return

    this.teardown()
    this.currentModelId = modelId

    const { provider, model } = parseModelId(modelId)
    const label = choices.find((choice) => choice.id === modelId)?.label ?? model

    if (!this.harnessPath) {
      this.emit({
        kind: 'error',
        message:
          'Claude Code is not installed. Sasha Desktop uses it as the engine for every ' +
          'model — including local ones — so that a local model gets the same tools, ' +
          'skills and memory. Install Claude Code and reopen this window.',
      })
      return
    }

    const env: Record<string, string> = {}

    if (provider === 'ollama') {
      try {
        this.bridge = await startAnthropicBridge((message) =>
          this.emit({ kind: 'status', text: message }),
        )
        // Claude Code talks to the bridge as if it were Anthropic; the bridge talks
        // to Ollama. The token is required by the client but never leaves loopback.
        env.ANTHROPIC_BASE_URL = `http://${BRIDGE_HOST}:${this.bridge.port}`
        env.ANTHROPIC_AUTH_TOKEN = 'local-bridge'
        env.ANTHROPIC_MODEL = model
        // Do not let a stale key or a cloud login preempt the local endpoint.
        env.ANTHROPIC_API_KEY = ''
      } catch (error) {
        this.emit({
          kind: 'error',
          message:
            'Could not start the local-model bridge: ' +
            (error instanceof Error ? error.message : String(error)),
        })
        return
      }
    }

    this.backend = new ClaudeBackend(
      this.harnessPath,
      this.cwd,
      model,
      this.permissionMode,
      label,
      env,
    )
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
    this.teardown()
  }
}
