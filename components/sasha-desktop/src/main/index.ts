import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  shell,
  nativeImage,
  session,
} from 'electron'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'

import { discoverInstall, aiosRoot } from './aios/discover.js'
import { findHarness, harnessVersion } from './aios/harness.js'
import { runDoctor } from './aios/doctor.js'
import { readKnowledge, readDoc } from './aios/knowledge.js'
import { discoverSkills } from './aios/skills.js'
import { describeDataPath } from './aios/datapath.js'
import { SessionManager } from './session/manager.js'
import { availableModels, defaultModel } from './session/models.js'
import type { ModelChoice } from './session/protocol.js'
import { scan } from './doorbell/watcher.js'
import { loadState, saveState, statePath, type DeskState } from './doorbell/state.js'
import { recordUsage } from './doorbell/usage.js'
import { isQuiet, describeQuietHours } from './quiet-hours.js'
import { DEFAULT_SETTINGS, type BellItem, type InstallState, type Settings } from './types.js'

/**
 * Sasha Desktop — main process.
 *
 * This is the only privileged code in the app. The renderer is sandboxed, isolated,
 * and speaks to this file through a fixed set of IPC channels declared in the preload.
 * Nothing here reaches the network; the only outbound traffic on the machine is the
 * user's own Claude Code talking to the user's own provider.
 */

/**
 * SILENCE CHROMIUM'S OWN PHONE-HOME. This must run before `app.whenReady()`.
 *
 * Writing no network code is not enough to make "this app makes no network calls"
 * true: Chromium ships its own background traffic. A fresh profile contacts Google's
 * component updater (`redirector.gvt1.com`) within seconds of launch, entirely
 * outside our code. The zero-telemetry probe caught exactly that on the first
 * full-suite run — which is the reason the probe exists.
 *
 * These switches turn that machinery off. `disable-background-networking` is the
 * broad one (component updater, variations/field-trial seed, safe-browsing updates);
 * the other two are named explicitly so a future Electron narrowing the umbrella
 * flag cannot quietly re-open a channel.
 */
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('disable-domain-reliability')

const POLL_INTERVAL_MS = 30_000

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let pollTimer: NodeJS.Timeout | null = null

let install: InstallState = { found: false }
let state: DeskState = { dismissed: {}, notified: {}, settings: { ...DEFAULT_SETTINGS } }
let items: BellItem[] = []
let chat: SessionManager | null = null
let models: ModelChoice[] = []

function deskStatePath(): string {
  return statePath(app.getPath('userData'))
}

