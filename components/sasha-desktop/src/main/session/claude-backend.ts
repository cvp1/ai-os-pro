import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Backend, SessionEvent } from './protocol.js'

/**
 * The Claude Code backend — a real session, over the shipped programmatic seam.
 *
 * `--input-format stream-json --output-format stream-json` is a documented,
 * bidirectional protocol: we write user messages as JSON lines and read a typed event
 * stream back. That matters because the alternative — driving a terminal and scraping
 * its output — would make us hostage to the TUI's rendering, and every cosmetic change
 * upstream would look like a bug here. Integrate at the seam the tool actually ships.
 *
 * It also means no pseudo-terminal dependency, so the zero-runtime-dependency posture
 * survives the feature.
 *
 * Everything runs under the user's own Claude Code and their own login. We add no
 * key, no proxy, and no gateway.
 */
export class ClaudeBackend implements Backend {
  readonly id = 'claude'
  readonly label: string

  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private listeners: ((event: SessionEvent) => void)[] = []
  private toolNames = new Map<string, string>()
  private closed = false

  constructor(
    private readonly binary: string,
    private readonly cwd: string,
    private readonly model: string,
    private readonly permissionMode: string,
    label: string,
  ) {
    this.label = label
  }

  onEvent(listener: (event: SessionEvent) => void): void {
    this.listeners.push(listener)
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model',
      this.model,
      '--permission-mode',
      this.permissionMode,
    ]

    const child = spawn(this.binary, args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child

    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) this.emit({ kind: 'status', text: text.slice(0, 400) })
    })
    child.on('error', (error) =>
      this.emit({ kind: 'error', message: `Could not start Claude Code: ${error.message}` }),
    )
    child.on('close', (code) => {
      this.child = null
      if (!this.closed) this.emit({ kind: 'closed', code })
    })

    return child
  }

  /** Parse newline-delimited JSON, tolerating chunk boundaries mid-line. */
  private consume(text: string): void {
    this.buffer += text
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() === '') continue
      try {
        this.translate(JSON.parse(line))
      } catch {
        // A malformed line is not worth killing a session over.
      }
    }
  }

  /** Map Claude Code's stream-json onto our neutral vocabulary. */
  private translate(message: Record<string, unknown>): void {
    const type = message.type

    if (type === 'system') {
      const subtype = message.subtype
      if (subtype === 'init') {
        this.emit({
          kind: 'ready',
          sessionId: String(message.session_id ?? ''),
          model: String(message.model ?? this.model),
          tools: Array.isArray(message.tools) ? (message.tools as string[]) : [],
          cwd: String(message.cwd ?? this.cwd),
        })
      }
      return
    }

    if (type === 'stream_event') {
      const event = message.event as Record<string, unknown> | undefined
      if (event?.type !== 'content_block_delta') return
      const delta = event.delta as Record<string, unknown> | undefined
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        this.emit({ kind: 'text', text: delta.text })
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        this.emit({ kind: 'thinking', text: delta.thinking })
      }
      return
    }

    if (type === 'assistant') {
      // Tool calls arrive complete rather than as deltas — surface them so the user
      // can see what the system is doing on their machine, not just what it says.
      const content = (message.message as Record<string, unknown> | undefined)?.content
      if (!Array.isArray(content)) return
      for (const block of content as Record<string, unknown>[]) {
        if (block.type !== 'tool_use') continue
        const id = String(block.id ?? '')
        const name = String(block.name ?? 'tool')
        this.toolNames.set(id, name)
        this.emit({ kind: 'tool', id, name, summary: describeToolInput(name, block.input) })
      }
      return
    }

    if (type === 'user') {
      // Tool results come back as user-role blocks.
      const content = (message.message as Record<string, unknown> | undefined)?.content
      if (!Array.isArray(content)) return
      for (const block of content as Record<string, unknown>[]) {
        if (block.type !== 'tool_result') continue
        const id = String(block.tool_use_id ?? '')
        this.emit({
          kind: 'tool-result',
          id,
          ok: block.is_error !== true,
          summary: this.toolNames.get(id) ?? 'tool',
        })
      }
      return
    }

    if (type === 'result') {
      const usage = message.usage as Record<string, unknown> | undefined
      const end: Extract<SessionEvent, { kind: 'turn-end' }> = { kind: 'turn-end' }
      if (typeof message.total_cost_usd === 'number') end.costUsd = message.total_cost_usd
      if (typeof message.duration_api_ms === 'number') end.durationMs = message.duration_api_ms
      if (typeof usage?.input_tokens === 'number') end.inputTokens = usage.input_tokens
      if (typeof usage?.output_tokens === 'number') end.outputTokens = usage.output_tokens
      this.emit(end)

      if (message.is_error === true) {
        this.emit({
          kind: 'error',
          message: String(message.result ?? 'The harness reported an error.'),
        })
      }
      return
    }

    if (type === 'rate_limit_event') {
      const info = message.rate_limit_info as Record<string, unknown> | undefined
      if (info?.status && info.status !== 'allowed') {
        this.emit({ kind: 'status', text: `Rate limit: ${String(info.status)}` })
      }
    }
  }

  async send(text: string): Promise<void> {
    const child = this.start()
    const payload =
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      }) + '\n'

    await new Promise<void>((resolve, reject) => {
      child.stdin.write(payload, (error) => (error ? reject(error) : resolve()))
    })
  }

  interrupt(): void {
    // Claude Code has no in-band interrupt on this transport; ending the turn means
    // ending the process. Say so rather than pretending the button did something.
    this.close()
    this.emit({ kind: 'status', text: 'Stopped. The next message starts a new session.' })
  }

  close(): void {
    this.closed = true
    if (!this.child) return
    this.child.stdin.end()
    this.child.kill('SIGTERM')
    this.child = null
  }
}

/** One readable line about what a tool is being asked to do. */
function describeToolInput(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return name
  const fields = input as Record<string, unknown>
  const first =
    fields.command ?? fields.file_path ?? fields.path ?? fields.pattern ?? fields.url ?? fields.prompt
  if (typeof first !== 'string') return name
  const trimmed = first.replace(/\s+/g, ' ').trim()
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed
}
