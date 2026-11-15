// Types shared by the main process, the preload bridge and the renderer.

export type Provider = 'claude' | 'chatgpt' | 'gemini'
export const PROVIDERS: Provider[] = ['claude', 'chatgpt', 'gemini']

export function isProvider(value: unknown): value is Provider {
  return value === 'claude' || value === 'chatgpt' || value === 'gemini'
}

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

/** One model on one provider. */
export interface ModelRef {
  provider: Provider
  model: string
}

/**
 * One step of a Threefold turn: the answering model drafts, the reviewers
 * critique the draft, then the answering model writes the final reply.
 */
export interface PanelStep {
  id: string
  role: 'draft' | 'critique' | 'final'
  provider: Provider
  model: string
  text: string
  status: 'running' | 'done' | 'error' | 'skipped'
  usage?: Usage
  error?: string
}

export type ToolEventKind = 'web_search' | 'web_fetch' | 'code' | 'memory' | 'image' | 'research' | 'notice'

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
  /** User messages only: this message was sent as a deep research request. */
  research?: boolean
  /** Threefold chats only: the draft, the reviews and the final step. */
  panel?: PanelStep[]
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

/** Which providers can generate images through their API. Anthropic's API has no image model. */
export const IMAGE_PROVIDERS: Provider[] = ['chatgpt', 'gemini']

export interface ConversationMeta {
  id: string
  provider: Provider
  title: string
  model: string
  createdAt: number
  updatedAt: number
  projectId?: string
  origin?: 'chatgpt-export' | 'claude-export' | 'gemini-export'
  pinned?: boolean
  /** A Threefold chat: several models work on each message. */
  panel?: boolean
  costUsd: number
  messageCount: number
}

/**
 * A summary that carries a conversation from one assistant to another. The
 * receiving model reads it as the history of the chat.
 */
export interface Handoff {
  /** fallback: written automatically when credit ran low. manual: the user asked. pasted: written in another app. */
  source: 'fallback' | 'manual' | 'pasted'
  summary: string
  /** Who the conversation was with before, as shown to the user and the model. */
  from?: string
  fromProvider?: Provider
  fromConversationId?: string
  /** Model that wrote the summary and what that cost. Absent for a pasted handoff. */
  model?: string
  usage?: Usage
  /** Automatic fallback only: how much of the monthly credit was used when it happened. */
  usedPct?: number
  createdAt: number
}

export interface Conversation extends ConversationMeta {
  tools: ChatTools
  effort: Effort
  /** This chat continues another one, from this summary. */
  handoff?: Handoff
  /** This chat was handed off; the conversation goes on in another chat. */
  continuedIn?: { conversationId: string; provider: Provider }
  /** The user chose to keep this chat on its provider even when credit runs low. */
  noFallback?: boolean
  /** System prompt frozen when the first message was sent. */
  system?: string
  /** Provider-side code sandbox reused across turns. */
  containerId?: string
  containerChargedAt?: number
  /** Threefold chats only: the models that review each draft. */
  reviewers?: ModelRef[]
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

/** Moving to another provider when one provider's monthly credit is nearly used up. */
export interface FallbackSettings {
  enabled: boolean
  /** Switch once this share of the monthly credit is used, in percent. */
  thresholdPct: number
  /** Provider to switch to when it has credit to spare; 'auto' picks the one with the most left. */
  prefer: Provider | 'auto'
}

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  lastProvider: Provider
  defaultModel: Record<Provider, string>
  credits: Record<Provider, CreditPlan>
  memoryEnabled: boolean
  onboarded: boolean
  displayName: string
  /** Reviewers last chosen in the Threefold tab. */
  reviewers: ModelRef[]
  fallback: FallbackSettings
}

export type KeyStatus = Record<Provider, boolean>

export interface LedgerEntry {
  ts: number
  provider: Provider
  model: string
  costUsd: number
  kind: 'chat' | 'code' | 'title' | 'handoff'
  ref: string
  inputTokens: number
  outputTokens: number
  /** Web searches made, so a monthly free allowance can be tracked. */
  webSearches?: number
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

/** Progress of moving a chat to another provider. */
export interface HandoffProgress {
  status: 'writing' | 'done' | 'failed' | 'stopped'
  /** credit: automatic fallback. manual: the user asked for it. */
  reason: 'credit' | 'manual'
  from: Provider
  to: Provider
  /** Model writing the summary. */
  model: string
  usedPct?: number
  /** Running cost of writing the summary. */
  usage?: Usage
  /** done: the chat that continues the conversation. */
  conversation?: Conversation
  error?: string
  /** stopped: the message that was not sent, to put back in the message box. */
  unsent?: { text: string; attachments: Attachment[] }
}

export type ChatEvent =
  | { type: 'user'; conversationId: string; message: ChatMessage }
  | { type: 'start'; conversationId: string; messageId: string; model: string }
  | { type: 'text'; conversationId: string; messageId: string; delta: string }
  | { type: 'thinking'; conversationId: string; messageId: string; delta: string }
  | { type: 'event'; conversationId: string; messageId: string; event: ToolEvent }
  | { type: 'usage'; conversationId: string; messageId: string; usage: Usage }
  | { type: 'step'; conversationId: string; messageId: string; step: PanelStep }
  | { type: 'step-text'; conversationId: string; messageId: string; stepId: string; delta: string }
  | { type: 'done'; conversationId: string; message: ChatMessage; meta: ConversationMeta }
  | { type: 'meta'; conversationId: string; meta: ConversationMeta }
  | { type: 'error'; conversationId: string; messageId?: string; error: string }
  | { type: 'handoff'; conversationId: string; handoff: HandoffProgress }

export interface SendRequest {
  conversationId: string
  text: string
  attachments: Attachment[]
  /** Run this message as deep research: a long, multi-step web investigation that ends in a cited report. */
  research?: boolean
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

// ---------- the bridge exposed to the renderer as window.threefold ----------

export interface ThreefoldApi {
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
    create(input: {
      provider: Provider
      projectId?: string
      model?: string
      reviewers?: ModelRef[]
    }): Promise<Conversation>
    update(
      id: string,
      patch: Partial<
        Pick<Conversation, 'title' | 'model' | 'tools' | 'effort' | 'pinned' | 'projectId' | 'reviewers' | 'noFallback'>
      >,
    ): Promise<ConversationMeta | null>
    /** Starts a chat from a handoff summary written elsewhere. Null when the text is empty. */
    fromHandoff(input: { provider: Provider; text: string }): Promise<Conversation | null>
    remove(id: string): Promise<void>
    search(query: string, provider: Provider): Promise<ConversationMeta[]>
  }
  chat: {
    send(req: SendRequest): Promise<{ ok: boolean; error?: string }>
    /** Writes a handoff summary of a chat and continues it with another provider. */
    handoff(conversationId: string, to: Provider): Promise<{ ok: boolean; error?: string }>
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
    /** Puts text on the clipboard. Works whether or not the window has focus. */
    copyText(text: string): Promise<void>
    version(): Promise<string>
    platform: string
  }
}
