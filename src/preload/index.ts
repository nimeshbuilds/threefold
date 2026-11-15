// The only surface the window can use to reach the main process.
// It exposes named functions, never ipcRenderer itself.

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ChatEvent, CliEvent, CodeEvent, Provider, SpendSummary, ThreefoldApi } from '@shared/types'

const call =
  (channel: string) =>
  (...args: unknown[]): Promise<never> =>
    ipcRenderer.invoke(channel, ...args) as Promise<never>

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: ThreefoldApi & { onMenu(listener: (command: string) => void): () => void } = {
  settings: { get: call('settings:get'), update: call('settings:update') },
  keys: { status: call('keys:status'), save: call('keys:save'), remove: call('keys:remove') },
  models: { list: call('models:list') },
  conversations: {
    list: call('conversations:list'),
    get: call('conversations:get'),
    create: call('conversations:create'),
    update: call('conversations:update'),
    fromHandoff: call('conversations:fromHandoff'),
    remove: call('conversations:remove'),
    search: call('conversations:search'),
  },
  chat: {
    send: call('chat:send'),
    handoff: call('chat:handoff'),
    stop: call('chat:stop'),
    onEvent: (listener) => subscribe<ChatEvent>('chat:event', listener),
  },
  handoff: {
    take: call('handoff:take'),
    onIncoming: (listener) => subscribe<null>('handoff:incoming', () => listener()),
  },
  skill: {
    status: call('skill:status'),
    install: call('skill:install'),
    remove: call('skill:remove'),
    saveZip: call('skill:saveZip'),
  },
  attachments: {
    pick: call('attachments:pick'),
    fromPaths: call('attachments:fromPaths'),
    fromData: call('attachments:fromData'),
    url: (attachment) => `threefold://file/${encodeURIComponent(attachment.file)}`,
    reveal: call('attachments:reveal'),
    saveAs: call('attachments:saveAs'),
    pathForFile: (file) => webUtils.getPathForFile(file),
  },
  projects: {
    list: call('projects:list'),
    create: call('projects:create'),
    update: call('projects:update'),
    addFiles: call('projects:addFiles'),
    removeFile: call('projects:removeFile'),
    remove: call('projects:remove'),
  },
  memory: {
    list: call('memory:list'),
    add: call('memory:add'),
    remove: call('memory:remove'),
    clear: call('memory:clear'),
  },
  usage: {
    summary: call('usage:summary'),
    onUpdate: (listener) => subscribe<Record<Provider, SpendSummary>>('usage:update', listener),
  },
  importer: { run: call('import:run') },
  artifacts: { register: call('artifacts:register'), save: call('artifacts:save') },
  cli: {
    status: call('cli:status'),
    install: call('cli:install'),
    login: call('cli:login'),
    loginInput: call('cli:loginInput'),
    cancel: call('cli:cancel'),
    onEvent: (listener) => subscribe<CliEvent>('cli:event', listener),
  },
  code: {
    list: call('code:list'),
    get: call('code:get'),
    create: call('code:create'),
    remove: call('code:remove'),
    send: call('code:send'),
    stop: call('code:stop'),
    respond: call('code:respond'),
    onEvent: (listener) => subscribe<CodeEvent>('code:event', listener),
  },
  app: {
    openExternal: call('app:openExternal'),
    copyText: call('app:copyText'),
    version: call('app:version'),
    platform: process.platform,
  },
  onMenu: (listener) => subscribe<string>('menu', listener),
}

contextBridge.exposeInMainWorld('threefold', api)
