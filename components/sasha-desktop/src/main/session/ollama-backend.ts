import { request } from 'node:http'
import type { Backend, SessionEvent } from './protocol.js'

/**
 * The local-model backend — Ollama, on this machine only.
 *
 * THIS IS THE ONLY FILE IN THE APP PERMITTED TO OPEN A SOCKET, and `audit:surface`
 * enforces that by name. The reason it is allowed here is narrow and worth stating:
 * running a model locally requires talking to the local model server. That is not
 * telemetry and it is not a gateway — no byte leaves the machine.
 *
 * The guarantee is kept honest by `assertLoopback` below, which is applied to every
 * request and refuses anything that is not 127.0.0.1 / ::1 / localhost. A
 * configuration mistake, or a future edit that tried to point this at a hosted
 * endpoint, fails loudly instead of quietly shipping the user's prompts off-box.
 *
 * Claude Code is the other backend. Between them, "model agnostic" means a real
 * choice — a frontier model, or one that never leaves your desk.
 */

export const OLLAMA_HOST = '127.0.0.1'
export const OLLAMA_PORT = 11434

/** Hosts that provably cannot leave this machine. */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

/**
 * Refuse any non-loopback destination. Exported so a test can prove the guard bites
 * rather than trusting that it is spelled correctly.
 */
export function assertLoopback(host: string): void {
  if (!LOOPBACK.has(host)) {
    throw new Error(
      `Sasha Desktop refuses to send a prompt to "${host}". The local-model backend ` +
        'may only talk to this machine — that is the whole point of it.',
    )
  }
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/** List locally-installed models. Returns [] when Ollama is not running. */
export function listOllamaModels(timeoutMs = 1500): Promise<string[]> {
  return new Promise((resolve) => {
    assertLoopback(OLLAMA_HOST)
    const req = request(
      { host: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/tags', method: 'GET', timeout: timeoutMs },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { models?: { name?: string }[] }
            resolve((parsed.models ?? []).map((m) => m.name).filter((n): n is string => !!n))
          } catch {
            resolve([])
          }
        })
      },
    )
    req.on('error', () => resolve([]))
    req.on('timeout', () => {
      req.destroy()
      resolve([])
    })
    req.end()
  })
}

export class OllamaBackend implements Backend {
  readonly id: string
  readonly label: string

  private listeners: ((event: SessionEvent) => void)[] = []
  private history: ChatMessage[] = []
  private active: ReturnType<typeof request> | null = null

  constructor(private readonly model: string) {
    this.id = `ollama:${model}`
    this.label = `${model} (local)`
  }

  onEvent(listener: (event: SessionEvent) => void): void {
    this.listeners.push(listener)
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  async send(text: string): Promise<void> {
    assertLoopback(OLLAMA_HOST)
    this.history.push({ role: 'user', content: text })

    const payload = JSON.stringify({ model: this.model, messages: this.history, stream: true })
    const started = Date.now()
    let answer = ''

    this.emit({
      kind: 'ready',
      sessionId: this.id,
      model: this.model,
      tools: [],
      cwd: '',
    })

    await new Promise<void>((resolve) => {
      const req = request(
        {
          host: OLLAMA_HOST,
          port: OLLAMA_PORT,
          path: '/api/chat',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        },
        (res) => {
          let buffer = ''
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8')
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              if (line.trim() === '') continue
              try {
                const parsed = JSON.parse(line) as {
                  message?: { content?: string }
                  done?: boolean
                  eval_count?: number
                  prompt_eval_count?: number
                }
                const piece = parsed.message?.content
                if (piece) {
                  answer += piece
                  this.emit({ kind: 'text', text: piece })
                }
                if (parsed.done) {
                  const end: Extract<SessionEvent, { kind: 'turn-end' }> = {
                    kind: 'turn-end',
                    durationMs: Date.now() - started,
                    // Local inference has no dollar cost. Say zero, honestly, rather
                    // than hiding the field and implying it is unknown.
                    costUsd: 0,
                  }
                  if (typeof parsed.prompt_eval_count === 'number') end.inputTokens = parsed.prompt_eval_count
                  if (typeof parsed.eval_count === 'number') end.outputTokens = parsed.eval_count
                  this.emit(end)
                }
              } catch {
                // Skip a malformed chunk rather than dropping the turn.
              }
            }
          })
          res.on('end', () => {
            if (answer) this.history.push({ role: 'assistant', content: answer })
            this.active = null
            resolve()
          })
        },
      )

      req.on('error', (error) => {
        this.active = null
        this.emit({
          kind: 'error',
          message:
            `Could not reach Ollama on ${OLLAMA_HOST}:${OLLAMA_PORT} — ${error.message}. ` +
            'Is `ollama serve` running?',
        })
        resolve()
      })

      this.active = req
      req.write(payload)
      req.end()
    })
  }

  interrupt(): void {
    if (!this.active) return
    this.active.destroy()
    this.active = null
    this.emit({ kind: 'status', text: 'Stopped.' })
  }

  close(): void {
    this.interrupt()
    this.history = []
  }
}
