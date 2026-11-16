// Every request the window can make of the main process is registered here.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron'
import { isCliProvider, isProvider, isSkillTarget } from '@shared/types'
import type {
  Attachment,
  CliProvider,
  Conversation,
  ModelOption,
  ModelRef,
  PermissionDecision,
  Project,
  Provider,
  SendRequest,
  Settings,
  SkillTarget,
} from '@shared/types'
import { MODELS } from '@shared/pricing'
import { parseHandoff } from '@shared/handoff'
import { ChatService, DEMO } from './chat'
import type { CliManager } from './code/cli'
import { CodeService } from './code/service'
import { importExport } from './importService'
import type { IncomingHandoffs } from './incoming'
import { claudeErrorMessage, verifyClaudeKey } from './providers/anthropic'
import { geminiErrorMessage, verifyGeminiKey } from './providers/gemini'
import { openaiErrorMessage, verifyOpenAIKey } from './providers/openai'
import type { Secrets } from './secrets'
import { installSkill, removeSkill, saveSkillZip, skillStatuses } from './skillInstall'
import type { Store } from './store'
import type { Updater } from './updater'

export interface IpcDeps {
  store: Store
  secrets: Secrets
  chat: ChatService
  code: CodeService
  cli: CliManager
  incoming: IncomingHandoffs
  updater: Updater
  artifacts: Map<string, string>
  window: () => BrowserWindow | null
}

const VERIFY: Record<Provider, (key: string) => Promise<string[]>> = {
  claude: verifyClaudeKey,
  chatgpt: verifyOpenAIKey,
  gemini: verifyGeminiKey,
}
const EXPLAIN: Record<Provider, (error: unknown) => string> = {
  claude: claudeErrorMessage,
  chatgpt: openaiErrorMessage,
  gemini: geminiErrorMessage,
}
const MODE_NAME: Record<Provider, string> = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' }

/** Keeps only well-formed reviewer entries, without duplicates, capped at a sensible number. */
function cleanReviewers(value: unknown): ModelRef[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const reviewers: ModelRef[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const { provider, model } = item as Record<string, unknown>
    if (!isProvider(provider) || typeof model !== 'string' || !model) continue
    const key = `${provider}:${model}`
    if (seen.has(key)) continue
    seen.add(key)
    reviewers.push({ provider, model })
    if (reviewers.length >= 6) break
  }
  return reviewers
}

