import { contextBridge, ipcRenderer } from 'electron'

/**
 * The bridge — the complete list of things the page is allowed to do.
 *
 * Everything the renderer can reach is on this object. There is no generic
 * "invoke any channel" escape hatch, because that would make this list decorative:
 * each method names one main-process handler and passes only primitives.
 *
 * Note what is absent: no filesystem, no child process, no network, no secret
 * access. The renderer displays what main hands it and asks main to act.
 */
const api = {
  getInstall: () => ipcRenderer.invoke('desk:get-install'),
  getHarness: () => ipcRenderer.invoke('desk:get-harness'),
  getItems: () => ipcRenderer.invoke('desk:get-items'),
  getSettings: () => ipcRenderer.invoke('desk:get-settings'),
  setSettings: (settings: unknown) => ipcRenderer.invoke('desk:set-settings', settings),

  readItem: (id: string) => ipcRenderer.invoke('desk:read-item', id),
  openItem: (id: string) => ipcRenderer.invoke('desk:open-item', id),
  accept: (id: string) => ipcRenderer.invoke('desk:accept', id),
  dismiss: (id: string) => ipcRenderer.invoke('desk:dismiss', id),

  refresh: () => ipcRenderer.invoke('desk:refresh'),
  runDoctor: () => ipcRenderer.invoke('desk:run-doctor'),

  // What Sasha knows / can do / sends. All read-only: note there is no writeDoc,
  // no saveMemory, no runSkill-that-executes. Changing what Sasha remembers goes
  // through the conversation, and running a skill goes through `send` — so it lands
  // in the transcript where you can see what it did.
  getKnowledge: () => ipcRenderer.invoke('desk:get-knowledge'),
  readDoc: (id: string) => ipcRenderer.invoke('desk:read-doc', id),
  getSkills: () => ipcRenderer.invoke('desk:get-skills'),
  getDataPath: () => ipcRenderer.invoke('desk:get-datapath'),

  // The conversation.
  getModels: () => ipcRenderer.invoke('desk:get-models'),
  getModel: () => ipcRenderer.invoke('desk:get-model'),
  selectModel: (id: string) => ipcRenderer.invoke('desk:select-model', id),
  refreshModels: () => ipcRenderer.invoke('desk:refresh-models'),
  send: (text: string) => ipcRenderer.invoke('desk:send', text),
  interrupt: () => ipcRenderer.invoke('desk:interrupt'),

  /** Streaming session events: text, thinking, tool use, turn end, errors. */
  onSession: (callback: (event: unknown) => void) => {
    ipcRenderer.on('desk:session', (_event, payload) => callback(payload))
  },
  onModels: (callback: (payload: unknown) => void) => {
    ipcRenderer.on('desk:models', (_event, payload) => callback(payload))
  },

  /** Main pushes a fresh item list after every scan. */
  onItems: (callback: (items: unknown) => void) => {
    ipcRenderer.on('desk:items', (_event, items) => callback(items))
  },
  onSettings: (callback: (settings: unknown) => void) => {
    ipcRenderer.on('desk:settings', (_event, settings) => callback(settings))
  },
  /** Clicking a notification asks the window to scroll to that card. */
  onFocusItem: (callback: (id: string) => void) => {
    ipcRenderer.on('desk:focus-item', (_event, id) => callback(String(id)))
  },
}

contextBridge.exposeInMainWorld('sasha', api)

export type SashaApi = typeof api
