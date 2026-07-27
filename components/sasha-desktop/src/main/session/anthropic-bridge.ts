import { createServer, type Server } from 'node:http'
import { request } from 'node:http'
import { assertLoopback, OLLAMA_HOST, OLLAMA_PORT } from './ollama-backend.js'

/**
 * The brain for local models.
 *
 * WHY THIS EXISTS. The Claude path is intelligent because Claude Code *is* the
 * intelligence — it assembles the system prompt, owns the tools, loads skills and
 * memory, enforces permissions, and runs the agent loop. Our Claude backend only
 * pipes messages into it. The local path had none of that: it called Ollama's
 * `/api/chat` directly, which is a bare completion endpoint. No system prompt, no
 * tools, no loop. The local model had no brain because the brain was never written.
 *
 * Writing our own agent loop would mean re-implementing Claude Code badly. The far
 * better move is to let Claude Code drive the local model, which it will do if it is
 * pointed at something speaking the Anthropic Messages API:
 *
 *     ANTHROPIC_BASE_URL=http://127.0.0.1:<port>  ANTHROPIC_MODEL=<ollama model>
 *
 * Verified before this was built — with a stub endpoint, Claude Code sent a 6,474
 * character system prompt and 10 tool definitions, streaming. So this file is that
 * endpoint: it accepts Anthropic Messages requests, translates them to Ollama, and
 * translates the answer back as an Anthropic SSE stream. The local model inherits
 * the ENTIRE harness — tools, skills, memory, CLAUDE.md, permissions — instead of a
 * lesser loop of our own.
 *
 * It binds loopback only, and `assertLoopback` guards the upstream the same way the
 * direct backend does. Nothing here reaches off-machine.
 */

const BRIDGE_HOST = '127.0.0.1'

interface AnthropicTool {
  name: string
  description?: string
  input_schema?: unknown
}

interface ContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

interface AnthropicMessage {
  role: string
  content: string | ContentBlock[]
}

/** Anthropic's `system` may be a string or an array of blocks. */
function systemText(system: unknown): string {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .map((block) => (typeof block === 'object' && block && 'text' in block ? String((block as ContentBlock).text ?? '') : ''))
    .filter(Boolean)
    .join('\n\n')
}

/** Render one Anthropic message as Ollama chat messages. */
function toOllamaMessages(messages: AnthropicMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []

  for (const message of messages) {
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content })
      continue
    }

    const textParts: string[] = []
    const toolCalls: Record<string, unknown>[] = []

    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text)
      } else if (block.type === 'tool_use') {
        toolCalls.push({ function: { name: block.name, arguments: block.input ?? {} } })
      } else if (block.type === 'tool_result') {
        // Ollama expects tool output as its own `tool` message.
        const content =
          typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? (block.content as ContentBlock[]).map((c) => c.text ?? '').join('\n')
              : JSON.stringify(block.content ?? '')
        out.push({ role: 'tool', content })
      }
    }

    if (textParts.length > 0 || toolCalls.length > 0) {
      const entry: Record<string, unknown> = {
        role: message.role,
        content: textParts.join('\n'),
      }
      if (toolCalls.length > 0) entry.tool_calls = toolCalls
      out.push(entry)
    }
  }

  return out
}

function toOllamaTools(tools: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return (tools as AnthropicTool[]).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
    },
  }))
}

/** Server-sent event in Anthropic's streaming shape. */
function sse(res: import('node:http').ServerResponse, type: string, data: unknown): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
}

export interface BridgeHandle {
  port: number
  close(): void
}

/**
 * Start the bridge for one Ollama model. Returns the loopback port to hand Claude
 * Code via ANTHROPIC_BASE_URL.
 */
