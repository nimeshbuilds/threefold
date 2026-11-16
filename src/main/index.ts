// Threefold main process: one window, local storage, and the bridge to the three APIs.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BrowserWindow, Menu, app, clipboard, nativeTheme, net, protocol, session, shell } from 'electron'
import type { ChatEvent, CliEvent, CodeEvent, Provider, SpendSummary } from '@shared/types'
import { ChatService, DEMO } from './chat'
import { CliManager } from './code/cli'
import { PermissionBridge } from './code/permissionBridge'
import { CodeService } from './code/service'
import { IncomingHandoffs, inboxDir } from './incoming'
import { registerIpc } from './ipc'
import { Secrets } from './secrets'
import { Store } from './store'

const here = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL)

// A separate data folder keeps tests and demos away from real conversations.
if (process.env.THREEFOLD_DATA_DIR) app.setPath('userData', path.resolve(process.env.THREEFOLD_DATA_DIR))

app.setName('Threefold')

/**
 * The app was first called "Twofold". Chats, projects, memory and the spend
 * ledger made under that name are copied over once. Saved API keys cannot be:
 * macOS ties their encryption to the old app, so they have to be entered again.
 */
function migrateFromPreviousName(): void {
  if (process.env.THREEFOLD_DATA_DIR) return
  try {
    const current = path.join(app.getPath('userData'), 'data')
    const previous = path.join(app.getPath('appData'), 'Twofold', 'data')
    if (fs.existsSync(current) || !fs.existsSync(previous)) return
    fs.cpSync(previous, current, { recursive: true })
  } catch {
    // Start fresh if the old data cannot be read.
  }
}

/**
 * Links opened from outside the app (macOS sends them here). The only one that
 * means anything is threefold://handoff, which the threefolds skill opens after
 * it has saved a handoff for Threefold. A link never moves the window anywhere
 * and never carries content: see incoming.ts. Links that arrive before the app
 * has started are kept until it has.
 */
const earlyLinks: string[] = []
let onWindowFocus = (): void => {}
let onLink = (url: string): void => {
  if (earlyLinks.length < 5) earlyLinks.push(url)
}
app.on('open-url', (event, url) => {
  event.preventDefault()
  onLink(String(url))
})

// Inside the window, threefold://file/<name> serves attachments and threefold://artifact/<id> serves previews.
protocol.registerSchemesAsPrivileged([
  { scheme: 'threefold', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

/** What a previewed artifact may load. It runs in a sandboxed frame with no access to the app. */
const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  'img-src data: blob: https:',
  'font-src data: https:',
  'media-src data: blob: https:',
  'connect-src https:',
].join('; ')

/** What the app's own window may load once it is built. */
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: threefold:",
  "font-src 'self' data:",
  'frame-src threefold:',
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ')

let mainWindow: BrowserWindow | null = null
const artifacts = new Map<string, string>()

function sendToWindow(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: 'Threefold',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1e1c' : '#f7f4ec',
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  // Coming back to the app: a handoff that was saved for it may be waiting.
  mainWindow.on('focus', () => onWindowFocus())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Links open in the system browser; the window itself never navigates away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    if (url !== current) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url) && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\0')) {
        void shell.openExternal(url)
      }
    }
  })

  if (isDev) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void mainWindow.loadFile(path.join(here, '../renderer/index.html'))
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => sendToWindow('menu', 'new-chat') },
        {
          label: 'Continue from a Handoff…',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => sendToWindow('menu', 'paste-handoff'),
        },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendToWindow('menu', 'settings') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Claude Mode', accelerator: 'CmdOrCtrl+1', click: () => sendToWindow('menu', 'mode-claude') },
        { label: 'ChatGPT Mode', accelerator: 'CmdOrCtrl+2', click: () => sendToWindow('menu', 'mode-chatgpt') },
        { label: 'Gemini Mode', accelerator: 'CmdOrCtrl+3', click: () => sendToWindow('menu', 'mode-gemini') },
        { label: 'Threefold Review', accelerator: 'CmdOrCtrl+4', click: () => sendToWindow('menu', 'threefold') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ type: 'separator' as const }, { role: 'reload' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

void app.whenReady().then(() => {
  migrateFromPreviousName()
  const store = new Store(path.join(app.getPath('userData'), 'data'))
  const secrets = new Secrets(path.join(app.getPath('userData'), 'keys.json'))

  const sendSpend = (summary: Record<Provider, SpendSummary>): void => sendToWindow('usage:update', summary)
  const chat = new ChatService(store, secrets, (event: ChatEvent) => sendToWindow('chat:event', event), sendSpend)
  // The official coding CLIs (Claude Code, Codex) that a session can run on, and the
  // channel through which Claude Code asks before it edits a file or runs a command.
  const cli = new CliManager((event: CliEvent) => sendToWindow('cli:event', event), { offline: DEMO })
  const bridge = new PermissionBridge(app.getPath('userData'))
  const code = new CodeService(store, secrets, (event: CodeEvent) => sendToWindow('code:event', event), sendSpend, { cli, bridge })

  // Handoffs passed in by the threefolds skill. The window asks for what is waiting
  // when it opens, so a handoff that started the app is not missed.
  let started = false
  const incoming = new IncomingHandoffs(
    inboxDir(app.getPath('userData')),
    () => clipboard.readText(),
    () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        // Before start-up has finished, the window is about to be made anyway.
        if (started) createWindow()
        return
      }
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      sendToWindow('handoff:incoming', null)
    },
  )
  onLink = (url) => void incoming.open(url)
  // A link that brings the app forward also focuses the window. The link is given a
  // moment to arrive first, so that it takes the file together with who it says sent it.
  onWindowFocus = () => void setTimeout(() => incoming.checkInbox(), 1200)
  for (const url of earlyLinks.splice(0)) onLink(url)
  // Makes this copy of the app the one that threefold:// links open. Left alone in
  // development and in tests, where it would point links at a throwaway build.
  if (app.isPackaged && !process.env.THREEFOLD_DATA_DIR) app.setAsDefaultProtocolClient('threefold')

  protocol.handle('threefold', (request) => {
    const url = new URL(request.url)
    const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    if (url.hostname === 'file') {
      const file = store.findAttachmentFile(name)
      if (!file) return new Response('Not found', { status: 404 })
      return net.fetch(pathToFileURL(file).toString())
    }
    if (url.hostname === 'artifact') {
      const html = artifacts.get(name)
      if (html === undefined) return new Response('This preview has expired. Reopen it from the chat.', { status: 404 })
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': ARTIFACT_CSP },
      })
    }
    return new Response('Not found', { status: 404 })
  })

  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.url.startsWith('file://')) {
        callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [APP_CSP] } })
      } else {
        callback({ responseHeaders: details.responseHeaders })
      }
    })
  }
  // The app never needs camera, microphone, location or notifications.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))

  registerIpc({ store, secrets, chat, code, cli, incoming, artifacts, window: () => mainWindow })
  buildMenu()
  createWindow()
  started = true

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('before-quit', () => {
    chat.stopAll()
    code.stopAll()
    cli.cancelAll()
    bridge.stop()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
