// Runs chat turns: saves the user's message, calls the right provider (or, in
// a Threefold chat, several), streams progress to the window and records what
// the turn cost.

import { randomUUID } from 'node:crypto'
import { IMAGE_PROVIDERS, PROVIDERS } from '@shared/types'
import type {
  ChatEvent,
  ChatMessage,
  Conversation,
  Handoff,
  HandoffProgress,
  ModelRef,
  PanelStep,
  Provider,
  SendRequest,
  SpendSummary,
  Usage,
} from '@shared/types'
import { emptyUsage } from '@shared/pricing'
import { planFallback } from '@shared/fallback'
import { hasHistory, writeHandoff } from './handoff'
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

/** Where a chat is moving, and why. */
interface Move {
  to: Provider
  /** credit: automatic fallback. manual: the user asked for it. */
  reason: HandoffProgress['reason']
  usedPct?: number
}

export class ChatService {
  private running = new Map<string, AbortController>()

  constructor(
    private readonly store: Store,
    private readonly secrets: Pick<Secrets, 'get'>,
    private readonly send: (event: ChatEvent) => void,
    private readonly sendSpend: (summary: Record<Provider, SpendSummary>) => void,
    /** Replaceable so tests can stand in for the providers. */
    private readonly runTurn: typeof runProviderTurn = runProviderTurn,
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
    const move = this.fallbackFor(conversation)
    const work = move
      ? this.move(conversation, request, move, apiKey, controller)
      : this.run(conversation, request, apiKey, controller)
    this.settle(conversation.id, work)
    return { ok: true }
  }

  /** Writes a handoff summary of a chat and opens a new chat with another provider that starts from it. */
  handoff(conversationId: string, to: Provider): { ok: boolean; error?: string } {
    const conversation = this.store.getConversation(conversationId)
    if (!conversation) return { ok: false, error: 'That conversation no longer exists.' }
    if (conversation.panel) return { ok: false, error: 'A reviewed chat already uses several providers and cannot be handed off.' }
    if (this.running.has(conversation.id)) return { ok: false, error: 'This chat is still answering.' }
    if (to === conversation.provider) return { ok: false, error: `This chat is already in ${MODE_NAME[to]} mode.` }
    if (!this.keyFor(to)) return { ok: false, error: keyHelp(to) }
    if (!hasHistory(conversation)) return { ok: false, error: 'There is nothing to hand off yet.' }

    const controller = new AbortController()
    this.running.set(conversation.id, controller)
    this.settle(conversation.id, this.move(conversation, null, { to, reason: 'manual' }, null, controller))
    return { ok: true }
  }

  private settle(conversationId: string, work: Promise<void>): void {
    void work
      .catch((error: unknown) => {
        this.send({ type: 'error', conversationId, error: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => this.running.delete(conversationId))
  }

  /** Should this chat's next message go to another provider because credit is running low? */
  private fallbackFor(conversation: Conversation): Move | null {
    if (conversation.panel || conversation.noFallback) return null
    const plan = planFallback({
      fallback: this.store.getSettings().fallback,
      spend: this.store.spendSummary(),
      connected: PROVIDERS.filter((provider) => this.keyFor(provider)),
      from: conversation.provider,
    })
    return plan.kind === 'switch' ? { to: plan.to, reason: 'credit', usedPct: plan.usedPct } : null
  }

  /**
   * Moves a chat to another provider: the new provider writes a handoff summary
   * of the history, a new chat is opened that starts from it, and the message
   * that was being sent (if any) is answered there.
   */
  private async move(
    source: Conversation,
    request: SendRequest | null,
    move: Move,
    sourceKey: string | null,
    controller: AbortController,
  ): Promise<void> {
    const { store } = this
    const target: ModelRef = { provider: move.to, model: store.getSettings().defaultModel[move.to] }
    const targetKey = this.keyFor(move.to)
    const progress = (patch: Pick<HandoffProgress, 'status'> & Partial<HandoffProgress>): void => {
      this.send({
        type: 'handoff',
        conversationId: source.id,
        handoff: { reason: move.reason, from: source.provider, to: move.to, model: target.model, usedPct: move.usedPct, ...patch },
      })
    }
    /** The move did not work out: say why, and answer with the provider the chat is already on. */
    const stayHere = async (error: string): Promise<void> => {
      progress({ status: 'failed', error })
      if (request && sourceKey) await this.run(source, request, sourceKey, controller)
    }
    if (!targetKey) return stayHere(keyHelp(move.to))

    let handoff: Handoff | undefined
    if (hasHistory(source)) {
      progress({ status: 'writing' })
      const liveKey = `handoff:${source.id}`
      let lastPush = 0
      const written = await writeHandoff({
        store,
        source,
        target,
        apiKey: targetKey,
        signal: controller.signal,
        run: this.runTurn,
        onUsage: (usage) => {
          store.setLive(liveKey, move.to, usage.costUsd)
          const now = Date.now()
          if (now - lastPush < 400) return
          lastPush = now
          progress({ status: 'writing', usage })
          this.sendSpend(store.spendSummary())
        },
      })
      store.clearLive(liveKey)
      // The request was made, so it is billed whether or not the summary is usable.
      this.record(source.id, move.to, written.usage, 'handoff')
      this.sendSpend(store.spendSummary())
      if (controller.signal.aborted) {
        progress({
          status: 'stopped',
          usage: written.usage,
          unsent: request ? { text: request.text, attachments: request.attachments } : undefined,
        })
        return
      }
      if (written.error) return stayHere(`The handoff summary could not be written: ${written.error}`)
      handoff = {
        source: move.reason === 'credit' ? 'fallback' : 'manual',
        summary: written.summary,
        from: written.from,
        fromProvider: source.provider,
        fromConversationId: source.id,
        model: written.model,
        usage: written.usage,
        usedPct: move.usedPct,
        createdAt: Date.now(),
      }
    }

    const next = store.createConversation(move.to, target.model)
    if (source.title !== 'New chat') next.title = source.title
    next.tools = { ...source.tools, imageGen: source.tools.imageGen && IMAGE_PROVIDERS.includes(move.to) }
    next.effort = source.effort
    next.handoff = handoff
    next.costUsd = handoff?.usage?.costUsd ?? 0
    store.saveConversation(next)

    // Read the old chat again: `source` may hold an edit that was never meant to be saved.
    const saved = store.getConversation(source.id)
    if (saved) {
      if (saved.messages.length === 0 && !saved.handoff) {
        // Nothing was ever said there; an empty chat left behind would only be clutter.
        store.deleteConversation(saved.id)
      } else {
        saved.continuedIn = { conversationId: next.id, provider: move.to }
        store.saveConversation(saved)
      }
    }
    progress({ status: 'done', conversation: next, usage: handoff?.usage })
    if (!request) return

    this.running.set(next.id, controller)
    try {
      await this.run(next, { ...request, conversationId: next.id, truncateFrom: undefined }, targetKey, controller)
    } finally {
      this.running.delete(next.id)
    }
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
      handoff: conversation.handoff,
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
          run: this.runTurn,
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
        result = await this.runTurn(conversation.provider, context)
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

    // A chat that continues another one keeps the title it arrived with.
    if (firstExchange && !conversation.handoff && !result.error && result.text.trim()) {
      void this.nameConversation(conversation.id, apiKey, userMessage.text, result.text)
    }
  }

  private record(ref: string, provider: Provider, usage: Usage, kind: 'chat' | 'title' | 'handoff'): void {
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
