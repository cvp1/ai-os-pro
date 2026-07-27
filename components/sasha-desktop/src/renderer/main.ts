/**
 * Sasha Desktop — renderer.
 *
 * Two rules govern every line here:
 *
 *  1. NEVER innerHTML. Staged drafts are user-authored markdown from a workspace an
 *     agent writes into; treating that text as markup is exactly the injection this
 *     app must not have. Everything is createElement + textContent, and
 *     `audit:surface` fails the build if innerHTML appears anywhere in src/.
 *
 *  2. NO DECISION HAPPENS HERE. The page renders and asks; main decides and acts.
 *     Approve and Dismiss are IPC calls, one per click, never batched — propose-only
 *     survives the GUI (D61: write gates never graduate).
 */

interface BellItem {
  id: string
  kind: 'proposal' | 'dead-job'
  headline: string
  path?: string
  at: string
  detail?: string
}

interface InstallState {
  found: boolean
  root?: string
  build?: string
  problem?: string
}

interface HarnessState {
  found: boolean
  path?: string
  version?: string
  problem?: string
}

interface QuietHours {
  enabled: boolean
  startHour: number
  endHour: number
}

interface Settings {
  notifications: boolean
  quietHours: QuietHours
}

interface DoctorResult {
  ok: boolean
  output: string
  ranAt: string
  problem?: string
}

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
  onItems(callback: (items: BellItem[]) => void): void
  onSettings(callback: (settings: Settings) => void): void
  onFocusItem(callback: (id: string) => void): void
}

// This file is loaded as <script type="module">, so it is a module — the empty export
// makes that explicit to TypeScript, which `declare global` requires.
export {}

declare global {
  interface Window {
    sasha: SashaApi
  }
}

const sasha: SashaApi = window.sasha

const bellEl = document.getElementById('bell') as HTMLElement
const statusStrip = document.getElementById('status-strip') as HTMLElement
const statusText = document.getElementById('status-text') as HTMLElement
const statusDetail = document.getElementById('status-detail') as HTMLElement
const doctorOutput = document.getElementById('doctor-output') as HTMLPreElement
const runDoctorButton = document.getElementById('run-doctor') as HTMLButtonElement
const refreshButton = document.getElementById('refresh') as HTMLButtonElement
const footerSettings = document.getElementById('footer-settings') as HTMLElement

const expanded = new Set<string>()
let focusedId: string | null = null

// ---------------------------------------------------------------------------
// Small DOM helpers — createElement + textContent, never markup.
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

