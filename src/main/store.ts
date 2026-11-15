// Local persistence. Everything lives as plain JSON files under one folder
// (Electron's userData directory), so a backup is just a folder copy.

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type {
  Attachment,
  AttachmentKind,
  CodeSession,
  CodeSessionMeta,
  Conversation,
  ConversationMeta,
  LedgerEntry,
  Memory,
  Project,
  Provider,
  Settings,
  SpendSummary,
} from '@shared/types'
import { isProvider } from '@shared/types'
import { DEFAULT_MODEL, billingCycle } from '@shared/pricing'
import { DEFAULT_FALLBACK, cleanFallback } from '@shared/fallback'

const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  lastProvider: 'claude',
  defaultModel: { ...DEFAULT_MODEL },
  credits: {
    claude: { monthlyUsd: 100, renewalDay: 1 },
    chatgpt: { monthlyUsd: 100, renewalDay: 1 },
    gemini: { monthlyUsd: 10, renewalDay: 1 },
  },
  memoryEnabled: true,
  onboarded: false,
  displayName: '',
  reviewers: [],
  fallback: { ...DEFAULT_FALLBACK },
}

const IMAGE_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}
const DATA_EXT: Record<string, string> = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  parquet: 'application/vnd.apache.parquet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
}
const EXTRA_MIME: Record<string, string> = {
  svg: 'image/svg+xml',
  html: 'text/html',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
  pdf: 'application/pdf',
}
/** Largest text file that is pasted into the prompt as-is. */
export const MAX_INLINE_TEXT_BYTES = 400_000
/** Largest image or PDF sent to a model. */
export const MAX_MEDIA_BYTES = 30 * 1024 * 1024

function extensionOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase()
}

export function classify(name: string): { kind: AttachmentKind; mime: string } {
  const ext = extensionOf(name)
  if (IMAGE_EXT[ext]) return { kind: 'image', mime: IMAGE_EXT[ext] }
  if (ext === 'pdf') return { kind: 'pdf', mime: 'application/pdf' }
  if (DATA_EXT[ext]) return { kind: 'data', mime: DATA_EXT[ext] }
  return { kind: 'text', mime: EXTRA_MIME[ext] ?? 'text/plain' }
}

function safeId(id: string): string {
  return /^[A-Za-z0-9._-]{1,120}$/.test(id) ? id : createHash('sha1').update(id).digest('hex')
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value))
  fs.renameSync(tmp, file)
}

export function metaOf(conversation: Conversation): ConversationMeta {
  return {
    id: conversation.id,
    provider: conversation.provider,
    title: conversation.title,
    model: conversation.model,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    projectId: conversation.projectId,
    origin: conversation.origin,
    pinned: conversation.pinned,
    panel: conversation.panel,
    costUsd: conversation.costUsd,
    messageCount: conversation.messages.length,
  }
}

export function codeMetaOf(session: CodeSession): CodeSessionMeta {
  return {
    id: session.id,
    provider: session.provider,
    title: session.title,
    cwd: session.cwd,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    costUsd: session.costUsd,
  }
}

export class Store {
  private readonly conversationsDir: string
  private readonly attachmentsDir: string
  private readonly codeDir: string
  private index = new Map<string, ConversationMeta>()
  private settings: Settings
  /** Cost of turns that are still streaming, keyed by turn. */
  private live = new Map<string, { provider: Provider; costUsd: number }>()

