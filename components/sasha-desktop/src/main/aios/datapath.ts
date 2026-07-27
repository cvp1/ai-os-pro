/**
 * Where your data goes — the panel that answers the question the product's whole
 * claim rests on.
 *
 * "A personal AI that is yours" is a marketing sentence until someone can check it.
 * This module turns it into a list of specific flows: what leaves this machine, what
 * does not, and who receives the parts that do. Written for someone who is not going
 * to read the source.
 *
 * TWO RULES kept this from becoming a trust badge:
 *
 *  1. EVERY LINE IS DERIVED FROM ACTUAL STATE. The model you have selected, the
 *     harness that was found, the folder the session can reach. Nothing is a fixed
 *     string that would keep saying something reassuring after it stopped being true —
 *     if no harness is installed, this says so instead of describing a data path that
 *     is not running.
 *
 *  2. THE UNCOMFORTABLE ROWS STAY. A privacy panel that lists only the good news is
 *     an advertisement. When you are talking to a cloud model, the top row says your
 *     conversation leaves the machine, in those words, above the reassuring ones.
 *
 * The claims about this app's own behaviour ("sends nothing") are not decoration
 * either: `audit:surface` fails the build if any file opens a socket, and the
 * zero-telemetry test asserts it against a live proxy. This panel is the user-facing
 * face of gates that already exist.
 */

export type Direction = 'stays' | 'leaves' | 'unknown'

export interface Flow {
  /** What kind of data this row is about. */
  what: string
  direction: Direction
  /** Plain-language detail. One or two sentences, no jargon. */
  detail: string
}

export interface DataPath {
  /** The headline: is anything at all leaving right now? */
  summary: string
  flows: Flow[]
  /** Where the session can read and write, in the user's own words. */
  workspace?: string
}

export interface DataPathInputs {
  modelLabel: string | null
  provider: 'claude' | 'ollama' | null
  local: boolean
  harnessFound: boolean
  harnessPath?: string
  installRoot?: string
  /** Set when the selected model is local — where that Ollama actually lives. */
  ollamaUrl?: string
}

/** Loopback means "this machine"; a LAN address means "a machine you own". */
function isLoopback(url: string | undefined): boolean {
  if (!url) return true
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$|\/)/i.test(url)
}

export function describeDataPath(inputs: DataPathInputs): DataPath {
  const flows: Flow[] = []

  // 1. The conversation. The most important row, and the one that must never soften.
  if (!inputs.harnessFound) {
    flows.push({
      what: 'Your conversation',
      direction: 'unknown',
      detail:
        'Nothing is running yet — Claude Code was not found on this machine, so there ' +
        'is no session to send anything anywhere.',
    })
  } else if (inputs.local && isLoopback(inputs.ollamaUrl)) {
    flows.push({
      what: 'Your conversation',
      direction: 'stays',
      detail:
        `${inputs.modelLabel ?? 'The selected model'} runs on this computer. What you ` +
        'type is answered here and is not sent to any company — no internet ' +
        'connection is needed for it at all.',
    })
  } else if (inputs.local) {
    // A local model on ANOTHER box is still private, but "stays on this machine" would
    // be false — and the whole panel is worthless the first time it says something
    // false. It goes over your network; say that, and say where.
    flows.push({
      what: 'Your conversation',
      direction: 'leaves',
      detail:
        `${inputs.modelLabel ?? 'The selected model'} runs on a different machine on ` +
        `your own network (${inputs.ollamaUrl}), so what you type travels there over ` +
        'your network. It still reaches no company and no internet service — but it ' +
        'does leave this computer.',
    })
  } else {
    flows.push({
      what: 'Your conversation',
      direction: 'leaves',
      detail:
        `${inputs.modelLabel ?? 'The selected model'} runs on Anthropic's servers, so ` +
        'what you type — and any file content Sasha reads while answering — is sent ' +
        'there to be answered. It goes through your own Claude Code login, exactly as ' +
        'it would if you were using the terminal. This app adds no other destination.',
    })
  }

  // 2. This app's own traffic. The claim the audits actually enforce.
  flows.push({
    what: 'Usage data, analytics, crash reports',
    direction: 'stays',
    detail:
      'None are collected and none are sent. This app opens no network connections ' +
      'of its own — there is no account, no sign-in, and no server behind it. That is ' +
      'checked automatically on every build, not just promised here.',
  })

  // 3. Files. What the session can reach — the thing people underestimate.
  if (inputs.installRoot) {
    flows.push({
      what: 'Your files',
      direction: inputs.local || !inputs.harnessFound ? 'stays' : 'leaves',
      detail:
        `Sasha works inside ${inputs.installRoot} and can read and change files there ` +
        'when you ask it to. ' +
        (inputs.local
          ? 'A local model asks less before changing a file than a Claude session ' +
            'does, so be specific with it. Nothing is uploaded to any company.'
          : !inputs.harnessFound
            ? 'Nothing is uploaded.'
            : 'Anything it reads in order to answer you becomes part of what is sent to ' +
              'the model — that is how it can answer questions about your own notes.'),
    })
  }

  // 4. What is on disk and stays there. The reason the product is portable.
  flows.push({
    what: 'What Sasha knows about you',
    direction: 'stays',
    detail:
      'Your me/ and memory/ files are plain markdown on your own disk. You can read ' +
      'them, back them up, or delete them, and nothing here syncs them anywhere.',
  })

  const leaving = flows.some((flow) => flow.direction === 'leaves')
  const summary = !inputs.harnessFound
    ? 'Nothing is leaving this machine — nothing is running yet.'
    : !leaving
      ? 'Nothing leaves this machine.'
      : inputs.local
        ? 'Your conversation goes to your own machine on your own network. Nothing reaches the internet.'
        : 'Your conversation goes to the model you picked. Nothing else leaves this machine.'

  const path: DataPath = { summary, flows }
  if (inputs.installRoot) path.workspace = inputs.installRoot
  return path
}