export function startAnthropicBridge(
  onLog?: (message: string) => void,
): Promise<BridgeHandle> {
  assertLoopback(OLLAMA_HOST)

  const server: Server = createServer((req, res) => {
    if (!req.url?.includes('/messages')) {
      res.statusCode = 404
      res.end('{}')
      return
    }

    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(raw)
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ type: 'error', error: { message: 'bad request body' } }))
        return
      }

      const model = String(parsed.model ?? '')
      const messages = Array.isArray(parsed.messages) ? (parsed.messages as AnthropicMessage[]) : []
      const system = systemText(parsed.system)
      const tools = toOllamaTools(parsed.tools)

      const ollamaMessages = [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...toOllamaMessages(messages),
      ]

      const payload = JSON.stringify({
        model,
        messages: ollamaMessages,
        tools,
        stream: true,
        options: { num_ctx: 32768 },
      })

      onLog?.(`bridge → ollama: model=${model} msgs=${ollamaMessages.length} tools=${tools?.length ?? 0}`)

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })

      const messageId = `msg_bridge_${Date.now().toString(36)}`
      sse(res, 'message_start', {
        type: 'message_start',
        message: {
          id: messageId, type: 'message', role: 'assistant', model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })

      let blockIndex = -1
      let textOpen = false
      let stopReason = 'end_turn'
      let inTokens = 0
      let outTokens = 0

      const openText = (): void => {
        if (textOpen) return
        blockIndex++
        textOpen = true
        sse(res, 'content_block_start', {
          type: 'content_block_start', index: blockIndex,
          content_block: { type: 'text', text: '' },
        })
      }
      const closeText = (): void => {
        if (!textOpen) return
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex })
        textOpen = false
      }

      assertLoopback(OLLAMA_HOST)
      const upstream = request(
        {
          host: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/chat', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        },
        (upRes) => {
          let buffer = ''
          upRes.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8')
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''

            for (const line of lines) {
              if (line.trim() === '') continue
              let event: Record<string, unknown>
              try {
                event = JSON.parse(line)
              } catch {
                continue
              }

              const message = event.message as Record<string, unknown> | undefined
              const piece = message?.content

              if (typeof piece === 'string' && piece !== '') {
                openText()
                sse(res, 'content_block_delta', {
                  type: 'content_block_delta', index: blockIndex,
                  delta: { type: 'text_delta', text: piece },
                })
              }

              // Tool calls arrive whole from Ollama; Anthropic wants a block with
              // its input delivered as a single input_json_delta.
              const calls = message?.tool_calls
              if (Array.isArray(calls)) {
                closeText()
                for (const call of calls as Record<string, unknown>[]) {
                  const fn = call.function as Record<string, unknown> | undefined
                  if (!fn?.name) continue
                  blockIndex++
                  const toolId = `toolu_bridge_${blockIndex}_${Date.now().toString(36)}`
                  sse(res, 'content_block_start', {
                    type: 'content_block_start', index: blockIndex,
                    content_block: { type: 'tool_use', id: toolId, name: String(fn.name), input: {} },
                  })
                  const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})
                  sse(res, 'content_block_delta', {
                    type: 'content_block_delta', index: blockIndex,
                    delta: { type: 'input_json_delta', partial_json: args },
                  })
                  sse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex })
                  stopReason = 'tool_use'
                }
              }

              if (typeof event.prompt_eval_count === 'number') inTokens = event.prompt_eval_count
              if (typeof event.eval_count === 'number') outTokens = event.eval_count

              if (event.done === true) {
                closeText()
                sse(res, 'message_delta', {
                  type: 'message_delta',
                  delta: { stop_reason: stopReason, stop_sequence: null },
                  usage: { input_tokens: inTokens, output_tokens: outTokens },
                })
                sse(res, 'message_stop', { type: 'message_stop' })
                res.end()
              }
            }
          })
          upRes.on('end', () => {
            if (!res.writableEnded) {
              closeText()
              sse(res, 'message_stop', { type: 'message_stop' })
              res.end()
            }
          })
        },
      )

      upstream.on('error', (error) => {
        onLog?.(`bridge upstream error: ${error.message}`)
        if (!res.headersSent) {
          res.statusCode = 502
          res.end(JSON.stringify({ type: 'error', error: { message: `Ollama unreachable: ${error.message}` } }))
          return
        }
        closeText()
        sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} })
        sse(res, 'message_stop', { type: 'message_stop' })
        res.end()
      })

      upstream.write(payload)
      upstream.end()
    })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    // Port 0 = let the OS pick a free one; bound to loopback so nothing else can reach it.
    server.listen(0, BRIDGE_HOST, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      onLog?.(`local-model bridge listening on ${BRIDGE_HOST}:${port}`)
      resolve({
        port,
        close: () => server.close(),
      })
    })
  })
}

export { BRIDGE_HOST }
