// Types shared by the main process, the preload bridge and the renderer.

import type { UpdateState } from './update'

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
  /**
   * fallback: written automatically when credit ran low. manual: the user asked.
   * pasted: written in another app and pasted in. received: written in another app
   * and passed in by the threefolds skill, which the user then accepted.
   */
  source: 'fallback' | 'manual' | 'pasted' | 'received'
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

/**
 * A handoff that reached the app from outside and waits for the user to accept
 * it. Nothing is created from it, and nothing is sent anywhere, until they do.
 */
export interface IncomingHandoff {
  /**
   * inbox: a file the threefolds skill saved in Threefold's inbox folder.
   * clipboard: text the user had copied. none: a link asked Threefold to pick
   * up a handoff, but none was waiting.
   */
  source: 'inbox' | 'clipboard' | 'none'
  /** Who the link said it came from. macOS does not tell an app who opened a link, so this is a claim, not a fact. */
  sender?: Provider
  /** The handoff itself, cut down to its heading and end line. Empty when the source is "none". */
  summary: string
  title?: string
  /** The handoff's own "From" line. */
  from?: string
  /** The mode that belongs to the assistant named in the "From" line, when the name is clear. */
  fromProvider?: Provider
}

/** A coding tool on this Mac that loads skills from a folder in the home directory. */
export type SkillTarget = 'claude-code' | 'codex' | 'gemini-cli'
export const SKILL_TARGETS: SkillTarget[] = ['claude-code', 'codex', 'gemini-cli']

export function isSkillTarget(value: unknown): value is SkillTarget {
  return value === 'claude-code' || value === 'codex' || value === 'gemini-cli'
}