function relativeTime(iso: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 'recently'
  const minutes = Math.round((Date.now() - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  return new Date(then).toLocaleDateString()
}

/** `/home/craig/ai-os` → `~/ai-os`. The renderer has no `os` module, so match on the
 *  shape of the path we were handed rather than resolving a home directory. */
function shortenPath(path: string): string {
  const match = /^(\/(?:home|Users)\/[^/]+)(\/.*)?$/.exec(path)
  if (match) return `~${match[2] ?? ''}`
  return path
}

function hourLabel(hour: number): string {
  const suffix = hour < 12 ? 'am' : 'pm'
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return `${twelve}${suffix}`
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderEmpty(): void {
  // The BELL stays silent when there is nothing — that is Core doctrine and it is
  // enforced in main. A WINDOW the user deliberately opened is a different surface:
  // saying nothing at all here would just look broken. So we answer plainly, once,
  // and we do not list what was checked.
  const empty = el('div', 'empty')
  empty.appendChild(el('strong', undefined, 'Nothing needs you right now.'))
  empty.appendChild(
    el('p', undefined, 'If something gets staged for you while you are away, this is where it will be.'),
  )
  bellEl.appendChild(empty)
}

function renderCard(item: BellItem): HTMLElement {
  const card = el('article', `card ${item.kind}`)
  if (item.id === focusedId) card.classList.add('focused')

  card.appendChild(el('h3', undefined, item.headline))

  // A dead job's detail already says when it last ran; prefixing a relative time
  // printed the same fact twice in two different formats.
  const metaBits = item.kind === 'dead-job' ? [] : [relativeTime(item.at)]
  if (item.detail) metaBits.push(item.detail)
  card.appendChild(el('p', 'meta', metaBits.join(' · ')))

  const actions = el('div', 'card-actions')

  if (item.kind === 'proposal') {
    const preview = el('button', 'primary', expanded.has(item.id) ? 'Hide' : 'Read it')
    preview.addEventListener('click', () => {
      if (expanded.has(item.id)) expanded.delete(item.id)
      else expanded.add(item.id)
      void render()
    })
    actions.appendChild(preview)

    const open = el('button', 'ghost', 'Open in editor')
    open.addEventListener('click', () => {
      void sasha.openItem(item.id)
    })
    actions.appendChild(open)
  }

  const dismiss = el('button', 'ghost', item.kind === 'dead-job' ? 'Got it' : 'Not now')
  dismiss.addEventListener('click', () => {
    void sasha.dismiss(item.id).then(() => {
      expanded.delete(item.id)
      void render()
    })
  })
  actions.appendChild(dismiss)

  card.appendChild(actions)

  if (expanded.has(item.id)) {
    const pre = el('pre', 'preview', 'Reading…')
    card.appendChild(pre)
    void sasha.readItem(item.id).then((text) => {
      // textContent: the draft is shown as the text it is, never parsed as markup.
      pre.textContent = text ?? 'That file could not be read — it may have been moved or removed.'
    })
    void sasha.accept(item.id)
  }

  return card
}

async function render(): Promise<void> {
  const items = await sasha.getItems()
  clear(bellEl)

  if (items.length === 0) {
    renderEmpty()
    return
  }

  for (const item of items) bellEl.appendChild(renderCard(item))
}

function renderStatus(install: InstallState, harness: HarnessState): void {
  statusStrip.hidden = false
  statusStrip.classList.toggle('problem', !install.found || !harness.found)

  if (!install.found) {
    statusText.textContent = 'No AI-OS install found'
    statusDetail.textContent = install.problem ?? ''
    return
  }

  if (!harness.found) {
    statusText.textContent = 'Claude Code not found'
    statusDetail.textContent = harness.problem ?? ''
    return
  }

  statusText.textContent = `Watching ${shortenPath(install.root ?? '')}`
  const bits: string[] = []
  // An unknown build stamp renders as an honest blank, never as a guess.
  bits.push(install.build ? `AI-OS build ${install.build}` : 'AI-OS build not stamped')
  if (harness.version) bits.push(harness.version)
  statusDetail.textContent = bits.join(' · ')
}

function renderSettings(settings: Settings): void {
  const quiet = settings.quietHours
  const notifications = settings.notifications ? 'Notifications on' : 'Notifications off'
  const window_ = quiet.enabled
    ? `quiet ${hourLabel(quiet.startHour)}–${hourLabel(quiet.endHour)}`
    : 'quiet hours off'
  footerSettings.textContent = `${notifications} · ${window_} — change either from the tray icon.`
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

runDoctorButton.addEventListener('click', () => {
  runDoctorButton.disabled = true
  runDoctorButton.textContent = 'Running…'
  doctorOutput.hidden = false
  doctorOutput.classList.remove('problem')
  doctorOutput.textContent = 'Running /doctor in your AI-OS workspace…'

  void sasha.runDoctor().then((result) => {
    runDoctorButton.disabled = false
    runDoctorButton.textContent = 'Run /doctor'
    if (result.ok) {
      doctorOutput.textContent = result.output
    } else {
      doctorOutput.classList.add('problem')
      doctorOutput.textContent = result.problem ?? 'The check could not be run.'
    }
  })
})

refreshButton.addEventListener('click', () => {
  void sasha.refresh().then(() => render())
})

sasha.onItems(() => void render())
sasha.onSettings((settings) => renderSettings(settings))
sasha.onFocusItem((id) => {
  focusedId = id
  expanded.add(id)
  void render()
})

async function boot(): Promise<void> {
  const [install, harness, settings] = await Promise.all([
    sasha.getInstall(),
    sasha.getHarness(),
    sasha.getSettings(),
  ])
  renderStatus(install, harness)
  renderSettings(settings)
  await render()
}

void boot()
