import { ClaudeBackend } from './claude-backend.js'
import { OpencodeBackend } from './opencode-backend.js'
import { parseModelId, type Backend, type ModelChoice, type SessionEvent } from './protocol.js'
import type { LocalState } from '../aios/local.js'

/**
 * Holds the one live conversation and swaps the model under it.
 *
 * TWO ENGINES, both spawned binaries: Claude Code for the Claude models, opencode for
 * the user's own local ones. Neither is a thing we wrote, and that is the design —
 * the app is a window, not a harness.
 *
 * The history matters, because the local path here is the SECOND attempt. v0.3 served
 * local models through an Anthropic→Ollama bridge of our own so Claude Code could
 * drive them with its full prompt stack. It FAILED its pre-stated gate on 2026-07-27
 * (two live trials, gemma4-e4b, 1/2 task completion against a bar of 2/2) and was
 * deleted per that falsifier rather than patched until green. The control run
 * afterwards is what redeemed the idea without redeeming the code: a native opencode
 * arm scored the SAME 1/2 on the same task and model, at roughly half the wall time.
 * The limit was the model tier; the bridge was just the expensive way to reach it. So
 * local models return through the harness that was already gate-passed for the job,
 * and the bridge stays deleted. History: `git log -- '*anthropic-bridge*'`.
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
    private local: LocalState = { ready: false, ollamaUrl: '', models: [] },
  ) {}

  /** Local availability is discovered asynchronously; keep it current. */
  setLocal(local: LocalState): void {
    this.local = local
  }

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
      if (!this.local.ready || !this.local.opencodePath) {
        this.emit({
          kind: 'error',
          message:
            this.local.problem ??
            'Local models are not available on this machine right now.',
        })
        return
      }
      const label = choices.find((choice) => choice.id === modelId)?.label ?? model
      this.backend = new OpencodeBackend({
        binary: this.local.opencodePath,
        cwd: this.cwd,
        // opencode wants provider/model; our ids are provider-scoped already.
        model: `ollama/${model}`,
        label,
        ollamaUrl: this.local.ollamaUrl,
      })
      this.backend.onEvent((event) => this.emit(event))
      // Said once, at the moment of switching, rather than buried in a panel: the
      // user is about to talk to something that is genuinely NOT Sasha, and the
      // difference is the whole reason the Claude option exists.
      this.emit({
        kind: 'status',
        text:
          `${label} runs on your own hardware — but it is not Sasha: no skills, no ` +
          'memory, no AI-OS instructions. It can read and search your files; it cannot ' +
          'change them. Small local models are also wrong more often, so check anything ' +
          'that matters.',
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
