import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Backend, SessionEvent } from './protocol.js'

/**
 * The local backend — a real agent on your own weights, through opencode.
 *
 * WHY OPENCODE AND NOT OUR OWN BRIDGE. v0.3 shipped an Anthropic→Ollama translation
 * layer so Claude Code could drive a local model. It failed its pre-stated gate and
 * was deleted (see manager.ts). The follow-up control run answered the question the
 * gate could not: a native opencode arm scored the SAME 1/2 on the same task with the
 * same model — so the failure belonged to the model tier, not the transport — and it
 * ran about twice as fast, because it was not paying for a double translation. The
 * lesson was not "local models do not work here". It was "stop writing a harness and
 * use the one that is already gate-passed for this job".
 *
 * So this backend spawns a binary, exactly as the Claude one does. We open no socket,
 * translate no vendor protocol, and reimplement nothing: `opencode run --format json`
 * is a documented event stream, and `--session` carries the conversation forward.
 * Adding local models cost one adapter, which is the entire point of the neutral
 * protocol in protocol.ts.
 *
 * TWO HONEST LIMITS, both surfaced in the UI rather than buried here:
 *
 *  1. IT IS NOT SASHA. A local model gets your files and tools; it does not get the
 *     AI-OS prompt stack, your skills, or your memory — opencode reads its own
 *     context files, not Claude Code's. Calling this "Sasha on local weights" would
 *     be the marketing claim the deleted bridge was actually built to earn.
 *
 *  2. IT CAN BE WRONG IN WAYS THE BIG MODELS ARE NOT. Measured on this fleet: a
 *     4B-class local model completes about half of five-step agentic file tasks. In
 *     the very capture that shaped this file, the model grepped a file reading "four
 *     horses" and answered "One". That is the tier, not a bug, and the user is told.
 */

/**
 * One turn is one process, and it gets three minutes.
 *
 * Measured on this fleet, same model and machine, "what is 2+2": straight to Ollama's
 * endpoint answers in 0.6 s; through `opencode run` with its full scaffold (~11.5k
 * input tokens of system prompt and tool schemas) it is seconds, and a tool-using turn
 * is tens of seconds. Three minutes is generous for that and short enough to fail
 * honestly rather than leave someone staring at a window that looks broken.
 *
 * It is deliberately NOT ten minutes any more. The earlier ten-minute value was set to
 * accommodate "hangs" that turned out to be this file's own bug (see the stdin note in
 * `start`), and a timeout chosen to tolerate a defect keeps the defect comfortable.
 */
const TURN_TIMEOUT_MS = 3 * 60_000
/** Tool output can be enormous; the transcript row only needs a line. */
const SUMMARY_CHARS = 120

export interface OpencodeOptions {
  /** Absolute path to the opencode binary. */
  binary: string
  /** Where the session runs — the user's AI-OS workspace. */
  cwd: string
  /** Provider-qualified model, e.g. `ollama/gemma4-e4b-agent-64k:latest`. */
  model: string
  label: string
  /** Base URL of the Ollama the user is actually running. */
  ollamaUrl: string
}

export class OpencodeBackend implements Backend {
  readonly id = 'opencode'
  readonly label: string

  private child: import('node:child_process').ChildProcess | null = null
  private buffer = ''
  private listeners: ((event: SessionEvent) => void)[] = []
  private sessionId: string | null = null
  private configPath: string | null = null
  private closed = false
  private timer: NodeJS.Timeout | null = null
  private announcedReady = false

  constructor(private readonly options: OpencodeOptions) {
    this.label = options.label
  }

