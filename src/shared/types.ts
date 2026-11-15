// Types shared by the main process, the preload bridge and the renderer.

export type Provider = 'claude' | 'chatgpt'
export const PROVIDERS: Provider[] = ['claude', 'chatgpt']

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'data'

export interface Attachment {
  id: string
  name: string
  mime: string
  size: number
  kind: AttachmentKind
  /** File name inside the app's attachments folder. */
  file: string
  /** Provider-side file ids, filled in once the file has been uploaded to a code sandbox. */
  remote?: Partial<Record<Provider, string>>
}

export interface Usage {
  model: string
  /** Input tokens billed at the full input rate. */
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Output tokens, including reasoning tokens. */
  outputTokens: number
  webSearches: number
  /** Extra flat fees (for example a code sandbox session). */
  feesUsd: number
  costUsd: number
  /** False when the model has no entry in the price table. */
  priced: boolean
  /** True while the number is a live estimate that the provider has not confirmed yet. */
  estimated: boolean
}

export type ToolEventKind = 'web_search' | 'web_fetch' | 'code' | 'memory' | 'image' | 'notice'

export interface ToolEvent {
  id: string
  kind: ToolEventKind
  title: string
  detail?: string
  output?: string
  status: 'running' | 'done' | 'error'
}

export interface Citation {
  url: string
  title: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  thinking?: string
  attachments?: Attachment[]
  /** Files the model produced (charts, images, documents). */
  generated?: Attachment[]
  events?: ToolEvent[]
  citations?: Citation[]
  usage?: Usage
  model?: string
  createdAt: number
  error?: string
  /** Provider-native record of this turn, replayed verbatim on later requests. */
  replay?: unknown
  replayProvider?: Provider
}

export type Effort = 'default' | 'low' | 'medium' | 'high'

export interface ChatTools {
  webSearch: boolean
  codeExec: boolean
  imageGen: boolean
}

export interface ConversationMeta {
  id: string
  provider: Provider
  title: string
  model: string
  createdAt: number
  updatedAt: number
  projectId?: string
  origin?: 'chatgpt-export' | 'claude-export'
  pinned?: boolean
  costUsd: number
  messageCount: number
}

export interface Conversation extends ConversationMeta {
  tools: ChatTools
  effort: Effort
  /** System prompt frozen when the first message was sent. */
  system?: string
  /** Provider-side code sandbox reused across turns. */
  containerId?: string
  containerChargedAt?: number
  messages: ChatMessage[]
}

export interface Project {
  id: string
  provider: Provider
  name: string
  instructions: string
  files: Attachment[]
  createdAt: number
  updatedAt: number
}

export interface Memory {
  id: string
  text: string
  createdAt: number
  source: Provider | 'user'
}

export interface CreditPlan {
  /** Monthly API credit grant in USD. 0 means "no grant, just track spend". */
  monthlyUsd: number
  /** Day of the month the grant renews (1-28). */
  renewalDay: number
}

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  lastProvider: Provider
  defaultModel: Record<Provider, string>
  credits: Record<Provider, CreditPlan>
  memoryEnabled: boolean
  onboarded: boolean
  displayName: string
}

export interface KeyStatus {
  claude: boolean
  chatgpt: boolean
}

export interface LedgerEntry {
  ts: number
  provider: Provider
  model: string
  costUsd: number
  kind: 'chat' | 'code' | 'title'
  ref: string
  inputTokens: number
  outputTokens: number
}

export interface SpendSummary {
  provider: Provider
  cycleStart: number
  cycleEnd: number
  spentUsd: number
  todayUsd: number
  /** Spend from turns that are still streaming. */
  liveUsd: number
  monthlyUsd: number
  byModel: Array<{ model: string; costUsd: number; inputTokens: number; outputTokens: number }>
  byDay: Array<{ day: string; costUsd: number }>
}

// ---------- chat streaming events (main -> renderer) ----------

export type ChatEvent =
  | { type: 'user'; conversationId: string; message: ChatMessage }
  | { type: 'start'; conversationId: string; messageId: string; model: string }
  | { type: 'text'; conversationId: string; messageId: string; delta: string }
  | { type: 'thinking'; conversationId: string; messageId: string; delta: string }
  | { type: 'event'; conversationId: string; messageId: string; event: ToolEvent }
  | { type: 'usage'; conversationId: string; messageId: string; usage: Usage }
  | { type: 'done'; conversationId: string; message: ChatMessage; meta: ConversationMeta }
  | { type: 'meta'; conversationId: string; meta: ConversationMeta }
  | { type: 'error'; conversationId: string; messageId?: string; error: string }

export interface SendRequest {
  conversationId: string
  text: string
  attachments: Attachment[]
  /** Replace the conversation from this message id onward (edit or regenerate). */
  truncateFrom?: string
}

// ---------- Code tab ----------

