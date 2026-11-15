// A Threefold turn: one model answers, other models review, the first model
// writes the final reply.
//
//   1. Draft     the answering model replies to the user's message
//   2. Review    each reviewer reads the draft and lists what is wrong or missing
//   3. Final     the answering model rewrites its reply with the reviews in hand
//
// Every step is a real, separately billed API request, so the cost of each is
// tracked on its own provider and the total is shown live.

import { randomUUID } from 'node:crypto'
import type { Attachment, ChatMessage, Citation, Conversation, PanelStep, Provider, ToolEvent, Usage } from '@shared/types'
import { emptyUsage, modelLabel } from '@shared/pricing'
import { isResearch, type TurnContext, type TurnResult } from './providers/common'

export const REVIEWER_SYSTEM =
  'You are an expert reviewer. Another AI assistant wrote a draft answer to a user\'s request. ' +
  'Find what is wrong or missing: factual errors, flawed reasoning, bugs, parts of the request left unanswered, ' +
  'and wording that is unclear or misleading. Be specific and brief: list the most important problems, each with its fix. ' +
  'Do not rewrite the whole answer. If the draft is correct and complete, say so in one sentence.'

/** Added to the reviewer's instructions when the draft is a deep research report. */
export const REVIEWER_RESEARCH_NOTE =
  ' The draft is a research report. Check its key claims against its own sources and, where you can, against the web: ' +
  'flag anything unsupported, out of date or contradicted by better sources, and name important findings it missed.'

/** First words of the message that asks the answering model for its final reply. */
export const REVISION_OPENING = 'Before I read your answer, I had it reviewed'

const MAX_TRANSCRIPT_CHARS = 24_000

function transcript(history: ChatMessage[]): string {
  const earlier = history.slice(0, -1).filter((m) => m.text.trim())
  if (earlier.length === 0) return ''
  let text = earlier.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n\n')
  if (text.length > MAX_TRANSCRIPT_CHARS) text = '…' + text.slice(-MAX_TRANSCRIPT_CHARS)
  return text
}

