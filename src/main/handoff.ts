// Writes a handoff summary of a chat: one request to the provider the chat is
// moving to, so the provider that is running out of credit is not billed again.

import { randomUUID } from 'node:crypto'
import type { Conversation, ModelRef, Provider, Usage } from '@shared/types'
import { emptyUsage, modelLabel } from '@shared/pricing'
import { HANDOFF_WRITER_SYSTEM, cleanSummary, handoffTranscript, handoffWriterPrompt } from '@shared/handoff'
import { describeError, type TurnContext, type TurnResult } from './providers/common'
import type { Store } from './store'

const MODE_NAME: Record<Provider, string> = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' }

/** "Claude Opus 5.5", "ChatGPT (GPT-6.1 Sol)": the assistant as a person would name it. */
export function assistantLabel(provider: Provider, model: string): string {
  const label = modelLabel(model)
  return label.toLowerCase().includes(MODE_NAME[provider].toLowerCase()) ? label : `${MODE_NAME[provider]} (${label})`
}

/** Is there anything to summarise? */
export function hasHistory(conversation: Pick<Conversation, 'messages' | 'handoff'>): boolean {
  return Boolean(conversation.handoff?.summary.trim()) || conversation.messages.some((m) => m.text.trim())
}

export interface WriteHandoffDeps {
  store: Store
  /** The chat being handed off, holding exactly the messages to summarise. */
  source: Conversation
  /** The model that writes the summary: the one the chat is moving to. */
  target: ModelRef
  apiKey: string
  signal: AbortSignal
  run(provider: Provider, ctx: TurnContext): Promise<TurnResult>
  /** Running cost of the request. */
  onUsage(usage: Usage): void
  now?: Date
}

export interface WrittenHandoff {
  summary: string
  /** Who the conversation was with, as written into the summary. */
  from: string
  model: string
  usage: Usage
  error?: string
}

export async function writeHandoff(deps: WriteHandoffDeps): Promise<WrittenHandoff> {
  const { source, target } = deps
  const now = deps.now ?? new Date()
  // Name the model that actually answered last, which can differ from the one picked.
  const lastModel = [...source.messages].reverse().find((m) => m.role === 'assistant' && m.model)?.model ?? source.model
  const from = assistantLabel(source.provider, lastModel)
  const prompt = handoffWriterPrompt({
    transcript: handoffTranscript(source.messages, MODE_NAME[source.provider]),
    from,
    today: now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    earlier: source.handoff?.summary,
  })

  // A throwaway chat: no tools, no memory, nothing saved.
  const scratch: Conversation = {
    id: `handoff-${randomUUID()}`,
    provider: target.provider,
    title: 'Handoff',
    model: target.model,
    createdAt: now.getTime(),
    updatedAt: now.getTime(),
    costUsd: 0,
    messageCount: 0,
    tools: { webSearch: false, codeExec: false, imageGen: false },
    // Summarising does not need long reasoning, and the user is waiting.
    effort: 'low',
    messages: [],
  }
  let result: TurnResult
  try {
    result = await deps.run(target.provider, {
      apiKey: deps.apiKey,
      store: deps.store,
      conversation: scratch,
      history: [{ id: randomUUID(), role: 'user', text: prompt, createdAt: now.getTime() }],
      system: HANDOFF_WRITER_SYSTEM,
      project: null,
      memoryEnabled: false,
      searchesThisMonth: 0,
      signal: deps.signal,
      emit: { text: () => {}, thinking: () => {}, event: () => {}, usage: deps.onUsage },
    })
  } catch (error) {
    return { summary: '', from, model: target.model, usage: emptyUsage(target.model), error: describeError(error) }
  }
  const summary = result.error ? '' : cleanSummary(result.text)
  return {
    summary,
    from,
    model: result.model,
    usage: result.usage,
    error: result.error ?? (summary ? undefined : 'The model returned an empty summary.'),
  }
}
