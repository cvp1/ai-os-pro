import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Finding the local half of the product: opencode, Ollama, and the models on disk.
 *
 * NOTHING HERE OPENS A SOCKET. Enumerating a user's models is a question about a
 * service, and the obvious way to ask is an HTTP GET to `/api/tags` — which would put
 * a network client in an app whose central claim is that it has none, and would make
 * the audit gate a lie the day someone widened it "just for localhost". So we ask the
 * `ollama` CLI instead, the same way we ask `claude` and `opencode`: spawn a binary,
 * read its stdout. Ollama ships that CLI, so it is present wherever the thing we want
 * to talk to is present.
 *
 * The cost of that choice is honest and small: a REMOTE Ollama on another machine,
 * with no CLI installed locally, cannot be enumerated. `SASHA_OLLAMA_MODELS` covers
 * that case explicitly rather than leaving it silently broken.
 */

/** Bounded: a picker, not an inventory. */
const MAX_MODELS = 40
const PROBE_TIMEOUT_MS = 5000

export interface LocalState {
  /** True when a local model can actually be run right now. */
  ready: boolean
  opencodePath?: string
  ollamaUrl: string
  models: string[]
  /** Plain words about what is missing, when something is. */
  problem?: string
}

/** Where the user's Ollama is. `OLLAMA_HOST` is Ollama's own convention. */
export function ollamaUrl(env = process.env): string {
  const raw = (env.SASHA_OLLAMA_URL || env.OLLAMA_HOST || '').trim()
  if (!raw) return 'http://127.0.0.1:11434'
  // OLLAMA_HOST is often bare (`192.168.1.5:11434`); make it a URL either way.
  return /^https?:\/\//.test(raw) ? raw.replace(/\/+$/, '') : `http://${raw}`
}

/**
 * The opencode binary, or undefined. Same shape as the harness lookup.
 *
 * Takes `env` rather than reading process.env directly: the lookup has to be
 * steerable to be testable, and a probe that silently consults the ambient PATH is a
 * probe whose failure path can never be exercised.
 */
export async function findOpencode(env = process.env): Promise<string | undefined> {
  const explicit = env.SASHA_OPENCODE_PATH?.trim()
  if (explicit && existsSync(explicit)) return explicit
  try {
    const { stdout } = await run('which', ['opencode'], {
      timeout: PROBE_TIMEOUT_MS,
      env: env as NodeJS.ProcessEnv,
    })
    const path = stdout.trim().split('\n')[0]
    return path && existsSync(path) ? path : undefined
  } catch {
    return undefined
  }
}

/** `ollama list` → model tags. Empty when Ollama is not installed or not running. */
export async function listOllamaModels(env = process.env): Promise<string[]> {
  const override = env.SASHA_OLLAMA_MODELS?.trim()
  if (override) {
    return override
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '')
      .slice(0, MAX_MODELS)
  }

  try {
    const { stdout } = await run('ollama', ['list'], {
      timeout: PROBE_TIMEOUT_MS,
      env: { ...env, OLLAMA_HOST: ollamaUrl(env) } as NodeJS.ProcessEnv,
    })
    return stdout
      .split('\n')
      .slice(1) // header row
      .map((line) => line.trim().split(/\s+/)[0] ?? '')
      .filter((tag) => tag !== '' && tag !== 'NAME')
      .slice(0, MAX_MODELS)
  } catch {
    return []
  }
}

/**
 * Can this machine answer locally, and if not, exactly what is missing?
 *
 * Each failure names the one thing to do next. "Local models unavailable" tells a
 * user nothing; "Ollama is installed but has no models — run `ollama pull`" tells
 * them everything.
 */
export async function discoverLocal(env = process.env): Promise<LocalState> {
  const url = ollamaUrl(env)
  const [opencodePath, models] = await Promise.all([findOpencode(env), listOllamaModels(env)])

  if (!opencodePath && models.length === 0) {
    return {
      ready: false,
      ollamaUrl: url,
      models: [],
      problem:
        'No local setup found. Local models here need two free tools: Ollama (to hold ' +
        'the models) and opencode (to run them as an agent). Install both and reopen ' +
        'this window.',
    }
  }

  if (!opencodePath) {
    return {
      ready: false,
      ollamaUrl: url,
      models,
      problem:
        'Ollama is here, but opencode is not — that is what actually runs a local ' +
        'model as an agent with access to your files. Install it from opencode.ai.',
    }
  }

  if (models.length === 0) {
    return {
      ready: false,
      opencodePath,
      ollamaUrl: url,
      models: [],
      problem:
        `No local models found at ${url}. If Ollama is running there, pull one first ` +
        '(for example: ollama pull gemma3n:e4b). If your Ollama lives on another ' +
        'machine, set SASHA_OLLAMA_URL to point at it and SASHA_OLLAMA_MODELS to the ' +
        'models it holds.',
    }
  }

  return { ready: true, opencodePath, ollamaUrl: url, models }
}
