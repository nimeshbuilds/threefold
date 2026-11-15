// Every request the window can make of the main process is registered here.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import type {
  Attachment,
  Conversation,
  ModelOption,
  PermissionDecision,
  Project,
  Provider,
  SendRequest,
  Settings,
} from '@shared/types'
import { MODELS } from '@shared/pricing'
import { ChatService, DEMO } from './chat'
import { CodeService } from './code/service'
import { importExport } from './importService'
import { claudeErrorMessage, verifyClaudeKey } from './providers/anthropic'
import { openaiErrorMessage, verifyOpenAIKey } from './providers/openai'
import type { Secrets } from './secrets'
import type { Store } from './store'

export interface IpcDeps {
  store: Store
  secrets: Secrets
  chat: ChatService
  code: CodeService
  artifacts: Map<string, string>
  window: () => BrowserWindow | null
}

function isProvider(value: unknown): value is Provider {
  return value === 'claude' || value === 'chatgpt'
}

export function registerIpc(deps: IpcDeps): void {
  const { store, secrets, chat, code, artifacts } = deps
  const modelsCache = path.join(store.dir, 'available-models.json')

  const readAvailable = (): Partial<Record<Provider, string[]>> => {
    try {
      return JSON.parse(fs.readFileSync(modelsCache, 'utf8')) as Partial<Record<Provider, string[]>>
    } catch {
      return {}
    }
  }

  const handle = <Args extends unknown[], Result>(
    channel: string,
    listener: (...args: Args) => Result | Promise<Result>,
  ): void => {
    ipcMain.handle(channel, (_event, ...args) => listener(...(args as Args)))
  }

  const parentWindow = (): BrowserWindow | undefined => deps.window() ?? undefined
  const openDialog = (options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> => {
    const parent = parentWindow()
    return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)
  }

  // ---------- settings and keys ----------

  handle('settings:get', () => store.getSettings())
  handle('settings:update', (patch: Partial<Settings>) => store.updateSettings(patch))

  handle('keys:status', () => (DEMO ? { claude: true, chatgpt: true } : secrets.status()))
  handle('keys:save', async (provider: Provider, key: string) => {
    if (!isProvider(provider)) return { ok: false, error: 'Unknown provider.' }
    const trimmed = String(key ?? '').trim()
    if (!trimmed) return { ok: false, error: 'Paste your API key first.' }
    try {
      const ids = provider === 'claude' ? await verifyClaudeKey(trimmed) : await verifyOpenAIKey(trimmed)
      secrets.set(provider, trimmed)
      fs.writeFileSync(modelsCache, JSON.stringify({ ...readAvailable(), [provider]: ids }))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: provider === 'claude' ? claudeErrorMessage(error) : openaiErrorMessage(error) }
    }
  })
  handle('keys:remove', (provider: Provider) => {
    if (isProvider(provider)) secrets.remove(provider)
    return secrets.status()
  })

  handle('models:list', (provider: Provider): ModelOption[] => {
    const all = MODELS.filter((m) => m.provider === provider)
    const available = readAvailable()[provider] ?? []
    // Show only models this key can use, when we know; otherwise show the whole table.
    const usable = all.filter((m) => available.some((id) => id === m.id || id.startsWith(m.id + '-')))
    return (usable.length > 0 ? usable : all).map((m) => ({
      id: m.id,
      provider: m.provider,
      label: m.label,
      blurb: m.blurb,
      priced: true,
    }))
  })

  // ---------- conversations ----------

  handle('conversations:list', () => store.listConversations())
  handle('conversations:get', (id: string) => store.getConversation(id))
  handle('conversations:create', (input: { provider: Provider; projectId?: string; model?: string }) => {
    const provider: Provider = isProvider(input?.provider) ? input.provider : 'claude'
    const conversation = store.createConversation(
      provider,
      input.model ?? store.getSettings().defaultModel[provider],
      input.projectId,
    )
    store.saveConversation(conversation)
    return conversation
  })
  handle(
    'conversations:update',
    (id: string, patch: Partial<Pick<Conversation, 'title' | 'model' | 'tools' | 'effort' | 'pinned' | 'projectId'>>) => {
      const conversation = store.getConversation(id)
      if (!conversation) return null
      if (typeof patch.title === 'string' && patch.title.trim()) conversation.title = patch.title.trim().slice(0, 120)
      if (typeof patch.model === 'string') {
        conversation.model = patch.model
        // The last model picked becomes the default for new chats in that mode.
        store.updateSettings({
          defaultModel: { ...store.getSettings().defaultModel, [conversation.provider]: patch.model },
        })
      }
      if (patch.tools) conversation.tools = { ...conversation.tools, ...patch.tools }
      if (patch.effort) conversation.effort = patch.effort
      if (typeof patch.pinned === 'boolean') conversation.pinned = patch.pinned
      if ('projectId' in patch) conversation.projectId = patch.projectId
      return store.saveConversation(conversation)
    },
  )
  handle('conversations:remove', (id: string) => {
    chat.stop(id)
    store.deleteConversation(id)
  })
  handle('conversations:search', (query: string, provider: Provider) => store.searchConversations(String(query), provider))

  // ---------- chat ----------

  handle('chat:send', (request: SendRequest) => chat.start(request))
  handle('chat:stop', (conversationId: string) => chat.stop(conversationId))

  // ---------- attachments ----------

  const importPaths = (paths: string[]): Attachment[] => {
    const attachments: Attachment[] = []
    for (const file of paths) {
      try {
        if (fs.statSync(file).isFile()) attachments.push(store.importAttachment(file))
      } catch {
        // Skip anything that cannot be read.
      }
    }
    return attachments
  }

  handle('attachments:pick', async () => {
    const result = await openDialog({ properties: ['openFile', 'multiSelections'] })
    return result.canceled ? [] : importPaths(result.filePaths)
  })
  handle('attachments:fromPaths', (paths: string[]) => importPaths(Array.isArray(paths) ? paths.map(String) : []))
  handle('attachments:fromData', (name: string, _mime: string, data: ArrayBuffer) =>
    store.saveAttachment(String(name), Buffer.from(data)),
  )
  handle('attachments:reveal', (attachment: Attachment) => {
    const file = store.findAttachmentFile(attachment.file)
    if (file) shell.showItemInFolder(file)
  })
  handle('attachments:saveAs', async (attachment: Attachment) => {
    const file = store.findAttachmentFile(attachment.file)
    if (!file) return
    const parent = parentWindow()
    const options = { defaultPath: attachment.name }
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (!result.canceled && result.filePath) fs.copyFileSync(file, result.filePath)
  })

  // ---------- projects ----------

  const updateProject = (id: string, change: (project: Project) => void): Project | null => {
    const projects = store.listProjects()
    const project = projects.find((p) => p.id === id)
    if (!project) return null
    change(project)
    project.updatedAt = Date.now()
    store.saveProjects(projects)
    return project
  }

  handle('projects:list', () => store.listProjects())
  handle('projects:create', (provider: Provider, name: string) => {
    const now = Date.now()
    const project: Project = {
      id: randomUUID(),
      provider: isProvider(provider) ? provider : 'claude',
      name: String(name).trim().slice(0, 80) || 'Untitled project',
      instructions: '',
      files: [],
      createdAt: now,
      updatedAt: now,
    }
    store.saveProjects([...store.listProjects(), project])
    return project
  })
  handle('projects:update', (id: string, patch: Partial<Pick<Project, 'name' | 'instructions'>>) =>
    updateProject(id, (project) => {
      if (typeof patch.name === 'string' && patch.name.trim()) project.name = patch.name.trim().slice(0, 80)
      if (typeof patch.instructions === 'string') project.instructions = patch.instructions.slice(0, 20_000)
    }),
  )
  handle('projects:addFiles', async (id: string) => {
    const result = await openDialog({ properties: ['openFile', 'multiSelections'] })
    if (result.canceled) return store.getProject(id)
    const added = importPaths(result.filePaths)
    return updateProject(id, (project) => project.files.push(...added))
  })
  handle('projects:removeFile', (id: string, attachmentId: string) =>
    updateProject(id, (project) => {
      project.files = project.files.filter((f) => f.id !== attachmentId)
    }),
  )
  handle('projects:remove', (id: string) => {
    store.saveProjects(store.listProjects().filter((p) => p.id !== id))
    // Chats stay; they just no longer belong to a project.
    for (const meta of store.listConversations()) {
      if (meta.projectId !== id) continue
      const conversation = store.getConversation(meta.id)
      if (!conversation) continue
      conversation.projectId = undefined
      store.saveConversation(conversation, { deferIndex: true })
    }
    store.flushIndex()
  })

  // ---------- memory ----------

  handle('memory:list', () => store.listMemories())
  handle('memory:add', (text: string) => store.addMemory(String(text), 'user'))
  handle('memory:remove', (id: string) => {
    const memories = store.listMemories().filter((m) => m.id !== id)
    store.saveMemories(memories)
    return memories
  })
  handle('memory:clear', () => {
    store.saveMemories([])
    return []
  })

  // ---------- usage ----------

  handle('usage:summary', () => store.spendSummary())

  // ---------- import ----------

  handle('import:run', async (provider: Provider) => {
    if (!isProvider(provider)) return null
    const result = await openDialog({
      title: `Import your ${provider === 'claude' ? 'Claude' : 'ChatGPT'} export`,
      properties: ['openFile'],
      filters: [{ name: 'Data export', extensions: ['zip', 'json'] }],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return importExport(store, provider, result.filePaths[0])
  })

  // ---------- artifacts ----------

  handle('artifacts:register', (html: string) => {
    const id = randomUUID()
    artifacts.set(id, String(html))
    // Keep the map small; old previews are simply registered again when reopened.
    if (artifacts.size > 40) artifacts.delete(artifacts.keys().next().value as string)
    return id
  })
  handle('artifacts:save', async (name: string, content: string) => {
    const parent = parentWindow()
    const options = { defaultPath: path.basename(String(name)) }
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (!result.canceled && result.filePath) fs.writeFileSync(result.filePath, String(content))
  })

  // ---------- code ----------

  handle('code:list', () => store.listCodeSessions())
  handle('code:get', (id: string) => code.get(id))
  handle('code:create', async (provider: Provider) => {
    if (!isProvider(provider)) return null
    const result = await openDialog({
      title: 'Choose a project folder',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return code.create(provider, result.filePaths[0])
  })
  handle('code:remove', (id: string) => {
    code.stop(id)
    store.deleteCodeSession(id)
  })
  handle('code:send', (sessionId: string, prompt: string, model?: string) => code.start(sessionId, String(prompt), model))
  handle('code:stop', (sessionId: string) => code.stop(sessionId))
  handle('code:respond', (requestId: string, decision: PermissionDecision) => code.respond(requestId, decision))

  // ---------- app ----------

  handle('app:openExternal', async (url: string) => {
    // Only ever hand web links to the system browser.
    if (/^https?:\/\//i.test(String(url))) await shell.openExternal(String(url))
  })
  handle('app:version', () => app.getVersion())
}
