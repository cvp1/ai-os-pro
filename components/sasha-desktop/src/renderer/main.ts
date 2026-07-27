/**
 * Sasha Desktop — renderer.
 *
 * Two rules govern every line here:
 *
 *  1. NEVER innerHTML. Model output, staged drafts, and now the user's own memory
 *     files are untrusted-shaped text; treating any of it as markup is the injection
 *     this app must not have. Everything is createElement + textContent, and
 *     `audit:surface` fails the build if innerHTML appears anywhere in src/.
 *
 *  2. NO DECISION HAPPENS HERE. The page renders and asks; main decides and acts.
 *     Sprint 2 adds three read-only panels and keeps that shape exactly: the only
 *     things this page can cause are "send a message" and "read a file main listed".
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

interface Doc {
  id: string
  name: string
  folder: 'me' | 'memory'
  bytes: number
  modified: string
  preview: string
}
interface Knowledge { me: Doc[]; memory: Doc[]; problem?: string }

interface Skill {
  name: string
  description: string
  source: 'install' | 'harness'
  path: string
  command?: string
}

type Direction = 'stays' | 'leaves' | 'unknown'
interface Flow { what: string; direction: Direction; detail: string }
interface DataPath { summary: string; flows: Flow[]; workspace?: string }

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
  getKnowledge(): Promise<Knowledge>
  readDoc(id: string): Promise<string | null>
  getSkills(): Promise<Skill[]>
  getDataPath(): Promise<DataPath>
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
const bellEl = document.getElementById('bell') as HTMLElement
const waitingBadge = document.getElementById('waiting-badge') as HTMLElement
const refreshButton = document.getElementById('refresh') as HTMLButtonElement
const viewTitle = document.getElementById('view-title') as HTMLElement
const knowledgeEl = document.getElementById('knowledge') as HTMLElement
const skillsEl = document.getElementById('skills') as HTMLElement
const datapathEl = document.getElementById('datapath') as HTMLElement
const dataSummaryEl = document.getElementById('data-summary') as HTMLElement

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

/** "3.2 KB" / "412 bytes" — size as a person reads it. */
function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** "today" / "3 days ago" — recency matters more than the timestamp. */
function humanWhen(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  if (days < 365) return `${Math.floor(days / 30)} months ago`
  return `${Math.floor(days / 365)} years ago`
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

type ViewName = 'chat' | 'waiting' | 'you' | 'skills' | 'data'

const VIEW_TITLES: Record<ViewName, string> = {
  chat: 'Chat',
  waiting: 'Waiting for you',
  you: 'What Sasha knows about you',
  skills: 'What Sasha can do',
  data: 'Where your data goes',
}

/** Panels load when first opened, not at boot: nobody waits on a tab they never click. */
const loaded = new Set<ViewName>()

function showView(view: ViewName): void {
  for (const section of Array.from(document.querySelectorAll('.view'))) {
    const isTarget = section.id === `view-${view}`
    section.classList.toggle('is-active', isTarget)
    ;(section as HTMLElement).hidden = !isTarget
  }
  for (const button of Array.from(document.querySelectorAll('.rail-item'))) {
    button.classList.toggle('is-active', (button as HTMLElement).dataset.view === view)
  }
  viewTitle.textContent = VIEW_TITLES[view]

  if (view === 'chat') inputEl.focus()
  if (view === 'you' && !loaded.has('you')) void loadKnowledge()
  if (view === 'skills' && !loaded.has('skills')) void loadSkills()
  // The data panel is always re-derived: the answer depends on the model in use,
  // and a stale privacy claim is worse than a slow one.
  if (view === 'data') void loadDataPath()
}

for (const button of Array.from(document.querySelectorAll('.rail-item'))) {
  button.addEventListener('click', () => {
    const view = (button as HTMLElement).dataset.view as ViewName | undefined
    if (view) showView(view)
  })
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

/**
 * Put text in the composer and go to the chat, WITHOUT sending it.
 *
 * This is the seam every panel uses to act. The stop-short is the point: a button in
 * a side panel proposes the words, and the user reads them and presses Send. Nothing
 * about your memory or your files changes because you clicked something in a list.
 */
function composeInChat(text: string, options: { send?: boolean } = {}): void {
  showView('chat')
  inputEl.value = text
  resizeInput()
  inputEl.focus()
  // Put the caret at the end so typing continues the sentence rather than replacing it.
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length)
  if (options.send) void submit()
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
    ? `${model.label} runs entirely on this machine — but it is a plain chat: no tools, no access to your files, no skills or memory. Slash commands need a Claude model.`
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
// Waiting (the doorbell)
// ---------------------------------------------------------------------------

const expanded = new Set<string>()

function renderBell(items: BellItem[]): void {
  clear(bellEl)
  waitingBadge.textContent = String(items.length)
  waitingBadge.hidden = items.length === 0

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

refreshButton.addEventListener('click', () => void sasha.refresh().then(renderBell))

// ---------------------------------------------------------------------------
// What Sasha knows about you
// ---------------------------------------------------------------------------

const openDocs = new Set<string>()

function renderDocGroup(
  parent: HTMLElement,
  title: string,
  blurb: string,
  docs: Doc[],
  emptyLine: string,
): void {
  const group = el('section', 'doc-group')
  group.appendChild(el('h3', undefined, title))
  group.appendChild(el('p', 'muted small', blurb))

  if (docs.length === 0) {
    group.appendChild(el('p', 'empty-line', emptyLine))
    parent.appendChild(group)
    return
  }

  for (const doc of docs) {
    const row = el('article', 'doc')

    const head = el('button', 'doc-head')
    head.appendChild(el('span', 'doc-name', doc.name))
    head.appendChild(el('span', 'doc-meta', `${humanBytes(doc.bytes)} · changed ${humanWhen(doc.modified)}`))
    if (doc.preview) head.appendChild(el('span', 'doc-preview', doc.preview))
    head.addEventListener('click', () => {
      if (openDocs.has(doc.id)) openDocs.delete(doc.id)
      else openDocs.add(doc.id)
      void loadKnowledge()
    })
    row.appendChild(head)

    if (openDocs.has(doc.id)) {
      const body = el('pre', 'doc-body', 'Reading…')
      row.appendChild(body)
      void sasha.readDoc(doc.id).then((text) => {
        body.textContent = text ?? 'That file could not be read — it may have moved.'
      })

      const actions = el('div', 'card-actions')
      // The ONLY way this panel changes anything: it writes a sentence into the
      // composer and stops. Sasha makes the change in the conversation, under the
      // install's own rules about what is worth remembering — this window never
      // becomes a second, ungoverned writer of your memory.
      const change = el('button', 'ghost small-btn', 'Ask Sasha to change this')
      change.addEventListener('click', () => {
        composeInChat(`In ${doc.id}, I'd like to change `)
      })
      actions.appendChild(change)
      row.appendChild(actions)
    }

    group.appendChild(row)
  }
  parent.appendChild(group)
}

async function loadKnowledge(): Promise<void> {
  loaded.add('you')
  const knowledge = await sasha.getKnowledge()
  clear(knowledgeEl)

  if (knowledge.problem) {
    knowledgeEl.appendChild(el('p', 'notice system', knowledge.problem))
  }

  renderDocGroup(
    knowledgeEl,
    'Things you told it',
    'Your me/ folder — who you are, what you are working on, how you want to be talked to.',
    knowledge.me,
    'Nothing here yet. Tell Sasha about yourself in the chat and it will start writing this.',
  )
  renderDocGroup(
    knowledgeEl,
    'Things it learned',
    'Its memory — lessons it kept from working with you, so you do not have to repeat yourself.',
    knowledge.memory,
    'Nothing here yet. Memory fills in as you correct it and work together.',
  )
}

const knowledgeRefresh = document.getElementById('knowledge-refresh') as HTMLButtonElement
knowledgeRefresh.addEventListener('click', () => void loadKnowledge())

// ---------------------------------------------------------------------------
// What Sasha can do
// ---------------------------------------------------------------------------

async function loadSkills(): Promise<void> {
  loaded.add('skills')
  const skills = await sasha.getSkills()
  clear(skillsEl)

  if (skills.length === 0) {
    skillsEl.appendChild(
      el(
        'p',
        'empty-line',
        'No skills found on this machine yet. Skills are folders with a SKILL.md in ' +
          'them — your AI-OS install adds some, and you can add your own.',
      ),
    )
    return
  }

  for (const skill of skills) {
    const card = el('article', 'skill')

    const head = el('div', 'skill-head')
    head.appendChild(el('h3', undefined, `/${skill.name}`))
    head.appendChild(
      el('span', `chip ${skill.source}`, skill.source === 'install' ? 'from your install' : 'from Claude Code'),
    )
    card.appendChild(head)

    if (skill.description) card.appendChild(el('p', 'skill-desc', skill.description))

    const actions = el('div', 'card-actions')
    const run = el('button', 'primary small-btn', 'Run')
    // Straight into the chat as a normal message, so the run is visible, interruptible
    // and permission-gated exactly like anything else you type. A button that ran a
    // skill invisibly would be a second, quieter way to act on the user's machine.
    run.addEventListener('click', () => composeInChat(`/${skill.name}`, { send: true }))
    actions.appendChild(run)

    const prefill = el('button', 'ghost small-btn', 'Type it out')
    prefill.addEventListener('click', () => composeInChat(`/${skill.name} `))
    actions.appendChild(prefill)
    card.appendChild(actions)

    if (skill.command) {
      // The capability without us: the same work, from a terminal, with no GUI and no
      // harness. Shown because a personal AI you cannot run without its app is not
      // really yours.
      const footer = el('div', 'skill-cli')
      footer.appendChild(el('span', 'muted small', 'Also runs on its own:'))
      footer.appendChild(el('code', undefined, skill.command))
      card.appendChild(footer)
    }

    skillsEl.appendChild(card)
  }
}

const skillsRefresh = document.getElementById('skills-refresh') as HTMLButtonElement
skillsRefresh.addEventListener('click', () => void loadSkills())

// ---------------------------------------------------------------------------
// Where your data goes
// ---------------------------------------------------------------------------

const DIRECTION_LABEL: Record<Direction, string> = {
  stays: 'stays here',
  leaves: 'leaves this machine',
  unknown: 'nothing running',
}

async function loadDataPath(): Promise<void> {
  loaded.add('data')
  const path = await sasha.getDataPath()
  dataSummaryEl.textContent = path.summary
  clear(datapathEl)

  for (const flow of path.flows) {
    const row = el('article', `flow ${flow.direction}`)
    const head = el('div', 'flow-head')
    head.appendChild(el('h3', undefined, flow.what))
    head.appendChild(el('span', `chip ${flow.direction}`, DIRECTION_LABEL[flow.direction]))
    row.appendChild(head)
    row.appendChild(el('p', 'flow-detail', flow.detail))
    datapathEl.appendChild(row)
  }

  if (path.workspace) {
    datapathEl.appendChild(el('p', 'muted small', `Workspace: ${path.workspace}`))
  }
}

const dataRefresh = document.getElementById('data-refresh') as HTMLButtonElement
dataRefresh.addEventListener('click', () => void loadDataPath())

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

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
    statusDetail.textContent = harness.problem ?? ''
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
// A notification click means "show me that one" — land on the card, not the chat.
sasha.onFocusItem(() => showView('waiting'))

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
