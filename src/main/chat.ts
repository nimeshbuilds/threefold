// Runs chat turns: saves the user's message, calls the right provider (or, in
// a Threefold chat, several), streams progress to the window and records what
// the turn cost.

import { randomUUID } from 'node:crypto'
import type {
  ChatEvent,
  ChatMessage,
  Conversation,
  PanelStep,
  Provider,
  SendRequest,
  SpendSummary,
  Usage,
} from '@shared/types'
import { emptyUsage } from '@shared/pricing'
import type { Secrets } from './secrets'
import { metaOf, type Store } from './store'
import { buildSystemPrompt, type TurnContext, type TurnResult } from './providers/common'
import { claudeTitle, runClaudeTurn } from './providers/anthropic'
import { geminiTitle, runGeminiTurn } from './providers/gemini'
import { openaiTitle, runOpenAITurn } from './providers/openai'
import { runMockTurn } from './providers/mock'
import { runPanelTurn } from './panel'

export const DEMO = process.env.THREEFOLD_DEMO === '1'

const API_OWNER: Record<Provider, string> = { claude: 'Anthropic', chatgpt: 'OpenAI', gemini: 'Gemini' }
const MODE_NAME: Record<Provider, string> = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' }

export function keyHelp(provider: Provider): string {
  return `Add your ${API_OWNER[provider]} API key in Settings to use ${MODE_NAME[provider]} mode.`
}

/** Sends one turn to the provider's API (or to the canned demo provider). */
export function runProviderTurn(provider: Provider, ctx: TurnContext): Promise<TurnResult> {
  if (DEMO) return runMockTurn(ctx)
  switch (provider) {
    case 'claude':
      return runClaudeTurn(ctx)
    case 'chatgpt':
      return runOpenAITurn(ctx)
    case 'gemini':
      return runGeminiTurn(ctx)
  }
}

const TITLE: Record<Provider, typeof claudeTitle> = { claude: claudeTitle, chatgpt: openaiTitle, gemini: geminiTitle }

export class ChatService {
  private running = new Map<string, AbortController>()

  constructor(
    private readonly store: Store,
    private readonly secrets: Secrets,
    private readonly send: (event: ChatEvent) => void,
    private readonly sendSpend: (summary: Record<Provider, SpendSummary>) => void,
  ) {}

  isRunning(conversationId: string): boolean {
    return this.running.has(conversationId)
  }

  stop(conversationId: string): void {
    this.running.get(conversationId)?.abort()
  }

  stopAll(): void {
    for (const controller of this.running.values()) controller.abort()
  }

  private keyFor(provider: Provider): string | null {
    return DEMO ? 'demo' : this.secrets.get(provider)
  }

  /** Starts a turn. Resolves as soon as the turn is accepted; progress arrives as events. */
  start(request: SendRequest): { ok: boolean; error?: string } {
    const conversation = this.store.getConversation(request.conversationId)
    if (!conversation) return { ok: false, error: 'That conversation no longer exists.' }
    if (this.running.has(conversation.id)) return { ok: false, error: 'This chat is still answering.' }
    const apiKey = this.keyFor(conversation.provider)
    if (!apiKey) return { ok: false, error: keyHelp(conversation.provider) }

    // Editing or regenerating: drop the chosen message and everything after it.
    if (request.truncateFrom) {
      const index = conversation.messages.findIndex((m) => m.id === request.truncateFrom)
      if (index !== -1) conversation.messages = conversation.messages.slice(0, index)
    }
    if (!request.text.trim() && request.attachments.length === 0) {
      return { ok: false, error: 'Write a message first.' }
    }

    const controller = new AbortController()
    this.running.set(conversation.id, controller)
    void this.run(conversation, request, apiKey, controller).finally(() => {
      this.running.delete(conversation.id)
    })
    return { ok: true }
  }

  private async run(
    conversation: Conversation,
    request: SendRequest,
    apiKey: string,
    controller: AbortController,
  ): Promise<void> {
    const { store } = this
    const settings = store.getSettings()
    const project = store.getProject(conversation.projectId)
    const firstExchange = conversation.messages.length === 0
    const untitled = conversation.title === 'New chat' || conversation.title === 'New Threefold chat'

    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      text: request.text.trim(),
      attachments: request.attachments.length > 0 ? request.attachments : undefined,
      research: request.research ? true : undefined,
      createdAt: Date.now(),
    }
    conversation.messages.push(userMessage)
    conversation.updatedAt = Date.now()
    if (firstExchange && untitled) {
      conversation.title = userMessage.text.slice(0, 60) || userMessage.attachments?.[0]?.name || conversation.title
    }
    // The system prompt is frozen on the first message so later requests share
    // a cacheable prefix (and so earlier reasoning stays valid).
    conversation.system ??= buildSystemPrompt({
      provider: conversation.provider,
      displayName: settings.displayName,
      project,
      memories: settings.memoryEnabled ? store.listMemories() : [],
      memoryEnabled: settings.memoryEnabled,
      tools: conversation.tools,
    })
    store.saveConversation(conversation)
    this.send({ type: 'user', conversationId: conversation.id, message: userMessage })

    const messageId = randomUUID()
    const liveKeys = new Set<string>()
    this.send({ type: 'start', conversationId: conversation.id, messageId, model: conversation.model })