  onEvent(listener: (event: SessionEvent) => void): void {
    this.listeners.push(listener)
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  /**
   * A self-contained config, written per session and passed by env.
   *
   * Generated rather than borrowed from `~/.config/opencode` for two reasons that are
   * both about not surprising the user:
   *
   *  · `"mcp": {}` — a config we did not write could dial an MCP server into what the
   *    user thinks is a private local session. Structural, not a flag someone can
   *    forget: the caller never builds this.
   *
   *  · The permission block. Headless opencode denies every tool unless `--auto` is
   *    passed, and `--auto` on its own auto-approves everything — looser than the
   *    Claude side's `acceptEdits`, which would mean a GUI quietly handing the user
   *    weaker guardrails than the terminal gives them. Denying the mutating tools
   *    explicitly, and letting `--auto` cover only what is left, lands on: A LOCAL
   *    SESSION MAY READ YOUR WORKSPACE AND MAY NOT CHANGE IT. Narrower than the
   *    Claude session on purpose.
   *
   *    Verified live, gemma4-e4b, 2026-07-27: asked to create a file, the model's
   *    write and bash attempts came back `invalid` and no file appeared; asked to read
   *    one, `read` ran and it answered from the contents. Both runs exited cleanly.
   *
   * A NOTE ON HOW NEARLY THIS WENT WRONG, because the lesson generalises. Four
   * attempts at this posture were first recorded as dead ends — permission-deny and
   * three agent variants, each "hanging" for 300-400 s with zero output — and the
   * plan was to ship without it and disclose that local sessions can write. Every one
   * of those measurements was invalid: they shared a broken harness (an open stdin
   * pipe, and stdout redirected to a file), so they were measuring the rig, not the
   * config. The same permission block, run through a pipe, works in seconds. Four
   * consistent failures through one instrument is one observation, not four.
   */
  private writeConfig(): string {
    if (this.configPath) return this.configPath
    const dir = mkdtempSync(join(tmpdir(), 'sasha-oc-'))
    const path = join(dir, 'opencode.json')
    const model = this.options.model.split('/').slice(1).join('/')
    writeFileSync(
      path,
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: {
          ollama: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Ollama (this machine)',
            options: { baseURL: `${this.options.ollamaUrl}/v1` },
            models: { [model]: { name: model } },
          },
        },
        mcp: {},
        // Read, do not change. Verified live (see the note above): write/bash come
        // back `invalid`, read works.
        permission: { edit: 'deny', write: 'deny', bash: 'deny', webfetch: 'deny' },
      }),
    )
    this.configPath = path
    return path
  }

  private start(text: string): void {
    const args = ['run', '--format', 'json', '--auto', '-m', this.options.model]
    // Continue the conversation rather than starting fresh every message. Without
    // this the second turn has no memory of the first and the window would be lying
    // about being a conversation.
    if (this.sessionId) args.push('--session', this.sessionId)
    args.push(text)

    const child = spawn(this.options.binary, args, {
      cwd: this.options.cwd,
      // stdin is 'ignore', NOT a pipe. The message goes on the command line, so this
      // process has no stdin to give — and handing it an open pipe we never write to
      // or close invites the child to sit there reading it forever. A CLI that accepts
      // piped input has every reason to wait when stdin is an open pipe rather than a
      // terminal, and "waits forever" is exactly the symptom this cost hours of.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv({ OPENCODE_CONFIG: this.writeConfig() }),
    })
    this.child = child

    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim()
      // opencode is chatty on stderr; only surface something that reads like trouble.
      if (line && /error|failed|refused|denied/i.test(line)) {
        this.emit({ kind: 'status', text: line.slice(0, 300) })
      }
    })
    child.on('error', (error) =>
      this.emit({
        kind: 'error',
        message:
          `Could not start opencode: ${error.message}. It is what runs local models ` +
          'here — install it from opencode.ai, or pick a Claude model.',
      }),
    )
    child.on('close', (code) => {
      this.child = null
      this.clearTimer()
      if (this.closed) return
      // A turn ends when the process ends: one process is one turn.
      if (code !== 0 && code !== null) {
        this.emit({
          kind: 'error',
          message:
            `The local model stopped with code ${code}. If this keeps happening, check ` +
            `that Ollama is running at ${this.options.ollamaUrl} and has the model pulled.`,
        })
      }
      this.emit({ kind: 'turn-end' })
    })

    this.timer = setTimeout(() => {
      this.emit({
        kind: 'error',
        message:
          'The local model did not answer within three minutes, so it was stopped and ' +
          'your window is yours again. Small models can loop on a long chain of tool ' +
          'calls; try a simpler ask, or use a Claude model for this one.',
      })
      this.child?.kill('SIGTERM')
    }, TURN_TIMEOUT_MS)


  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Parse newline-delimited JSON, tolerating chunk boundaries mid-line. */
  private consume(text: string): void {
    this.buffer += text
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() === '') continue
      try {
        this.translate(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // A malformed line is not worth killing a turn over.
      }
    }
  }

  /** Map opencode's event stream onto our neutral vocabulary. */
  private translate(event: Record<string, unknown>): void {
    // Every event carries the session; capture it once so the next turn continues.
    const session = event.sessionID
    if (typeof session === 'string' && session !== '') {
      this.sessionId = session
      if (!this.announcedReady) {
        this.announcedReady = true
        this.emit({
          kind: 'ready',
          sessionId: session,
          model: this.options.model,
          tools: [],
          cwd: this.options.cwd,
        })
      }
    }

    const part = event.part as Record<string, unknown> | undefined
    if (!part) return

    if (part.type === 'text' && typeof part.text === 'string') {
      this.emit({ kind: 'text', text: part.text })
      return
    }

    if (part.type === 'reasoning' && typeof part.text === 'string') {
      this.emit({ kind: 'thinking', text: part.text })
      return
    }

    if (part.type === 'tool') {
      const id = String(part.callID ?? part.id ?? '')
      const name = String(part.tool ?? 'tool')
      const state = part.state as Record<string, unknown> | undefined
      const status = String(state?.status ?? '')

      // opencode reports a tool once it has a state, so a completed call arrives as a
      // single event. Emit both halves so the transcript shows the same
      // call-then-result shape the Claude backend produces.
      this.emit({ kind: 'tool', id, name, summary: describeInput(name, state?.input) })
      if (status === 'completed' || status === 'error') {
        this.emit({
          kind: 'tool-result',
          id,
          ok: status === 'completed',
          summary: name,
        })
      }
      return
    }

    if (part.type === 'step-finish') {
      const tokens = part.tokens as Record<string, unknown> | undefined
      const end: Extract<SessionEvent, { kind: 'turn-end' }> = { kind: 'turn-end' }
      if (typeof tokens?.input === 'number') end.inputTokens = tokens.input
      if (typeof tokens?.output === 'number') end.outputTokens = tokens.output
      // Local inference has no bill. Reporting 0 rather than hiding the field is the
      // honest version — it is the reason someone chose this model.
      end.costUsd = typeof part.cost === 'number' ? part.cost : 0
      const time = part.time as Record<string, unknown> | undefined
      if (typeof time?.start === 'number' && typeof time?.end === 'number') {
        end.durationMs = time.end - time.start
      }
      this.emit(end)
    }
  }

  async send(text: string): Promise<void> {
    if (this.child) {
      throw new Error('The local model is still working on the previous message.')
    }
    this.closed = false
    // MEASURED, not assumed: `opencode run --format json` writes nothing until the
    // process exits — polling its stdout during a live turn showed 0 bytes at 20s,
    // 40s, 60s and 80s, then the whole stream at once. So there is no token-by-token
    // stream to render here, and a local turn can be a minute or three of total
    // silence. Saying so up front is the difference between "it is thinking" and
    // "it is broken"; without this line the honest backend looks like a hung one.
    this.emit({
      kind: 'status',
      text:
        'Working locally… local models answer all at once rather than word by word, ' +
        'so this can take a minute or two with nothing on screen.',
    })
    this.start(text)
  }

  interrupt(): void {
    if (!this.child) return
    this.child.kill('SIGTERM')
    this.child = null
    this.clearTimer()
    // The session id survives, so the next message continues the conversation —
    // unlike the Claude backend, where stopping ends the session.
    this.emit({ kind: 'status', text: 'Stopped. The conversation is still here.' })
  }

  close(): void {
    this.closed = true
    this.clearTimer()
    if (!this.child) return
    this.child.kill('SIGTERM')
    this.child = null
  }
}