export interface SkillStatus {
  target: SkillTarget
  /** The tool's own folder is in the home directory, so the tool has been used on this Mac. */
  toolFound: boolean
  /**
   * missing: not installed. current: the same text this version of Threefold ships.
   * outdated: an older or edited copy. newer: a later revision than this app has,
   * which it will not replace. linked: a link to a folder somewhere else, which
   * Threefold leaves alone. foreign: a different skill that happens to have this name.
   */
  state: 'missing' | 'current' | 'outdated' | 'newer' | 'linked' | 'foreign'
  /** Where the skill file is, or would be, with the home folder written as "~". */
  path: string
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
  /** Code tab: run new sessions through the official CLI on the user's subscription first. */
  subscription: Record<CliProvider, boolean>
  /** Ask GitHub now and then whether a newer Threefold has been released. */
  updates: { auto: boolean }
  /** The version that ran last, so the app can say when it has just been updated. */
  lastVersion?: string
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

/** Providers whose official coding CLI can run on a subscription plan. */
export type CliProvider = 'claude' | 'chatgpt'
export const CLI_PROVIDERS: CliProvider[] = ['claude', 'chatgpt']

export function isCliProvider(value: unknown): value is CliProvider {
  return value === 'claude' || value === 'chatgpt'
}

/** What a coding CLI needs before a session can run on the user's plan. */
export interface CliSetup {
  provider: CliProvider
  need: 'install' | 'sign-in'
}

/** What Threefold knows about a coding CLI on this computer. */
export interface CliStatus {
  provider: CliProvider
  /** The tool's own name: "Claude Code" or "Codex". */
  name: string
  installed: boolean
  path?: string
  version?: string
  /** Newest published version, when it could be looked up. */
  latest?: string
  /** Installed, but older than the newest release. */
  outdated: boolean
  /** Installed, but too old for Threefold to drive. */
  unsupported: boolean
  /** How it was installed, which decides how it is updated. */
  manager: 'homebrew' | 'npm' | 'native' | 'unknown'
  /** subscription: signed in with a plan. api: signed in with an API account. none: not signed in. */
  account: 'subscription' | 'api' | 'none'
  /** The plan's name, when the CLI reports it ("Max"). */
  plan?: string
  /** The exact command that installing or updating would run, or null when Threefold cannot do it. */
  installCommand: string | null
  /** Until when the plan's usage limit is known to be reached (epoch ms). */
  limitedUntil?: number
  /** Why the check itself failed, if it did. */
  error?: string
}

/** Progress of an install, update or sign-in that Threefold started. */
export type CliEvent =
  | { type: 'output'; provider: CliProvider; task: 'install' | 'login'; text: string }
  | { type: 'done'; provider: CliProvider; task: 'install' | 'login'; ok: boolean; error?: string }

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
  | {
      id: string
      type: 'notice'
      text: string
      tone: 'info' | 'error'
      /**
       * The coding CLI for this mode has to be installed or signed in to before the
       * plan can be used. The window offers to do it, right where this is shown.
       */
      setup?: CliSetup
    }

export interface CodeSessionMeta {
  id: string
  provider: Provider
  title: string
  cwd: string
  model: string
  createdAt: number
  updatedAt: number
  costUsd: number
  engine?: 'cli'
}

export interface CodeSession extends CodeSessionMeta {
  items: CodeItem[]
  /**
   * cli: this session runs through the official CLI (Claude Code or Codex), on the
   * user's subscription first and on their API key when the plan's limit is reached.
   * Absent: Threefold's API-key agent.
   */
  engine?: 'cli'
  /** Claude Code session id or Codex thread id, used to continue the same conversation. */
  cliSessionId?: string
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
    /**
     * Starts a chat from a handoff summary written elsewhere. Null when the text is empty.
     * `received` marks one that the threefolds skill passed in, as opposed to one pasted by hand.
     */
    fromHandoff(input: { provider: Provider; text: string; received?: boolean }): Promise<Conversation | null>
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
  update: {
    /** What is known about updates right now. */
    get(): Promise<UpdateState>
    /** Asks GitHub now. */
    check(): Promise<UpdateState>
    /** Downloads, checks and installs the update that was found. The app closes and opens again. */
    install(): Promise<{ ok: boolean; error?: string }>
    onState(listener: (state: UpdateState) => void): () => void
  }
  handoff: {
    /**
     * Hands over the handoff that is waiting, once. Also looks in the inbox folder, so a
     * handoff that was saved while the link could not be opened is still found.
     */
    take(): Promise<IncomingHandoff | null>
    /** Called when a handoff arrives while the window is open. Fetch it with take(). */
    onIncoming(listener: () => void): () => void
  }
  skill: {
    /** Where the threefolds skill stands in each coding tool on this Mac. */
    status(): Promise<SkillStatus[]>
    /** Writes the skill file into the tool's skills folder, replacing an older copy of it. */
    install(target: SkillTarget): Promise<{ ok: boolean; error?: string }>
    /** Takes the skill out of the tool's skills folder again. */
    remove(target: SkillTarget): Promise<{ ok: boolean; error?: string }>
    /** Saves the skill as a ZIP in Downloads, for the apps that take an upload, and shows it in Finder. */
    saveZip(): Promise<{ ok: boolean; file?: string; error?: string }>
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
  cli: {
    /** Looks for the CLI, its version, the newest version and whether it is signed in. */
    status(provider: CliProvider): Promise<CliStatus>
    /** Installs the CLI, or updates it when it is already there. Output arrives as events. */
    install(provider: CliProvider): Promise<{ ok: boolean; error?: string }>
    /** Starts the CLI's own sign-in, which opens the maker's page in the browser. */
    login(provider: CliProvider): Promise<{ ok: boolean; error?: string }>
    /** Sends a line to a sign-in that is waiting for one (a code shown by the browser). */
    loginInput(provider: CliProvider, text: string): Promise<void>
    cancel(provider: CliProvider): Promise<void>
    onEvent(listener: (event: CliEvent) => void): () => void
  }
  code: {
    list(): Promise<CodeSessionMeta[]>
    get(id: string): Promise<CodeSession | null>
    create(provider: Provider): Promise<CodeSession | null>
    remove(id: string): Promise<void>
    /**
     * Sends a prompt. `again` repeats the last prompt after the turn stopped before it began
     * (the CLI needed signing in to, say), without showing the prompt a second time.
     */
    send(sessionId: string, prompt: string, model?: string, again?: boolean): Promise<{ ok: boolean; error?: string }>
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
