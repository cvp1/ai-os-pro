/**
 * Sasha Desktop — renderer.
 *
 * Two rules govern every line here:
 *
 *  1. NEVER innerHTML. Model output and staged drafts are untrusted-shaped text;
 *     treating either as markup is the injection this app must not have. Everything
 *     is createElement + textContent, and `audit:surface` fails the build if
 *     innerHTML appears anywhere in src/.
 *
 *  2. NO DECISION HAPPENS HERE. The page renders and asks; main decides and acts.
 */

export {}

interface BellItem {
  id: string
  kind: 'proposal' | 'dead-job'
  headline: string
  path?: string
  at: string
  detail?: string
}

interface InstallState { found: boolean; root?: string; build?: string; problem?: string }
interface HarnessState { found: boolean; path?: string; version?: string; problem?: string }
interface QuietHours { enabled: boolean; startHour: number; endHour: number }
interface Settings { notifications: boolean; quietHours: QuietHours; lastModel?: string; permissionMode: string }
interface DoctorResult { ok: boolean; output: string; ranAt: string; problem?: string }

interface ModelChoice {
  id: string
  label: string
  provider: 'claude' | 'ollama'
  detail: string
  local: boolean
}

type SessionEvent =
  | { kind: 'ready'; sessionId: string; model: string; tools: string[]; cwd: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; summary: string; id: string }
  | { kind: 'tool-result'; id: string; ok: boolean; summary: string }
  | { kind: 'turn-end'; costUsd?: number; durationMs?: number; inputTokens?: number; outputTokens?: number }
  | { kind: 'error'; message: string }
  | { kind: 'closed'; code: number | null }
  | { kind: 'status'; text: string }

interface SashaApi {
  getInstall(): Promise<InstallState>
  getHarness(): Promise<HarnessState>
  getItems(): Promise<BellItem[]>
  getSettings(): Promise<Settings>
  setSettings(settings: Partial<Settings>): Promise<Settings>
  readItem(id: string): Promise<string | null>
  openItem(id: string): Promise<boolean>
  accept(id: string): Promise<boolean>
  dismiss(id: string): Promise<boolean>
  refresh(): Promise<BellItem[]>
  runDoctor(): Promise<DoctorResult>
  getModels(): Promise<ModelChoice[]>
  getModel(): Promise<string | null>
  selectModel(id: string): Promise<boolean>
  refreshModels(): Promise<ModelChoice[]>
  send(text: string): Promise<boolean>
  interrupt(): Promise<boolean>
  onItems(cb: (items: BellItem[]) => void): void
  onSettings(cb: (settings: Settings) => void): void
  onFocusItem(cb: (id: string) => void): void
  onSession(cb: (event: SessionEvent) => void): void
  onModels(cb: (payload: { models: ModelChoice[]; selected: string | null }) => void): void
}

declare global {
  interface Window { sasha: SashaApi }
}

const sasha: SashaApi = window.sasha

const transcriptEl = document.getElementById('transcript') as HTMLElement
const inputEl = document.getElementById('input') as HTMLTextAreaElement
const sendButton = document.getElementById('send') as HTMLButtonElement
const stopButton = document.getElementById('stop') as HTMLButtonElement
const modelSelect = document.getElementById('model-select') as HTMLSelectElement
const hintEl = document.getElementById('composer-hint') as HTMLElement
const statusStrip = document.getElementById('status-strip') as HTMLElement
const statusText = document.getElementById('status-text') as HTMLElement
const statusDetail = document.getElementById('status-detail') as HTMLElement
const bellDrawer = document.getElementById('bell-drawer') as HTMLElement
const bellEl = document.getElementById('bell') as HTMLElement
const bellToggle = document.getElementById('bell-toggle') as HTMLButtonElement
const refreshButton = document.getElementById('refresh') as HTMLButtonElement

// ---------------------------------------------------------------------------
// DOM helpers — createElement + textContent, never markup.
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