    let lastSpendPush = 0
    const trackLive = (key: string, provider: Provider, costUsd: number): void => {
      liveKeys.add(key)
      store.setLive(key, provider, costUsd)
      // The sidebar meter follows along, a few times a second at most.
      const now = Date.now()
      if (now - lastSpendPush > 400) {
        lastSpendPush = now
        this.sendSpend(store.spendSummary())
      }
    }

    const isPanel = Boolean(conversation.panel)
    const context: TurnContext = {
      apiKey,
      store,
      conversation,
      history: conversation.messages,
      system: conversation.system,
      project,
      memoryEnabled: settings.memoryEnabled,
      searchesThisMonth: store.webSearchesThisMonth(conversation.provider),
      signal: controller.signal,
      emit: {
        text: (delta) => this.send({ type: 'text', conversationId: conversation.id, messageId, delta }),
        thinking: (delta) => this.send({ type: 'thinking', conversationId: conversation.id, messageId, delta }),
        event: (event) => this.send({ type: 'event', conversationId: conversation.id, messageId, event }),
        usage: (usage) => {
          this.send({ type: 'usage', conversationId: conversation.id, messageId, usage })
          if (!isPanel) trackLive(`chat:${messageId}`, conversation.provider, usage.costUsd)
        },
      },
    }

    let result: TurnResult
    let steps: PanelStep[] | undefined
    try {
      if (isPanel) {
        const panel = await runPanelTurn({
          base: context,
          keyFor: (provider) => this.keyFor(provider),
          searchesFor: (provider) => store.webSearchesThisMonth(provider),
          run: runProviderTurn,
          emit: {
            step: (step) => this.send({ type: 'step', conversationId: conversation.id, messageId, step }),
            stepText: (stepId, delta) =>
              this.send({ type: 'step-text', conversationId: conversation.id, messageId, stepId, delta }),
            stepUsage: (step, usage) => trackLive(`chat:${messageId}:${step.id}`, step.provider, usage.costUsd),
          },
        })
        result = panel
        steps = panel.steps
      } else {
        result = await runProviderTurn(conversation.provider, context)
      }
    } catch (error) {
      result = {
        text: '',
        thinking: '',
        events: [],
        citations: [],
        generated: [],
        usage: emptyUsage(conversation.model),
        model: conversation.model,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    const assistant: ChatMessage = {
      id: messageId,
      role: 'assistant',
      text: result.text,
      thinking: result.thinking || undefined,
      events: result.events.length > 0 ? result.events : undefined,
      citations: result.citations.length > 0 ? result.citations : undefined,
      generated: result.generated.length > 0 ? result.generated : undefined,
      usage: result.usage,
      model: result.model,
      createdAt: Date.now(),
      error: result.error,
      panel: steps,
      // Threefold chats replay as plain text, which every provider accepts.
      replay: isPanel ? undefined : result.replay,
      replayProvider: !isPanel && result.replay ? conversation.provider : undefined,
    }

    // Re-read in case the title or settings changed while the turn was streaming.
    const latest = store.getConversation(conversation.id)
    if (latest) {
      conversation.title = latest.title
      conversation.pinned = latest.pinned
      conversation.projectId = latest.projectId
      conversation.reviewers = latest.reviewers
    }
    conversation.messages.push(assistant)
    conversation.costUsd += result.usage.costUsd
    conversation.updatedAt = Date.now()
    if (!isPanel) {
      conversation.containerId = result.containerId
      conversation.containerChargedAt = result.containerChargedAt ?? conversation.containerChargedAt
    }
    const meta = store.saveConversation(conversation)

    for (const key of liveKeys) store.clearLive(key)
    if (steps) {
      // Each step is billed by its own provider.
      for (const step of steps) if (step.usage) this.record(conversation.id, step.provider, step.usage, 'chat')
    } else {
      this.record(conversation.id, conversation.provider, result.usage, 'chat')
    }
    this.send({ type: 'done', conversationId: conversation.id, message: assistant, meta })
    this.sendSpend(store.spendSummary())

    if (firstExchange && !result.error && result.text.trim()) {
      void this.nameConversation(conversation.id, apiKey, userMessage.text, result.text)
    }
  }

  private record(ref: string, provider: Provider, usage: Usage, kind: 'chat' | 'title'): void {
    this.store.recordSpend({
      ts: Date.now(),
      provider,
      model: usage.model,
      costUsd: usage.costUsd,
      kind,
      ref,
      inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      webSearches: usage.webSearches || undefined,
    })
  }

  /** Replaces the placeholder title with a short generated one. Failure is harmless. */
  private async nameConversation(id: string, apiKey: string, userText: string, assistantText: string): Promise<void> {
    if (DEMO) return
    const before = this.store.getConversation(id)
    if (!before) return
    try {
      const named = await TITLE[before.provider](apiKey, userText, assistantText)
      if (!named) return
      const conversation = this.store.getConversation(id)
      if (!conversation) return
      // Leave a title the user typed in the meantime alone.
      if (conversation.title !== before.title) return
      conversation.title = named.title
      conversation.costUsd += named.usage.costUsd
      this.store.saveConversation(conversation)
      this.record(conversation.id, conversation.provider, named.usage, 'title')
      this.send({ type: 'meta', conversationId: id, meta: metaOf(conversation) })
      this.sendSpend(this.store.spendSummary())
    } catch {
      // Keep the placeholder title.
    }
  }
}