export type CodeItem =
  | { id: string; type: 'user'; text: string }
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'thinking'; text: string }
  | {
      id: string
      type: 'tool'
      name: string
      summary: string
      input?: string
      output?: string
      status: 'running' | 'done' | 'error' | 'denied'
    }
  | { id: string; type: 'notice'; text: string; tone: 'info' | 'error' }

export interface CodeSessionMeta {
  id: string
  provider: Provider
  title: string
  cwd: string
  model: string
  createdAt: number
  updatedAt: number
  costUsd: number
}

export interface CodeSession extends CodeSessionMeta {
  items: CodeItem[]
  /** Claude Agent SDK session id, used to resume. */
  agentSessionId?: string
  /** ChatGPT mode: provider-native input items kept for the next prompt. */
  replay?: unknown[]
  /** Tool kinds the user chose to always allow in this session. */
  autoAllow: string[]
  /** Set by the main process when it returns a session: is the agent working right now? */
  running?: boolean
  /** A permission prompt that is still waiting for an answer. */
  pendingPermission?: PermissionRequest
}

export interface PermissionRequest {
  requestId: string
  sessionId: string
  tool: string
  summary: string
  detail: string
}

export type PermissionDecision = 'allow' | 'allow-always' | 'deny'

export type CodeEvent =
  | { type: 'item'; sessionId: string; item: CodeItem }
  | { type: 'delta'; sessionId: string; itemId: string; kind: 'text' | 'thinking'; delta: string }
  | { type: 'permission'; sessionId: string; request: PermissionRequest }
  | { type: 'usage'; sessionId: string; costUsd: number; estimated: boolean }
  | { type: 'done'; sessionId: string; meta: CodeSessionMeta }
  | { type: 'error'; sessionId: string; error: string }

// ---------- import ----------

export interface ImportResult {
  provider: Provider
  found: number
  imported: number
  updated: number
  skipped: number
  errors: string[]
}

export interface ModelOption {
  id: string
  provider: Provider
  label: string
  blurb: string
  priced: boolean
}

// ---------- the bridge exposed to the renderer as window.twofold ----------

export interface TwofoldApi {
  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
  }
  keys: {
    status(): Promise<KeyStatus>
    save(provider: Provider, key: string): Promise<{ ok: boolean; error?: string }>
    remove(provider: Provider): Promise<KeyStatus>
  }
  models: {
    list(provider: Provider): Promise<ModelOption[]>
  }
  conversations: {
    list(): Promise<ConversationMeta[]>
    get(id: string): Promise<Conversation | null>
    create(input: { provider: Provider; projectId?: string; model?: string }): Promise<Conversation>
    update(
      id: string,
      patch: Partial<Pick<Conversation, 'title' | 'model' | 'tools' | 'effort' | 'pinned' | 'projectId'>>,
    ): Promise<ConversationMeta | null>
    remove(id: string): Promise<void>
    search(query: string, provider: Provider): Promise<ConversationMeta[]>
  }
  chat: {
    send(req: SendRequest): Promise<{ ok: boolean; error?: string }>
    stop(conversationId: string): Promise<void>
    onEvent(listener: (event: ChatEvent) => void): () => void
  }
  attachments: {
    pick(): Promise<Attachment[]>
    fromPaths(paths: string[]): Promise<Attachment[]>
    fromData(name: string, mime: string, data: ArrayBuffer): Promise<Attachment>
    url(attachment: Attachment): string
    reveal(attachment: Attachment): Promise<void>
    saveAs(attachment: Attachment): Promise<void>
    pathForFile(file: File): string
  }
  projects: {
    list(): Promise<Project[]>
    create(provider: Provider, name: string): Promise<Project>
    update(id: string, patch: Partial<Pick<Project, 'name' | 'instructions'>>): Promise<Project | null>
    addFiles(id: string): Promise<Project | null>
    removeFile(id: string, attachmentId: string): Promise<Project | null>
    remove(id: string): Promise<void>
  }
  memory: {
    list(): Promise<Memory[]>
    add(text: string): Promise<Memory[]>
    remove(id: string): Promise<Memory[]>
    clear(): Promise<Memory[]>
  }
  usage: {
    summary(): Promise<Record<Provider, SpendSummary>>
    onUpdate(listener: (summary: Record<Provider, SpendSummary>) => void): () => void
  }
  importer: {
    run(provider: Provider): Promise<ImportResult | null>
  }
  artifacts: {
    register(html: string): Promise<string>
    save(name: string, content: string): Promise<void>
  }
  code: {
    list(): Promise<CodeSessionMeta[]>
    get(id: string): Promise<CodeSession | null>
    create(provider: Provider): Promise<CodeSession | null>
    remove(id: string): Promise<void>
    send(sessionId: string, prompt: string, model?: string): Promise<{ ok: boolean; error?: string }>
    stop(sessionId: string): Promise<void>
    respond(requestId: string, decision: PermissionDecision): Promise<void>
    onEvent(listener: (event: CodeEvent) => void): () => void
  }
  app: {
    openExternal(url: string): Promise<void>
    version(): Promise<string>
    platform: string
  }
}