/** Keep the newest content visible unless the user has scrolled up to read. */
function scrollIfPinned(): void {
  const nearBottom =
    transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 120
  if (nearBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

let currentTurn: {
  wrapper: HTMLElement
  text: HTMLElement | null
  thinking: HTMLElement | null
  thinkingBody: HTMLElement | null
} | null = null

let busy = false

function setBusy(next: boolean): void {
  busy = next
  sendButton.disabled = next
  sendButton.textContent = next ? 'Working…' : 'Send'
  stopButton.hidden = !next
}

function addUserMessage(text: string): void {
  const row = el('article', 'msg user')
  row.appendChild(el('div', 'who', 'You'))
  row.appendChild(el('div', 'body', text))
  transcriptEl.appendChild(row)
  transcriptEl.scrollTop = transcriptEl.scrollHeight
}

function beginAssistantTurn(): void {
  const wrapper = el('article', 'msg assistant')
  wrapper.appendChild(el('div', 'who', 'Sasha'))
  transcriptEl.appendChild(wrapper)
  currentTurn = { wrapper, text: null, thinking: null, thinkingBody: null }
}

function ensureTurn(): NonNullable<typeof currentTurn> {
  if (!currentTurn) beginAssistantTurn()
  return currentTurn as NonNullable<typeof currentTurn>
}

function appendText(chunk: string): void {
  const turn = ensureTurn()
  if (!turn.text) {
    turn.text = el('div', 'body')
    turn.wrapper.appendChild(turn.text)
  }
  turn.text.textContent = (turn.text.textContent ?? '') + chunk
  scrollIfPinned()
}

function appendThinking(chunk: string): void {
  const turn = ensureTurn()
  if (!turn.thinking) {
    // Reasoning is shown but folded away: visible if you want it, never in the way.
    const details = el('details', 'thinking')
    const summary = el('summary', undefined, 'Thinking')
    const body = el('div', 'thinking-body')
    details.appendChild(summary)
    details.appendChild(body)
    turn.wrapper.appendChild(details)
    turn.thinking = details
    turn.thinkingBody = body
  }
  if (turn.thinkingBody) {
    turn.thinkingBody.textContent = (turn.thinkingBody.textContent ?? '') + chunk
  }
  scrollIfPinned()
}

function appendTool(event: Extract<SessionEvent, { kind: 'tool' }>): void {
  const turn = ensureTurn()
  const row = el('div', 'tool')
  row.dataset.toolId = event.id
  row.appendChild(el('span', 'tool-name', event.name))
  row.appendChild(el('span', 'tool-summary', event.summary))
  const state = el('span', 'tool-state', '…')
  row.appendChild(state)
  turn.wrapper.appendChild(row)
  // A new tool call ends the current text block, so following prose starts fresh.
  turn.text = null
  scrollIfPinned()
}

function finishTool(event: Extract<SessionEvent, { kind: 'tool-result' }>): void {
  const row = transcriptEl.querySelector(`[data-tool-id="${CSS.escape(event.id)}"]`)
  const state = row?.querySelector('.tool-state')
  if (state) {
    state.textContent = event.ok ? 'done' : 'failed'
    if (!event.ok) state.classList.add('failed')
  }
}

function endTurn(event: Extract<SessionEvent, { kind: 'turn-end' }>): void {
  const turn = currentTurn
  currentTurn = null
  setBusy(false)
  if (!turn) return

  const bits: string[] = []
  if (typeof event.durationMs === 'number') bits.push(`${(event.durationMs / 1000).toFixed(1)}s`)
  if (typeof event.inputTokens === 'number' && typeof event.outputTokens === 'number') {
    bits.push(`${event.inputTokens.toLocaleString()} in · ${event.outputTokens.toLocaleString()} out`)
  }
  // Local inference genuinely costs nothing; say so instead of hiding the field.
  if (typeof event.costUsd === 'number') {
    bits.push(event.costUsd === 0 ? 'no API cost' : `$${event.costUsd.toFixed(4)}`)
  }
  if (bits.length > 0) turn.wrapper.appendChild(el('div', 'turn-meta', bits.join(' · ')))
  scrollIfPinned()
}

function addNotice(text: string, variant: 'error' | 'system'): void {
  transcriptEl.appendChild(el('div', `notice ${variant}`, text))
  scrollIfPinned()
}

function renderEmptyTranscript(): void {
  const empty = el('div', 'empty')
  empty.appendChild(el('strong', undefined, 'Ask Sasha anything.'))
  empty.appendChild(
    el(
      'p',
      undefined,
      'This is your Claude Code session in a window — the same skills, the same memory, the same files. Slash commands work: try /status or /brief.',
    ),
  )
  transcriptEl.appendChild(empty)
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function submit(): Promise<void> {
  const text = inputEl.value.trim()
  if (text === '' || busy) return

  const empty = transcriptEl.querySelector('.empty')
  if (empty) empty.remove()

  addUserMessage(text)
  inputEl.value = ''
  resizeInput()
  setBusy(true)

  const ok = await sasha.send(text)
  if (!ok) setBusy(false)
}

function resizeInput(): void {
  inputEl.style.height = 'auto'
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 200)}px`
}

inputEl.addEventListener('input', resizeInput)
inputEl.addEventListener('keydown', (event) => {
  // Enter sends; Shift+Enter is a newline — the convention people already expect.
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void submit()
  }
})
sendButton.addEventListener('click', () => void submit())
stopButton.addEventListener('click', () => {
  void sasha.interrupt()
  setBusy(false)
})

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function renderModels(models: ModelChoice[], selected: string | null): void {
  clear(modelSelect)

  if (models.length === 0) {
    const option = el('option', undefined, 'No models available')
    option.value = ''
    modelSelect.appendChild(option)
    modelSelect.disabled = true
    hintEl.textContent =
      'No model is available: Claude Code was not found, and Ollama is not running on this machine.'
    return
  }

  modelSelect.disabled = false
  const groups: { label: string; items: ModelChoice[] }[] = [
    { label: 'Claude — your Claude Code login', items: models.filter((m) => m.provider === 'claude') },
    { label: 'Local — never leaves this machine', items: models.filter((m) => m.provider === 'ollama') },
  ]

  for (const group of groups) {
    if (group.items.length === 0) continue
    const optgroup = document.createElement('optgroup')
    optgroup.label = group.label
    for (const model of group.items) {
      const option = el('option', undefined, model.label)
      option.value = model.id
      option.title = model.detail
      if (model.id === selected) option.selected = true
      optgroup.appendChild(option)
    }
    modelSelect.appendChild(optgroup)
  }

  updateHint(models, selected)
}

function updateHint(models: ModelChoice[], selected: string | null): void {
  const model = models.find((m) => m.id === selected)
  if (!model) {
    hintEl.textContent = ''
    return
  }
  hintEl.textContent = model.local
    ? `${model.label} runs on this machine — nothing leaves it.`
    : `${model.label} · ${model.detail}`
}

modelSelect.addEventListener('change', () => {
  const id = modelSelect.value
  if (!id) return
  void sasha.selectModel(id).then(async () => {
    const models = await sasha.getModels()
    updateHint(models, id)
    // Switching model starts a fresh session — say so rather than letting the user
    // assume the new model has read everything above.
    addNotice(`Switched to ${models.find((m) => m.id === id)?.label ?? id}. This starts a new session; the conversation above is history.`, 'system')
  })
})

// ---------------------------------------------------------------------------
// The doorbell drawer
// ---------------------------------------------------------------------------

const expanded = new Set<string>()

function renderBell(items: BellItem[]): void {
  clear(bellEl)
  bellToggle.textContent = items.length === 0 ? 'Waiting' : `Waiting (${items.length})`
  bellToggle.classList.toggle('has-items', items.length > 0)

  if (items.length === 0) {
    bellEl.appendChild(el('p', 'muted small', 'Nothing needs you right now.'))
    return
  }

  for (const item of items) {
    const card = el('article', `card ${item.kind}`)
    card.appendChild(el('h3', undefined, item.headline))
    if (item.detail) card.appendChild(el('p', 'meta', item.detail))

    const actions = el('div', 'card-actions')
    if (item.kind === 'proposal') {
      const read = el('button', 'primary small-btn', expanded.has(item.id) ? 'Hide' : 'Read it')
      read.addEventListener('click', () => {
        if (expanded.has(item.id)) expanded.delete(item.id)
        else expanded.add(item.id)
        void sasha.getItems().then(renderBell)
      })
      actions.appendChild(read)

      const open = el('button', 'ghost small-btn', 'Open in editor')
      open.addEventListener('click', () => void sasha.openItem(item.id))
      actions.appendChild(open)
    }

    const dismiss = el('button', 'ghost small-btn', item.kind === 'dead-job' ? 'Got it' : 'Not now')
    dismiss.addEventListener('click', () => {
      void sasha.dismiss(item.id).then(() => sasha.getItems().then(renderBell))
    })
    actions.appendChild(dismiss)
    card.appendChild(actions)

    if (expanded.has(item.id)) {
      const pre = el('pre', 'preview', 'Reading…')
      card.appendChild(pre)
      void sasha.readItem(item.id).then((text) => {
        pre.textContent = text ?? 'That file could not be read — it may have moved.'
      })
      void sasha.accept(item.id)
    }

    bellEl.appendChild(card)
  }
}

bellToggle.addEventListener('click', () => {
  bellDrawer.hidden = !bellDrawer.hidden
})
refreshButton.addEventListener('click', () => void sasha.refresh().then(renderBell))

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function shortenPath(path: string): string {
  const match = /^(\/(?:home|Users)\/[^/]+)(\/.*)?$/.exec(path)
  return match ? `~${match[2] ?? ''}` : path
}

function renderStatus(install: InstallState, harness: HarnessState): void {
  if (install.found && harness.found) {
    statusStrip.hidden = true
    return
  }
  statusStrip.hidden = false
  statusStrip.classList.add('problem')
  if (!install.found) {
    statusText.textContent = 'No AI-OS install found'
    statusDetail.textContent = install.problem ?? ''
  } else {
    statusText.textContent = 'Claude Code not found'
    statusDetail.textContent =
      (harness.problem ?? '') + ' Local models still work if Ollama is running.'
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

sasha.onSession((event) => {
  switch (event.kind) {
    case 'text':
      appendText(event.text)
      break
    case 'thinking':
      appendThinking(event.text)
      break
    case 'tool':
      appendTool(event)
      break
    case 'tool-result':
      finishTool(event)
      break
    case 'turn-end':
      endTurn(event)
      break
    case 'error':
      addNotice(event.message, 'error')
      setBusy(false)
      break
    case 'closed':
      if (busy) {
        addNotice('The session ended before finishing that turn.', 'error')
        setBusy(false)
      }
      break
    case 'ready':
    case 'status':
      break
  }
})

sasha.onModels((payload) => renderModels(payload.models, payload.selected))
sasha.onItems((items) => renderBell(items))

async function boot(): Promise<void> {
  const [install, harness, items, models, selected] = await Promise.all([
    sasha.getInstall(),
    sasha.getHarness(),
    sasha.getItems(),
    sasha.getModels(),
    sasha.getModel(),
  ])
  renderStatus(install, harness)
  renderBell(items)
  renderModels(models, selected)
  renderEmptyTranscript()
  inputEl.focus()
}

void boot()
