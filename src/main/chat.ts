// Runs chat turns: saves the user's message, calls the right provider, streams
// progress to the window and records what the turn cost.

import { randomUUID } from 'node:crypto'
import type {
  ChatEvent,
  ChatMessage,
  Conversation,
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
import { openaiTitle, runOpenAITurn } from './providers/openai'
import { runMockTurn } from './providers/mock'

export const DEMO = process.env.TWOFOLD_DEMO === '1'

const KEY_HELP: Record<Provider, string> = {
  claude: 'Add your Anthropic API key in Settings to use Claude mode.',
  chatgpt: 'Add your OpenAI API key in Settings to use ChatGPT mode.',
}

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

  /** Starts a turn. Resolves as soon as the turn is accepted; progress arrives as events. */
  start(request: SendRequest): { ok: boolean; error?: string } {
    const conversation = this.store.getConversation(request.conversationId)
    if (!conversation) return { ok: false, error: 'That conversation no longer exists.' }
    if (this.running.has(conversation.id)) return { ok: false, error: 'This chat is still answering.' }
    const apiKey = DEMO ? 'demo' : this.secrets.get(conversation.provider)
    if (!apiKey) return { ok: false, error: KEY_HELP[conversation.provider] }

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

    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      text: request.text.trim(),
      attachments: request.attachments.length > 0 ? request.attachments : undefined,
      createdAt: Date.now(),
    }
    conversation.messages.push(userMessage)
    conversation.updatedAt = Date.now()
    if (firstExchange && conversation.title === 'New chat') {
      conversation.title = userMessage.text.slice(0, 60) || userMessage.attachments?.[0]?.name || 'New chat'
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
    const liveKey = `chat:${messageId}`
    this.send({ type: 'start', conversationId: conversation.id, messageId, model: conversation.model })

    let lastSpendPush = 0
    const context: TurnContext = {
      apiKey,
      store,
      conversation,
      history: conversation.messages,
      system: conversation.system,
      project,
      memoryEnabled: settings.memoryEnabled,
      signal: controller.signal,
      emit: {
        text: (delta) => this.send({ type: 'text', conversationId: conversation.id, messageId, delta }),
        thinking: (delta) => this.send({ type: 'thinking', conversationId: conversation.id, messageId, delta }),
        event: (event) => this.send({ type: 'event', conversationId: conversation.id, messageId, event }),
        usage: (usage) => {
          this.send({ type: 'usage', conversationId: conversation.id, messageId, usage })
          store.setLive(liveKey, conversation.provider, usage.costUsd)
          // The sidebar meter follows along, a few times a second at most.
          const now = Date.now()
          if (now - lastSpendPush > 400) {
            lastSpendPush = now
            this.sendSpend(store.spendSummary())
          }
        },
      },
    }

    let result: TurnResult
    try {
      result = DEMO
        ? await runMockTurn(context)
        : conversation.provider === 'claude'
          ? await runClaudeTurn(context)
          : await runOpenAITurn(context)
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
      replay: result.replay,
      replayProvider: result.replay ? conversation.provider : undefined,
    }

    // Re-read in case the title or settings changed while the turn was streaming.
    const latest = store.getConversation(conversation.id)
    if (latest) {
      conversation.title = latest.title
      conversation.pinned = latest.pinned
      conversation.projectId = latest.projectId
    }
    conversation.messages.push(assistant)
    conversation.costUsd += result.usage.costUsd
    conversation.updatedAt = Date.now()
    conversation.containerId = result.containerId
    conversation.containerChargedAt = result.containerChargedAt ?? conversation.containerChargedAt
    const meta = store.saveConversation(conversation)

    store.clearLive(liveKey)
    this.record(conversation, result.usage, 'chat')
    this.send({ type: 'done', conversationId: conversation.id, message: assistant, meta })
    this.sendSpend(store.spendSummary())

    if (firstExchange && !result.error && result.text.trim()) {
      void this.nameConversation(conversation.id, apiKey, userMessage.text, result.text)
    }
  }

  private record(conversation: Pick<Conversation, 'id' | 'provider'>, usage: Usage, kind: 'chat' | 'title'): void {
    this.store.recordSpend({
      ts: Date.now(),
      provider: conversation.provider,
      model: usage.model,
      costUsd: usage.costUsd,
      kind,
      ref: conversation.id,
      inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
    })
  }

  /** Replaces the placeholder title with a short generated one. Failure is harmless. */
  private async nameConversation(id: string, apiKey: string, userText: string, assistantText: string): Promise<void> {
    if (DEMO) return
    const before = this.store.getConversation(id)
    if (!before) return
    try {
      const named =
        before.provider === 'claude'
          ? await claudeTitle(apiKey, userText, assistantText)
          : await openaiTitle(apiKey, userText, assistantText)
      if (!named) return
      const conversation = this.store.getConversation(id)
      if (!conversation) return
      // Leave a title the user typed in the meantime alone.
      if (conversation.title !== before.title) return
      conversation.title = named.title
      conversation.costUsd += named.usage.costUsd
      this.store.saveConversation(conversation)
      this.record(conversation, named.usage, 'title')
      this.send({ type: 'meta', conversationId: id, meta: metaOf(conversation) })
      this.sendSpend(this.store.spendSummary())
    } catch {
      // Keep the placeholder title.
    }
  }
}