  constructor(readonly dir: string) {
    this.conversationsDir = path.join(dir, 'conversations')
    this.attachmentsDir = path.join(dir, 'attachments')
    this.codeDir = path.join(dir, 'code-sessions')
    for (const d of [dir, this.conversationsDir, this.attachmentsDir, this.codeDir]) {
      fs.mkdirSync(d, { recursive: true })
    }
    const saved = readJson<Partial<Settings>>(this.file('settings.json')) ?? {}
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      defaultModel: { ...DEFAULT_SETTINGS.defaultModel, ...saved.defaultModel },
      credits: {
        claude: { ...DEFAULT_SETTINGS.credits.claude, ...saved.credits?.claude },
        chatgpt: { ...DEFAULT_SETTINGS.credits.chatgpt, ...saved.credits?.chatgpt },
        gemini: { ...DEFAULT_SETTINGS.credits.gemini, ...saved.credits?.gemini },
      },
    }
    if (!isProvider(this.settings.lastProvider)) this.settings.lastProvider = 'claude'
    if (!Array.isArray(this.settings.reviewers)) this.settings.reviewers = []
    this.settings.fallback = cleanFallback(saved.fallback)
    this.loadIndex()
  }

  private file(name: string): string {
    return path.join(this.dir, name)
  }

  // ---------- settings ----------

  getSettings(): Settings {
    return this.settings
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.settings = {
      ...this.settings,
      ...patch,
      defaultModel: { ...this.settings.defaultModel, ...patch.defaultModel },
      credits: {
        claude: { ...this.settings.credits.claude, ...patch.credits?.claude },
        chatgpt: { ...this.settings.credits.chatgpt, ...patch.credits?.chatgpt },
        gemini: { ...this.settings.credits.gemini, ...patch.credits?.gemini },
      },
      fallback: cleanFallback({ ...this.settings.fallback, ...patch.fallback }),
    }
    writeJson(this.file('settings.json'), this.settings)
    return this.settings
  }

  // ---------- conversations ----------

  private loadIndex(): void {
    const saved = readJson<ConversationMeta[]>(this.file('conversations-index.json'))
    if (saved) {
      for (const meta of saved) this.index.set(meta.id, meta)
      return
    }
    // No index (first run, or it was deleted): rebuild it from the conversation files.
    for (const name of fs.readdirSync(this.conversationsDir)) {
      if (!name.endsWith('.json')) continue
      const conversation = readJson<Conversation>(path.join(this.conversationsDir, name))
      if (conversation?.id) this.index.set(conversation.id, metaOf(conversation))
    }
    this.saveIndex()
  }

  private saveIndex(): void {
    writeJson(this.file('conversations-index.json'), [...this.index.values()])
  }

  private conversationFile(id: string): string {
    return path.join(this.conversationsDir, `${safeId(id)}.json`)
  }

  listConversations(): ConversationMeta[] {
    return [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getMeta(id: string): ConversationMeta | null {
    return this.index.get(id) ?? null
  }

  getConversation(id: string): Conversation | null {
    const conversation = readJson<Conversation>(this.conversationFile(id))
    if (!conversation) return null
    // Fill in fields added after a conversation was first saved.
    const savedTools = conversation.tools as Partial<Conversation['tools']> | undefined
    conversation.tools = {
      webSearch: savedTools?.webSearch ?? false,
      codeExec: savedTools?.codeExec ?? false,
      imageGen: savedTools?.imageGen ?? false,
    }
    conversation.effort ??= 'default'
    conversation.messages ??= []
    return conversation
  }

  saveConversation(conversation: Conversation, opts: { deferIndex?: boolean } = {}): ConversationMeta {
    conversation.messageCount = conversation.messages.length
    writeJson(this.conversationFile(conversation.id), conversation)
    const meta = metaOf(conversation)
    this.index.set(meta.id, meta)
    if (!opts.deferIndex) this.saveIndex()
    return meta
  }

  flushIndex(): void {
    this.saveIndex()
  }

  createConversation(provider: Provider, model: string, projectId?: string): Conversation {
    const now = Date.now()
    const conversation: Conversation = {
      id: randomUUID(),
      provider,
      title: 'New chat',
      model,
      createdAt: now,
      updatedAt: now,
      projectId,
      costUsd: 0,
      messageCount: 0,
      tools: { webSearch: false, codeExec: false, imageGen: false },
      effort: 'default',
      messages: [],
    }
    return conversation
  }

  deleteConversation(id: string): void {
    fs.rmSync(this.conversationFile(id), { force: true })
    this.index.delete(id)
    this.saveIndex()
  }

  searchConversations(query: string, provider: Provider): ConversationMeta[] {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    const all = this.listConversations().filter((m) => m.provider === provider)
    const hits = new Map<string, ConversationMeta>()
    for (const meta of all) {
      if (meta.title.toLowerCase().includes(needle)) hits.set(meta.id, meta)
    }
    // Search message text too, newest first, with a cap so a huge import stays responsive.
    for (const meta of all.slice(0, 600)) {
      if (hits.size >= 50) break
      if (hits.has(meta.id)) continue
      try {
        const raw = fs.readFileSync(this.conversationFile(meta.id), 'utf8')
        if (raw.toLowerCase().includes(needle)) hits.set(meta.id, meta)
      } catch {
        // A missing file just means no match.
      }
    }
    return [...hits.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50)
  }

  // ---------- attachments ----------

  attachmentPath(attachment: Pick<Attachment, 'file'>): string {
    // `file` is always a bare name we generated; refuse anything that tries to leave the folder.
    const name = path.basename(attachment.file)
    return path.join(this.attachmentsDir, name)
  }

  saveAttachment(name: string, data: Buffer, mimeOverride?: string): Attachment {
    const id = randomUUID()
    const cleanName = path.basename(name) || 'file'
    const { kind, mime } = classify(cleanName)
    const ext = extensionOf(cleanName)
    const file = ext ? `${id}.${ext.replace(/[^a-z0-9]/g, '')}` : id
    fs.writeFileSync(path.join(this.attachmentsDir, file), data)
    return { id, name: cleanName, mime: mimeOverride ?? mime, size: data.byteLength, kind, file }
  }

  importAttachment(sourcePath: string): Attachment {
    return this.saveAttachment(path.basename(sourcePath), fs.readFileSync(sourcePath))
  }

  readAttachment(attachment: Attachment): Buffer {
    return fs.readFileSync(this.attachmentPath(attachment))
  }

  findAttachmentFile(file: string): string | null {
    const full = this.attachmentPath({ file })
    return fs.existsSync(full) ? full : null
  }

  // ---------- projects ----------

  listProjects(): Project[] {
    return readJson<Project[]>(this.file('projects.json')) ?? []
  }

  saveProjects(projects: Project[]): void {
    writeJson(this.file('projects.json'), projects)
  }

  getProject(id: string | undefined): Project | null {
    if (!id) return null
    return this.listProjects().find((p) => p.id === id) ?? null
  }

  // ---------- memory ----------

  listMemories(): Memory[] {
    return readJson<Memory[]>(this.file('memory.json')) ?? []
  }

  saveMemories(memories: Memory[]): void {
    writeJson(this.file('memory.json'), memories)
  }

  addMemory(text: string, source: Memory['source']): Memory[] {
    const clean = text.trim().slice(0, 2000)
    const memories = this.listMemories()
    if (!clean || memories.some((m) => m.text === clean)) return memories
    memories.push({ id: randomUUID(), text: clean, createdAt: Date.now(), source })
    this.saveMemories(memories)
    return memories
  }

  // ---------- code sessions ----------

  private codeFile(id: string): string {
    return path.join(this.codeDir, `${safeId(id)}.json`)
  }

  listCodeSessions(): CodeSessionMeta[] {
    const sessions: CodeSessionMeta[] = []
    for (const name of fs.readdirSync(this.codeDir)) {
      if (!name.endsWith('.json')) continue
      const session = readJson<CodeSession>(path.join(this.codeDir, name))
      if (session?.id) sessions.push(codeMetaOf(session))
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getCodeSession(id: string): CodeSession | null {
    return readJson<CodeSession>(this.codeFile(id))
  }

  saveCodeSession(session: CodeSession): CodeSessionMeta {
    writeJson(this.codeFile(session.id), session)
    return codeMetaOf(session)
  }

  deleteCodeSession(id: string): void {
    fs.rmSync(this.codeFile(id), { force: true })
  }

  // ---------- spend ledger ----------

  recordSpend(entry: LedgerEntry): void {
    if (!(entry.costUsd > 0) && entry.inputTokens === 0 && entry.outputTokens === 0 && !entry.webSearches) return
    fs.appendFileSync(this.file('ledger.jsonl'), JSON.stringify(entry) + '\n')
  }

  setLive(key: string, provider: Provider, costUsd: number): void {
    this.live.set(key, { provider, costUsd })
  }

  clearLive(key: string): void {
    this.live.delete(key)
  }

  private readLedger(): LedgerEntry[] {
    let raw = ''
    try {
      raw = fs.readFileSync(this.file('ledger.jsonl'), 'utf8')
    } catch {
      return []
    }
    const entries: LedgerEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        entries.push(JSON.parse(line) as LedgerEntry)
      } catch {
        // Skip a line that was cut off by a crash mid-write.
      }
    }
    return entries
  }

  spendSummary(now = Date.now()): Record<Provider, SpendSummary> {
    const entries = this.readLedger()
    const build = (provider: Provider): SpendSummary => {
      const plan = this.settings.credits[provider]
      const cycle = billingCycle(now, plan.renewalDay)
      const startOfToday = new Date(now)
      startOfToday.setHours(0, 0, 0, 0)
      const byModel = new Map<string, { model: string; costUsd: number; inputTokens: number; outputTokens: number }>()
      const byDay = new Map<string, number>()
      let spent = 0
      let today = 0
      for (const entry of entries) {
        if (entry.provider !== provider || entry.ts < cycle.start || entry.ts >= cycle.end) continue
        spent += entry.costUsd
        if (entry.ts >= startOfToday.getTime()) today += entry.costUsd
        const model = byModel.get(entry.model) ?? { model: entry.model, costUsd: 0, inputTokens: 0, outputTokens: 0 }
        model.costUsd += entry.costUsd
        model.inputTokens += entry.inputTokens
        model.outputTokens += entry.outputTokens
        byModel.set(entry.model, model)
        const d = new Date(entry.ts)
        const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        byDay.set(day, (byDay.get(day) ?? 0) + entry.costUsd)
      }
      let live = 0
      for (const turn of this.live.values()) if (turn.provider === provider) live += turn.costUsd
      return {
        provider,
        cycleStart: cycle.start,
        cycleEnd: cycle.end,
        spentUsd: spent,
        todayUsd: today,
        liveUsd: live,
        monthlyUsd: plan.monthlyUsd,
        byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd),
        byDay: [...byDay.entries()].map(([day, costUsd]) => ({ day, costUsd })).sort((a, b) => a.day.localeCompare(b.day)),
      }
    }
    return { claude: build('claude'), chatgpt: build('chatgpt'), gemini: build('gemini') }
  }

  /** Web searches recorded for a provider since the start of the calendar month. */
  webSearchesThisMonth(provider: Provider, now = Date.now()): number {
    const d = new Date(now)
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
    let count = 0
    for (const entry of this.readLedger()) {
      if (entry.provider === provider && entry.ts >= monthStart) count += entry.webSearches ?? 0
    }
    return count
  }
}