/**
 * A curated environment for the child, instead of Electron's.
 *
 * MEASURED, and the reason this function exists: the identical opencode command, same
 * cwd and same generated config, answers "4" in about four seconds when run from a
 * shell — and produced NOTHING for 150 seconds when spawned from inside Electron with
 * `{...process.env}`. Same binary, same model, same machine. The only difference was
 * the environment it inherited.
 *
 * An Electron main process carries a large amount of Chromium and Node machinery in
 * its env, and a foreign runtime (opencode ships as a compiled bun binary) has no
 * business inheriting any of it. Rather than bisect a moving target — the offending
 * variable may well change with the next Electron — this passes an explicit, small
 * set and drops everything else. A child process should get what it needs, not
 * whatever happened to be lying around.
 *
 * The allowlist is deliberately boring: where the user is (HOME, USER), how to find
 * binaries (PATH, SHELL), how to render text (LANG, LC_ALL, TERM), where app state
 * lives (XDG_*), and the two things that steer the model (OLLAMA_HOST, and the config
 * path we pass in). Something missing here shows up as a clear failure in the
 * transcript, which is the right direction to fail in.
 */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const KEEP = [
    'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
    'OLLAMA_HOST', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const key of KEEP) {
    const value = process.env[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  return { ...env, ...extra }
}

/** One readable line about what a tool is being asked to do. */
function describeInput(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return name
  const fields = input as Record<string, unknown>
  const first =
    fields.filePath ?? fields.path ?? fields.pattern ?? fields.command ?? fields.query
  if (typeof first !== 'string') return name
  const trimmed = first.replace(/\s+/g, ' ').trim()
  return trimmed.length > SUMMARY_CHARS ? `${trimmed.slice(0, SUMMARY_CHARS - 3)}…` : trimmed
}