export function registerIpc(deps: IpcDeps): void {
  const { store, secrets, chat, code, cli, incoming, updater, artifacts } = deps
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
  handle('settings:update', (patch: Partial<Settings>) => {
    const settings = store.updateSettings(patch)
    if (patch?.updates) updater.schedule(settings.updates.auto)
    return settings
  })

  handle('keys:status', () => (DEMO ? { claude: true, chatgpt: true, gemini: true } : secrets.status()))
  handle('keys:save', async (provider: Provider, key: string) => {
    if (!isProvider(provider)) return { ok: false, error: 'Unknown provider.' }
    const trimmed = String(key ?? '').trim()
    if (!trimmed) return { ok: false, error: 'Paste your API key first.' }
    try {
      const ids = await VERIFY[provider](trimmed)
      secrets.set(provider, trimmed)
      fs.writeFileSync(modelsCache, JSON.stringify({ ...readAvailable(), [provider]: ids }))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: EXPLAIN[provider](error) }
    }
  })
  handle('keys:remove', (provider: Provider) => {
    if (isProvider(provider)) secrets.remove(provider)
    return secrets.status()
  })

  handle('models:list', (provider: Provider): ModelOption[] => {
    const all = MODELS.filter((m) => m.provider === provider && !m.internal)
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
  handle('conversations:create', (input: { provider: Provider; projectId?: string; model?: string; reviewers?: ModelRef[] }) => {
    const provider: Provider = isProvider(input?.provider) ? input.provider : 'claude'
    const conversation = store.createConversation(
      provider,
      input.model ?? store.getSettings().defaultModel[provider],
      input.projectId,
    )
    if (input.reviewers !== undefined) {
      conversation.panel = true
      conversation.reviewers = cleanReviewers(input.reviewers)
      conversation.title = 'New Threefold chat'
    }
    store.saveConversation(conversation)
    return conversation
  })
  handle(
    'conversations:update',
    (
      id: string,
      patch: Partial<
        Pick<Conversation, 'title' | 'model' | 'tools' | 'effort' | 'pinned' | 'projectId' | 'reviewers' | 'noFallback'>
      >,
    ) => {
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
      if (typeof patch.noFallback === 'boolean') conversation.noFallback = patch.noFallback || undefined
      if ('projectId' in patch) conversation.projectId = patch.projectId
      if (patch.reviewers !== undefined && conversation.panel) {
        conversation.reviewers = cleanReviewers(patch.reviewers)
        store.updateSettings({ reviewers: conversation.reviewers })
      }
      return store.saveConversation(conversation)
    },
  )
  handle('conversations:fromHandoff', (input: { provider: Provider; text: string; received?: boolean }) => {
    const parsed = parseHandoff(String(input?.text ?? ''))
    if (!parsed || !isProvider(input?.provider)) return null
    const conversation = store.createConversation(input.provider, store.getSettings().defaultModel[input.provider])
    conversation.title = parsed.title ?? 'Continued chat'
    conversation.handoff = {
      source: input.received === true ? 'received' : 'pasted',
      summary: parsed.summary,
      from: parsed.from,
      createdAt: Date.now(),
    }
    store.saveConversation(conversation)
    return conversation
  })
  handle('conversations:remove', (id: string) => {
    chat.stop(id)
    store.deleteConversation(id)
  })
  handle('conversations:search', (query: string, provider: Provider) => store.searchConversations(String(query), provider))

  // ---------- chat ----------

  handle('chat:send', (request: SendRequest) => chat.start(request))
  handle('chat:handoff', (conversationId: string, to: Provider) =>
    isProvider(to) ? chat.handoff(String(conversationId), to) : { ok: false, error: 'Unknown provider.' },
  )
  handle('chat:stop', (conversationId: string) => chat.stop(conversationId))

  // ---------- updates ----------

  handle('update:get', () => {
    const state = updater.get()
    updater.clearUpdatedFrom()
    return state
  })
  handle('update:check', () => updater.check(true))
  handle('update:install', () => {
    // Installing closes the app, which would cut a reply short.
    if (chat.busy() || code.busy()) return { ok: false, error: 'A reply is still being written. Update when it has finished.' }
    return updater.install()
  })

  // ---------- handoffs from outside, and the skill that sends them ----------

  handle('handoff:take', () => incoming.take())

  const notTarget = { ok: false, error: 'Unknown tool.' }
  handle('skill:status', () => skillStatuses())
  handle('skill:install', (target: SkillTarget) => (isSkillTarget(target) ? installSkill(target) : notTarget))
  handle('skill:remove', (target: SkillTarget) => (isSkillTarget(target) ? removeSkill(target) : notTarget))
  handle('skill:saveZip', () => {
    const saved = saveSkillZip(process.env.THREEFOLD_SKILL_HOME ? path.resolve(process.env.THREEFOLD_SKILL_HOME) : app.getPath('downloads'))
    if (saved.ok && saved.file && !DEMO) shell.showItemInFolder(saved.file)
    return saved.ok && saved.file ? { ok: true, file: path.basename(saved.file) } : saved
  })

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
      title: `Import your ${MODE_NAME[provider]} export`,
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

  // ---------- the official coding CLIs ----------

  const notCli = { ok: false, error: 'Only Claude mode and ChatGPT mode have a coding CLI.' }
  handle('cli:status', (provider: CliProvider) => (isCliProvider(provider) ? cli.status(provider) : null))
  handle('cli:install', (provider: CliProvider) => (isCliProvider(provider) ? cli.install(provider) : notCli))
  handle('cli:login', (provider: CliProvider) => (isCliProvider(provider) ? cli.login(provider) : notCli))
  handle('cli:loginInput', (provider: CliProvider, text: string) => {
    if (isCliProvider(provider)) cli.loginInput(provider, String(text ?? '').slice(0, 2000))
  })
  handle('cli:cancel', (provider: CliProvider) => {
    if (isCliProvider(provider)) cli.cancel(provider)
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
  handle('code:send', (sessionId: string, prompt: string, model?: string, again?: boolean) =>
    code.start(sessionId, String(prompt), model, again === true),
  )
  handle('code:stop', (sessionId: string) => code.stop(sessionId))
  handle('code:respond', (requestId: string, decision: PermissionDecision) => code.respond(requestId, decision))

  // ---------- app ----------

  handle('app:openExternal', async (url: string) => {
    // Only ever hand web links to the system browser.
    if (/^https?:\/\//i.test(String(url))) await shell.openExternal(String(url))
  })
  handle('app:copyText', (text: string) => clipboard.writeText(String(text ?? '')))
  handle('app:version', () => app.getVersion())
}