function persist(): void {
  saveState(deskStatePath(), state)
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return
  }

  mainWindow = new BrowserWindow({
    width: 780,
    height: 620,
    minWidth: 520,
    minHeight: 420,
    show: false,
    title: 'Sasha — a personal AI that is yours',
    backgroundColor: '#14110e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The three that matter, set explicitly rather than trusting a default that
      // could change under us in a future Electron. audit:surface requires them.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  // Show on first paint — but never depend on it. `ready-to-show` does not fire if
  // the renderer fails to reach a first frame, and the result is a process that is
  // running perfectly with no window on screen: indistinguishable, to the user, from
  // an app that did not start. The fallback guarantees a window either way.
  let shown = false
  const reveal = () => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return
    shown = true
    mainWindow.show()
  }
  mainWindow.once('ready-to-show', reveal)
  const revealTimer = setTimeout(() => {
    if (!shown) {
      console.error('[sasha] renderer did not reach first paint within 4s — showing the window anyway.')
      reveal()
    }
  }, 4000)

  // Renderer failures must be visible in the log rather than swallowed.
  mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error(`[sasha] failed to load ${url}: ${description} (${code})`)
    reveal()
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[sasha] renderer process gone: ${details.reason}`)
  })
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error(`[sasha] preload failed (${preloadPath}): ${error.message}`)
  })
  mainWindow.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error(`[renderer] ${event.message}`)
  })

  mainWindow.on('closed', () => {
    clearTimeout(revealTimer)
    mainWindow = null
  })

  // Nothing remote, ever: block navigation and refuse to open child windows.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // The page has no legitimate use for camera, mic, location or notifications —
  // notifications are fired from the main process, not requested by the renderer.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  )

  void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))

}

// ---------------------------------------------------------------------------
// The doorbell
// ---------------------------------------------------------------------------

/**
 * Latched off when the desktop's notification service turns out to be unusable.
 *
 * This is not hypothetical. On Linux, `Notification.show()` goes through libnotify to
 * a D-Bus notification daemon; when no daemon is listening, that call BLOCKS the main
 * process for the full D-Bus timeout — about 25 seconds. Blocking the main process
 * blocks everything: the window cannot paint, timers do not fire, the UI is frozen.
 *
 * We hit this for real. With something waiting in the workspace, the app started, the
 * doorbell tried to ring, and the window never appeared at all — a secondary feature
 * silently preventing the primary one. So: time the call, and if it stalls, stop
 * ringing for the rest of the session and say why. A doorbell that cannot ring is a
 * small loss; an app that will not open is a total one.
 */
let notificationsUsable = true
const NOTIFY_STALL_MS = 2000

/**
 * Ask — off the main thread — whether anything is actually listening for
 * notifications, BEFORE we ever call a blocking API.
 *
 * The stall detector below is a backstop, not a cure: by the time it measures 25
 * seconds, the user has already watched the app hang for 25 seconds. The only way to
 * avoid the freeze is to not make the call at all, which means knowing in advance.
 *
 * A session bus existing is NOT enough — this machine has one and still has no
 * notification daemon on it. The question is specifically whether
 * `org.freedesktop.Notifications` has an owner, which a short-lived child process can
 * answer without blocking us.
 *
 * Unknown resolves to "unavailable". Losing the bell is a small, visible loss; a
 * frozen window is a total one, so the ambiguous case degrades toward the app that
 * still works.
 */
function probeNotificationService(): Promise<boolean> {
  // An explicit opt-out, for headless boxes, CI, and anyone who wants the window
  // without the bell. Also the honest answer to a case the probe below CANNOT
  // detect: a daemon that owns the D-Bus name but never replies (a wedged daemon, or
  // a session whose daemon belongs to a different display). NameHasOwner says "yes"
  // and the call still blocks for over a minute. When that is your situation, this
  // switch is the fix.
  if (process.env.SASHA_NO_NOTIFICATIONS === '1') return Promise.resolve(false)

  // macOS and Windows use native APIs that do not have this failure mode.
  if (process.platform !== 'linux') return Promise.resolve(true)

  const attempts: [string, string[]][] = [
    [
      'gdbus',
      ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
       '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.freedesktop.Notifications'],
    ],
    ['busctl', ['--user', 'status', 'org.freedesktop.Notifications']],
  ]

  return new Promise((resolve) => {
    let index = 0
    const next = (): void => {
      const attempt = attempts[index++]
      if (!attempt) {
        console.error(
          '[sasha] could not determine whether a notification daemon is running; ' +
            'notifications are off. Waiting items still appear in the window.',
        )
        resolve(false)
        return
      }
      const [command, args] = attempt
      execFile(command, args, { timeout: 2500 }, (error, stdout) => {
        if (error) {
          next()
          return
        }
        resolve(command === 'gdbus' ? /true/.test(stdout) : true)
      })
    }
    next()
  })
}

function ring(item: BellItem): void {
  if (!notificationsUsable || !Notification.isSupported()) return

  try {
    const notification = new Notification({
      title: item.kind === 'dead-job' ? 'Sasha — something stopped' : 'Sasha',
      body: item.headline,
      silent: false,
    })

    // Clicking opens the window on the card. The decision itself always happens in
    // the window, never on the notification: propose-only means you see the whole
    // thing before you approve it, and a notification button is too easy to hit.
    notification.on('click', () => {
      createWindow()
      mainWindow?.webContents.send('desk:focus-item', item.id)
    })

    const started = Date.now()
    notification.show()
    const elapsed = Date.now() - started

    if (elapsed > NOTIFY_STALL_MS) {
      notificationsUsable = false
      console.error(
        `[sasha] the desktop notification service took ${elapsed}ms and is blocking the app — ` +
          'notifications are off for this session. Items still appear in the window. ' +
          '(On Linux this usually means no notification daemon is running.)',
      )
      updateTray()
      mainWindow?.webContents.send('desk:notifications-unavailable')
    }
  } catch (error) {
    notificationsUsable = false
    console.error('[sasha] notifications unavailable:', error)
  }
}

function refresh(options: { allowRing: boolean }): void {
  if (!install.found || !install.root) return

  const now = new Date()
  const result = scan(install.root, state, now)
  items = result.items

  const quiet = isQuiet(state.settings.quietHours, now)
  const shouldRing =
    options.allowRing && result.bell !== null && state.settings.notifications && !quiet

  if (result.bell && shouldRing) {
    ring(result.bell)
    // Edge-trigger: mark it rung so the next poll in 30 seconds stays silent.
    state.notified[result.bell.id] = now.toISOString()
    persist()
  } else if (result.bell && quiet) {
    // Quiet hours: the item waits, it is not lost and it is not marked as rung, so
    // the bell can still ring for it once the window ends.
  }

  updateTray()
  mainWindow?.webContents.send('desk:items', items)
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function trayIcon(): Electron.NativeImage {
  const path = join(__dirname, '../../resources/trayTemplate.png')
  try {
    const icon = nativeImage.createFromPath(path)
    if (!icon.isEmpty()) {
      // A template image is black + alpha; macOS tints it for light/dark menu bars
      // and Electron picks up the @2x variant beside it automatically.
      icon.setTemplateImage(true)
      return icon
    }
  } catch {
    // Fall through to the warning below.
  }
  // Loudly, not silently: an empty tray image renders an INVISIBLE menu-bar item on
  // macOS. Since the app lives in the tray, that reads to the user as "it didn't
  // start" — a missing asset must never fail quietly here.
  console.error(`[sasha] tray icon missing or unreadable at ${path} — the menu-bar icon will be invisible.`)
  return nativeImage.createEmpty()
}

function updateTray(): void {
  if (!tray) return

  const waiting = items.length
  const quiet = isQuiet(state.settings.quietHours, new Date())

  tray.setToolTip(
    waiting === 0
      ? 'Sasha — nothing waiting'
      : `Sasha — ${waiting} thing${waiting === 1 ? '' : 's'} waiting`,
  )

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: waiting === 0 ? 'Nothing waiting' : `${waiting} waiting`,
        enabled: false,
      },
      { type: 'separator' },
      { label: 'Open Sasha', click: () => createWindow() },
      { label: 'Check now', click: () => refresh({ allowRing: true }) },
      { type: 'separator' },
      {
        label: notificationsUsable
          ? `Notifications${state.settings.notifications ? '' : ' (off)'}`
          : 'Notifications unavailable on this desktop',
        type: 'checkbox',
        checked: state.settings.notifications && notificationsUsable,
        enabled: notificationsUsable,
        click: () => {
          state.settings.notifications = !state.settings.notifications
          persist()
          updateTray()
          mainWindow?.webContents.send('desk:settings', state.settings)
        },
      },
      {
        label: `Quiet hours ${describeQuietHours(state.settings.quietHours)}${quiet ? ' — quiet now' : ''}`,
        type: 'checkbox',
        checked: state.settings.quietHours.enabled,
        click: () => {
          state.settings.quietHours.enabled = !state.settings.quietHours.enabled
          persist()
          updateTray()
          mainWindow?.webContents.send('desk:settings', state.settings)
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  )
}

// ---------------------------------------------------------------------------
// IPC — the entire surface the renderer can reach
// ---------------------------------------------------------------------------

/**
 * A path is openable only if it is one we ourselves surfaced in the current scan.
 * Not "looks like it is under the root" — literally an item we produced. The
 * renderer cannot ask us to open an arbitrary path by constructing one.
 */
function openableItem(id: string): BellItem | undefined {
  const item = items.find((candidate) => candidate.id === id)
  if (!item?.path || !install.root) return undefined
  const relativePath = relative(resolve(install.root), resolve(item.path))
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return undefined
  return item
}

function usagePath(): string {
  return join(install.root ?? aiosRoot(), '.aios-usage.jsonl')
}

function registerIpc(): void {
  ipcMain.handle('desk:get-install', () => install)
  ipcMain.handle('desk:get-items', () => items)
  ipcMain.handle('desk:get-settings', (): Settings => state.settings)

  ipcMain.handle('desk:get-harness', async () => {
    const harness = findHarness()
    if (harness.found && harness.path) {
      const version = await harnessVersion(harness.path)
      if (version) harness.version = version
    }
    return harness
  })

  /** Read one staged draft for display. Only items we surfaced; bounded read. */
  ipcMain.handle('desk:read-item', (_event, id: unknown) => {
    if (typeof id !== 'string') return null
    const item = openableItem(id)
    if (!item?.path) return null
    try {
      return readFileSync(item.path, 'utf8').slice(0, 200_000)
    } catch {
      return null
    }
  })

  /** "I opened it" — the Core convention's proposal_accepted. */
  ipcMain.handle('desk:accept', (_event, id: unknown) => {
    if (typeof id !== 'string') return false
    const item = openableItem(id)
    if (!item) return false
    recordUsage(usagePath(), 'proposal_accepted', new Date())
    state.notified[id] = new Date().toISOString()
    persist()
    return true
  })

  /** "I waved it off" — dismissed forever, per the Core doorbell's rule. */
  ipcMain.handle('desk:dismiss', (_event, id: unknown) => {
    if (typeof id !== 'string') return false
    if (!items.some((item) => item.id === id)) return false
    state.dismissed[id] = new Date().toISOString()
    recordUsage(usagePath(), 'proposal_dismissed', new Date())
    persist()
    refresh({ allowRing: false })
    return true
  })

  /** Open the staged draft in whatever the OS uses for that file type. */
  ipcMain.handle('desk:open-item', async (_event, id: unknown) => {
    if (typeof id !== 'string') return false
    const item = openableItem(id)
    if (!item?.path) return false
    recordUsage(usagePath(), 'proposal_accepted', new Date())
    state.notified[id] = new Date().toISOString()
    persist()
    const error = await shell.openPath(item.path)
    return error === ''
  })

  ipcMain.handle('desk:run-doctor', () => runDoctor(install))

  // --- what Sasha knows, what it can do, where the data goes -----------------

  /**
   * READ-ONLY, and there is no sibling that writes. Changing memory or me/ happens
   * by asking Sasha in the conversation, where the install's own rules about what is
   * worth remembering still apply. The panel routes; it does not edit.
   */
  ipcMain.handle('desk:get-knowledge', () => {
    if (!install.found || !install.root) {
      return { me: [], memory: [], problem: install.problem ?? 'No AI-OS install found.' }
    }
    return readKnowledge(install.root)
  })

  ipcMain.handle('desk:read-doc', (_event, id: unknown) => {
    if (typeof id !== 'string' || !install.root) return null
    return readDoc(install.root, id)
  })

  ipcMain.handle('desk:get-skills', () => discoverSkills(install.root))

  ipcMain.handle('desk:get-datapath', () => {
    const harness = findHarness()
    const selected = models.find((choice) => choice.id === chat?.modelId)
    return describeDataPath({
      modelLabel: selected?.label ?? null,
      provider: selected?.provider ?? null,
      local: selected?.local ?? false,
      harnessFound: harness.found,
      harnessPath: harness.path,
      installRoot: install.root,
    })
  })

  // --- the conversation -----------------------------------------------------

  ipcMain.handle('desk:get-models', () => models)
  ipcMain.handle('desk:get-model', () => chat?.modelId ?? null)

  ipcMain.handle('desk:select-model', (_event, modelId: unknown) => {
    if (typeof modelId !== 'string' || !chat) return false
    if (!models.some((choice) => choice.id === modelId)) return false
    void chat.select(modelId, models)
    state.settings.lastModel = modelId
    persist()
    return true
  })

  ipcMain.handle('desk:send', async (_event, text: unknown) => {
    if (typeof text !== 'string' || text.trim() === '' || !chat) return false
    return chat.send(text)
  })

  ipcMain.handle('desk:interrupt', () => {
    chat?.interrupt()
    return true
  })

  ipcMain.handle('desk:refresh-models', async () => {
    models = await availableModels(findHarness().found)
    return models
  })

  ipcMain.handle('desk:refresh', () => {
    refresh({ allowRing: false })
    return items
  })

  ipcMain.handle('desk:set-settings', (_event, next: unknown) => {
    if (typeof next !== 'object' || next === null) return state.settings
    const candidate = next as Partial<Settings>
    if (typeof candidate.notifications === 'boolean') {
      state.settings.notifications = candidate.notifications
    }
    if (candidate.quietHours && typeof candidate.quietHours === 'object') {
      const quiet = candidate.quietHours
      if (typeof quiet.enabled === 'boolean') state.settings.quietHours.enabled = quiet.enabled
      const validHour = (h: unknown): h is number =>
        typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23
      if (validHour(quiet.startHour)) state.settings.quietHours.startHour = quiet.startHour
      if (validHour(quiet.endHour)) state.settings.quietHours.endHour = quiet.endHour
    }
    persist()
    updateTray()
    return state.settings
  })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => createWindow())

  app.whenReady().then(() => {
    // The last phone-home, and the one that actually fired: Chromium downloads a
    // hunspell spellcheck dictionary from gvt1.com on first run. Setting
    // `spellcheck: false` on the window does NOT prevent it — the download belongs to
    // the session, not the BrowserWindow — so it has to be turned off here. Traced
    // from a net-log after the probe flagged the connection; the URL was
    // `/edgedl/chrome/dict/en-us-10-1.bdic`.
    session.defaultSession.setSpellCheckerEnabled(false)
    // Disabling it is not sufficient on its own — Chromium still resolves a
    // dictionary URL — so the download endpoint is also pointed at nothing.
    session.defaultSession.setSpellCheckerDictionaryDownloadURL('https://0.0.0.0/')

    state = loadState(deskStatePath())
    install = discoverInstall()

    // The conversation is the product; stand it up before the window opens so the
    // first thing the user sees is a session ready for a message.
    const harness = findHarness()
    chat = new SessionManager(
      harness.path,
      install.root ?? aiosRoot(),
      state.settings.permissionMode,
    )
    chat.onEvent((event) => mainWindow?.webContents.send('desk:session', event))

    void availableModels(harness.found).then((choices) => {
      models = choices
      const chosen = defaultModel(choices, state.settings.lastModel)
      if (chosen) void chat?.select(chosen, choices)
      mainWindow?.webContents.send('desk:models', { models, selected: chosen })
    })

    registerIpc()

    // A tray failure must never cost the user the window. The window is the product;
    // the tray is how you get back to it.
    try {
      tray = new Tray(trayIcon())
      updateTray()
      tray.on('click', () => createWindow())
    } catch (error) {
      console.error('[sasha] could not create the tray icon:', error)
      tray = null
    }

    createWindow()

    // THE WINDOW COMES FIRST. Scanning and ringing touch system services that can
    // stall (see `ring`), so they must never sit between startup and a visible
    // window. One tick of daylight is enough for the renderer to paint and show.
    // Settle the notification question BEFORE the first scan, so the doorbell can
    // never make a blocking call on a desktop that cannot service it.
    void probeNotificationService().then((usable) => {
      if (!usable) {
        notificationsUsable = false
        console.error('[sasha] no notification daemon found — the bell is off; items still show in the window.')
        updateTray()
      }
      refresh({ allowRing: true })
      pollTimer = setInterval(() => refresh({ allowRing: true }), POLL_INTERVAL_MS)
    })

    app.on('activate', () => createWindow())
  })

  // The app lives in the tray; closing the window is not quitting.
  app.on('window-all-closed', () => {
    // Deliberately empty: a doorbell you closed is still a doorbell.
  })

  app.on('before-quit', () => {
    if (pollTimer) clearInterval(pollTimer)
    persist()
  })
}