export function reviewPrompt(history: ChatMessage[], draft: string): string {
  const request = history[history.length - 1]?.text ?? ''
  const earlier = transcript(history)
  return [
    earlier ? `<conversation_so_far>\n${earlier}\n</conversation_so_far>` : '',
    `<request>\n${request || '(The request is in the attached files.)'}\n</request>`,
    `<draft_answer>\n${draft}\n</draft_answer>`,
    'Review the draft answer to the request.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function revisionPrompt(reviews: Array<{ model: string; text: string }>): string {
  const count = reviews.length
  return [
    `${REVISION_OPENING} by ${count} other model${count === 1 ? '' : 's'}. ` +
      'Their reviews are below. Weigh them critically: use what is right, ignore what is wrong, and do not mention the review process.',
    ...reviews.map((r) => `<review from="${modelLabel(r.model)}">\n${r.text}\n</review>`),
    'Now write your final answer to my previous message. Give the complete answer, not a list of changes.',
  ].join('\n\n')
}

/** Adds up the cost and tokens of every step. */
export function combineUsage(model: string, usages: Usage[]): Usage {
  const total = emptyUsage(model)
  total.estimated = false
  for (const usage of usages) {
    total.inputTokens += usage.inputTokens
    total.cacheReadTokens += usage.cacheReadTokens
    total.cacheWriteTokens += usage.cacheWriteTokens
    total.outputTokens += usage.outputTokens
    total.webSearches += usage.webSearches
    total.feesUsd += usage.feesUsd
    total.costUsd += usage.costUsd
    total.priced = total.priced && usage.priced
    total.estimated = total.estimated || usage.estimated
  }
  return total
}

export interface PanelDeps {
  /** The context a normal turn would get for the answering model. */
  base: TurnContext
  keyFor(provider: Provider): string | null
  searchesFor(provider: Provider): number
  run(provider: Provider, ctx: TurnContext): Promise<TurnResult>
  emit: {
    step(step: PanelStep): void
    stepText(stepId: string, delta: string): void
    /** Running cost of one step, so each provider's meter can follow along. */
    stepUsage(step: PanelStep, usage: Usage): void
  }
}

export interface PanelResult extends TurnResult {
  steps: PanelStep[]
}

export async function runPanelTurn(deps: PanelDeps): Promise<PanelResult> {
  const { base } = deps
  const conversation = base.conversation
  const steps: PanelStep[] = []
  const events: ToolEvent[] = []
  const citations: Citation[] = []
  const generated: Attachment[] = []
  const live = new Map<string, Usage>()
  // With deep research on, the draft is a research run, the reviewers may search the web to
  // check it, and the final rewrite may search again to settle what the reviewers raised.
  const research = isResearch(base.history)

  const reportUsage = (): void => {
    base.emit.usage(combineUsage(conversation.model, [...live.values()]))
  }
  const publish = (step: PanelStep): void => deps.emit.step({ ...step })
  const addStep = (role: PanelStep['role'], provider: Provider, model: string): PanelStep => {
    const step: PanelStep = { id: randomUUID(), role, provider, model, text: '', status: 'running' }
    steps.push(step)
    publish(step)
    return step
  }
  const collect = (step: PanelStep, result: TurnResult): void => {
    step.text = result.text
    step.usage = result.usage
    live.set(step.id, result.usage)
    for (const citation of result.citations) {
      if (!citations.some((c) => c.url === citation.url)) citations.push(citation)
    }
    generated.push(...result.generated)
    reportUsage()
  }
  /** Tool events from different steps can share ids, so each is prefixed with its step. */
  const stepEvent = (step: PanelStep) => (event: ToolEvent): void => {
    const tagged = { ...event, id: `${step.id}:${event.id}` }
    const index = events.findIndex((e) => e.id === tagged.id)
    if (index === -1) events.push(tagged)
    else events[index] = tagged
    base.emit.event(tagged)
  }
  const stepUsage = (step: PanelStep) => (usage: Usage): void => {
    live.set(step.id, usage)
    deps.emit.stepUsage(step, usage)
    reportUsage()
  }
  const finish = (text: string, thinking: string, error?: string): PanelResult => ({
    text,
    thinking,
    events,
    citations,
    generated,
    usage: combineUsage(conversation.model, [...live.values()]),
    model: conversation.model,
    error,
    steps,
  })

  // ---- 1. draft ----
  const draft = addStep('draft', conversation.provider, conversation.model)
  const draftResult = await deps.run(conversation.provider, {
    ...base,
    emit: {
      text: (delta) => deps.emit.stepText(draft.id, delta),
      thinking: base.emit.thinking,
      event: stepEvent(draft),
      usage: stepUsage(draft),
    },
  })
  collect(draft, draftResult)
  if (draftResult.error || !draftResult.text.trim()) {
    draft.status = 'error'
    draft.error = draftResult.error ?? 'The model returned an empty draft.'
    publish(draft)
    return finish(draftResult.text, draftResult.thinking, draft.error)
  }
  draft.status = 'done'
  publish(draft)
  if (base.signal.aborted) return finish(draft.text, draftResult.thinking, 'Stopped.')

  // ---- 2. reviews, all at once ----
  const latest = base.history[base.history.length - 1]
  const prompt = reviewPrompt(base.history, draft.text)
  const reviews = await Promise.all(
    (conversation.reviewers ?? []).map(async (reviewer) => {
      const step = addStep('critique', reviewer.provider, reviewer.model)
      const apiKey = deps.keyFor(reviewer.provider)
      if (!apiKey) {
        step.status = 'skipped'
        step.error = 'No API key is saved for this provider.'
        publish(step)
        return step
      }
      // A reviewer sees the request and the draft, with no memory and no tools
      // (except web search when it is checking a research report).
      const asReviewer: Conversation = {
        ...conversation,
        provider: reviewer.provider,
        model: reviewer.model,
        tools: { webSearch: research, codeExec: false, imageGen: false },
        effort: 'default',
        containerId: undefined,
        reviewers: undefined,
        messages: [],
      }
      const result = await deps.run(reviewer.provider, {
        ...base,
        apiKey,
        conversation: asReviewer,
        history: [
          { id: randomUUID(), role: 'user', text: prompt, attachments: latest?.attachments, createdAt: Date.now() },
        ],
        system: research ? REVIEWER_SYSTEM + REVIEWER_RESEARCH_NOTE : REVIEWER_SYSTEM,
        project: null,
        memoryEnabled: false,
        searchesThisMonth: deps.searchesFor(reviewer.provider),
        emit: {
          text: (delta) => deps.emit.stepText(step.id, delta),
          thinking: () => {},
          event: () => {},
          usage: stepUsage(step),
        },
      })
      step.text = result.text
      step.usage = result.usage
      live.set(step.id, result.usage)
      reportUsage()
      if (result.error || !result.text.trim()) {
        step.status = 'error'
        step.error = result.error ?? 'The reviewer returned nothing.'
      } else {
        step.status = 'done'
      }
      publish(step)
      return step
    }),
  )
  if (base.signal.aborted) return finish(draft.text, draftResult.thinking, 'Stopped.')

  const useful = reviews.filter((step) => step.status === 'done')
  if (useful.length === 0) {
    // Nothing to revise against: the draft stands as the answer.
    base.emit.text(draft.text)
    const reason =
      reviews.length === 0
        ? undefined
        : 'No review came back, so this is the unreviewed draft. Open the steps above to see what went wrong.'
    return finish(draft.text, draftResult.thinking, reason)
  }

  // ---- 3. final ----
  const final = addStep('final', conversation.provider, conversation.model)
  const finalResult = await deps.run(conversation.provider, {
    ...base,
    conversation: research ? { ...conversation, tools: { ...conversation.tools, webSearch: true } } : conversation,
    history: [
      ...base.history,
      { id: randomUUID(), role: 'assistant', text: draft.text, createdAt: Date.now() },
      {
        id: randomUUID(),
        role: 'user',
        text: revisionPrompt(useful.map((step) => ({ model: step.model, text: step.text }))),
        createdAt: Date.now(),
      },
    ],
    // The draft already saved anything worth remembering.
    memoryEnabled: false,
    emit: {
      text: (delta) => {
        base.emit.text(delta)
        deps.emit.stepText(final.id, delta)
      },
      thinking: () => {},
      event: stepEvent(final),
      usage: stepUsage(final),
    },
  })
  collect(final, finalResult)
  if (finalResult.error === 'Stopped.') {
    final.status = 'error'
    final.error = 'Stopped.'
    publish(final)
    return finish(finalResult.text || draft.text, draftResult.thinking, 'Stopped.')
  }
  if (finalResult.error || !finalResult.text.trim()) {
    final.status = 'error'
    final.error = finalResult.error ?? 'The model returned nothing.'
    publish(final)
    if (!finalResult.text.trim()) base.emit.text(draft.text)
    return finish(
      finalResult.text.trim() ? finalResult.text : draft.text,
      draftResult.thinking,
      `The final rewrite failed (${final.error}) Showing the draft instead.`,
    )
  }
  final.status = 'done'
  publish(final)
  return finish(finalResult.text, draftResult.thinking)
}
