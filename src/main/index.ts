// Twofold main process: one window, local storage, and the bridge to the two APIs.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BrowserWindow, Menu, app, nativeTheme, net, protocol, session, shell } from 'electron'
import type { ChatEvent, CodeEvent, Provider, SpendSummary } from '@shared/types'
import { ChatService } from './chat'
import { CodeService } from './code/service'
import { registerIpc } from './ipc'
import { Secrets } from './secrets'
import { Store } from './store'

const here = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL)

// A separate data folder keeps tests and demos away from real conversations.
if (process.env.TWOFOLD_DATA_DIR) app.setPath('userData', path.resolve(process.env.TWOFOLD_DATA_DIR))

app.setName('Twofold')

// twofold://file/<name> serves attachments; twofold://artifact/<id> serves previews.
protocol.registerSchemesAsPrivileged([
  { scheme: 'twofold', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
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
  "img-src 'self' data: blob: twofold:",
  "font-src 'self' data:",
  'frame-src twofold:',
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
    title: 'Twofold',
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
  const store = new Store(path.join(app.getPath('userData'), 'data'))
  const secrets = new Secrets(path.join(app.getPath('userData'), 'keys.json'))

  const sendSpend = (summary: Record<Provider, SpendSummary>): void => sendToWindow('usage:update', summary)
  const chat = new ChatService(store, secrets, (event: ChatEvent) => sendToWindow('chat:event', event), sendSpend)
  const code = new CodeService(store, secrets, (event: CodeEvent) => sendToWindow('code:event', event), sendSpend)

  protocol.handle('twofold', (request) => {
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

  registerIpc({ store, secrets, chat, code, artifacts, window: () => mainWindow })
  buildMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('before-quit', () => {
    chat.stopAll()
    code.stopAll()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
