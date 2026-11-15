import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, Conversation, PanelStep, Provider, Usage } from '@shared/types'
import { addRequest, emptyUsage } from '@shared/pricing'
import { REVIEWER_SYSTEM, REVISION_OPENING, combineUsage, reviewPrompt, revisionPrompt, runPanelTurn } from '../src/main/panel'
import type { TurnContext, TurnResult } from '../src/main/providers/common'
import { Store } from '../src/main/store'

let dir: string
let store: Store

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-panel-'))
  store = new Store(dir)
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function usage(model: string, input: number, output: number): Usage {
  return {
    ...addRequest(emptyUsage(model), model, { inputTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output }),
    estimated: false,
  }
}

function reply(model: string, text: string, extra: Partial<TurnResult> = {}): TurnResult {
  return { text, thinking: '', events: [], citations: [], generated: [], usage: usage(model, 1000, 500), model, ...extra }
}

interface Call {
  provider: Provider
  model: string
  system: string
  lastText: string
  history: ChatMessage[]
  tools: Conversation['tools']
  memoryEnabled: boolean
  apiKey: string
}

function setup(options: {
  reviewers: Conversation['reviewers']
  keys?: Partial<Record<Provider, string | null>>
  respond: (call: Call, index: number) => TurnResult | Promise<TurnResult>
  signal?: AbortSignal
}) {
  const conversation = store.createConversation('claude', 'claude-opus-5-5')
  conversation.panel = true
  conversation.reviewers = options.reviewers
  conversation.tools = { webSearch: true, codeExec: false, imageGen: false }
  const history: ChatMessage[] = [
    { id: 'u0', role: 'user', text: 'What is 2+2?', createdAt: 1 },
    { id: 'a0', role: 'assistant', text: 'It is 4.', createdAt: 2 },
    { id: 'u1', role: 'user', text: 'And 3+3?', createdAt: 3 },
  ]
  const calls: Call[] = []
  const steps: PanelStep[] = []
  const stepText: Record<string, string> = {}
  const mainText: string[] = []
  const usages: Usage[] = []
  const liveByStep: Array<{ provider: Provider; cost: number }> = []
  const keys: Record<Provider, string | null> = { claude: 'k-claude', chatgpt: 'k-openai', gemini: 'k-gemini', ...options.keys }

  const base: TurnContext = {
    apiKey: 'k-claude',
    store,
    conversation,
    history,
    system: 'BASE SYSTEM',
    project: null,
    memoryEnabled: true,
    searchesThisMonth: 0,
    signal: options.signal ?? new AbortController().signal,
    emit: { text: (d) => mainText.push(d), thinking: () => {}, event: () => {}, usage: (u) => usages.push(u) },
  }

  const run = async (provider: Provider, ctx: TurnContext): Promise<TurnResult> => {
    const call: Call = {
      provider,
      model: ctx.conversation.model,
      system: ctx.system,
      lastText: ctx.history[ctx.history.length - 1]!.text,
      history: ctx.history,
      tools: ctx.conversation.tools,
      memoryEnabled: ctx.memoryEnabled,
      apiKey: ctx.apiKey,
    }
    calls.push(call)
    const result = await options.respond(call, calls.length - 1)
    ctx.emit.text(result.text)
    ctx.emit.usage(result.usage)
    return result
  }

  const promise = runPanelTurn({
    base,
    keyFor: (provider) => keys[provider],
    searchesFor: () => 0,
    run,
    emit: {
      step: (step) => {
        const index = steps.findIndex((s) => s.id === step.id)
        if (index === -1) steps.push(step)
        else steps[index] = step
      },
      stepText: (id, delta) => {
        stepText[id] = (stepText[id] ?? '') + delta
      },
      stepUsage: (step, u) => liveByStep.push({ provider: step.provider, cost: u.costUsd }),
    },
  })
  return { promise, calls, steps, stepText, mainText, usages, liveByStep, conversation }
}

const isReview = (call: Call): boolean => call.system === REVIEWER_SYSTEM
const isFinal = (call: Call): boolean => call.lastText.startsWith(REVISION_OPENING)

describe('runPanelTurn', () => {
  it('drafts, has every reviewer critique the draft, then asks the answering model for the final reply', async () => {
    const run = setup({
      reviewers: [
        { provider: 'chatgpt', model: 'gpt-6.1-sol' },
        { provider: 'gemini', model: 'gemini-4-hydrogen' },
      ],
      respond: (call) => {
        if (isReview(call)) return reply(call.model, `review by ${call.model}`)
        if (isFinal(call)) return reply(call.model, 'FINAL: 6')
        return reply(call.model, 'DRAFT: 6?')
      },
    })
    const result = await run.promise

    expect(run.calls.map((c) => `${c.provider}:${c.model}`)).toEqual([
      'claude:claude-opus-5-5',
      'chatgpt:gpt-6.1-sol',
      'gemini:gemini-4-hydrogen',
      'claude:claude-opus-5-5',
    ])
    expect(result.text).toBe('FINAL: 6')
    expect(result.error).toBeUndefined()
    expect(result.steps.map((s) => `${s.role}:${s.status}`)).toEqual(['draft:done', 'critique:done', 'critique:done', 'final:done'])

    // Reviewers see the request, the earlier conversation and the draft, with no tools or memory, on their own key.
    const review = run.calls[1]!
    expect(review.lastText).toContain('And 3+3?')
    expect(review.lastText).toContain('What is 2+2?')
    expect(review.lastText).toContain('DRAFT: 6?')
    expect(review.tools).toEqual({ webSearch: false, codeExec: false, imageGen: false })
    expect(review.memoryEnabled).toBe(false)
    expect(review.apiKey).toBe('k-openai')
    expect(run.calls[2]!.apiKey).toBe('k-gemini')

    // The final request carries the draft as the assistant turn and every review.
    const final = run.calls[3]!
    expect(final.history.at(-2)).toMatchObject({ role: 'assistant', text: 'DRAFT: 6?' })
    expect(final.lastText).toContain('review by gpt-6.1-sol')
    expect(final.lastText).toContain('review by gemini-4-hydrogen')
    expect(final.tools.webSearch).toBe(true)
    expect(final.system).toBe('BASE SYSTEM')

    // Only the final reply reaches the main answer; the draft streams into its own step.
    expect(run.mainText.join('')).toBe('FINAL: 6')
    expect(run.stepText[result.steps[0]!.id]).toBe('DRAFT: 6?')
  })

  it('adds up the cost of every step and reports each step under its own provider', async () => {
    const run = setup({
      reviewers: [{ provider: 'gemini', model: 'gemini-4-hydrogen' }],
      respond: (call) => reply(call.model, isReview(call) ? 'ok' : 'answer'),
    })
    const result = await run.promise
    const opus = usage('claude-opus-5-5', 1000, 500).costUsd
    const hydrogen = usage('gemini-4-hydrogen', 1000, 500).costUsd
    expect(result.usage.costUsd).toBeCloseTo(2 * opus + hydrogen, 9)
    expect(result.usage.inputTokens).toBe(3000)
    expect(result.usage.estimated).toBe(false)
    expect(result.steps.map((s) => s.usage?.costUsd)).toEqual([opus, hydrogen, opus])
    expect(new Set(run.liveByStep.map((l) => l.provider))).toEqual(new Set(['claude', 'gemini']))
    // The last live figure shown equals the final total.
    expect(run.usages.at(-1)!.costUsd).toBeCloseTo(result.usage.costUsd, 9)
  })

  it('skips a reviewer that has no key and still uses the others', async () => {
    const run = setup({
      reviewers: [
        { provider: 'chatgpt', model: 'gpt-6.1-sol' },
        { provider: 'gemini', model: 'gemini-4-hydrogen' },
      ],
      keys: { chatgpt: null },
      respond: (call) => reply(call.model, isReview(call) ? 'looks fine' : isFinal(call) ? 'final' : 'draft'),
    })
    const result = await run.promise
    expect(run.calls.some((c) => c.provider === 'chatgpt')).toBe(false)
    expect(result.steps.map((s) => s.status)).toEqual(['done', 'skipped', 'done', 'done'])
    expect(result.text).toBe('final')
  })

  it('returns the draft when no review comes back, and says so', async () => {
    const run = setup({
      reviewers: [{ provider: 'chatgpt', model: 'gpt-6.1-sol' }],
      respond: (call) => (isReview(call) ? reply(call.model, '', { error: 'rate limited' }) : reply(call.model, 'the draft')),
    })
    const result = await run.promise
    expect(run.calls).toHaveLength(2)
    expect(result.text).toBe('the draft')
    expect(result.error).toMatch(/unreviewed draft/)
    expect(result.steps.map((s) => `${s.role}:${s.status}`)).toEqual(['draft:done', 'critique:error'])
    expect(run.mainText.join('')).toBe('the draft')
  })

  it('answers with the draft alone when no reviewers are chosen', async () => {
    const run = setup({ reviewers: [], respond: (call) => reply(call.model, 'just a draft') })
    const result = await run.promise
    expect(run.calls).toHaveLength(1)
    expect(result.text).toBe('just a draft')
    expect(result.error).toBeUndefined()
  })

  it('stops with an error when the draft fails, without calling any reviewer', async () => {
    const run = setup({
      reviewers: [{ provider: 'chatgpt', model: 'gpt-6.1-sol' }],
      respond: (call) => reply(call.model, '', { error: 'The key was rejected.' }),
    })
    const result = await run.promise
    expect(run.calls).toHaveLength(1)
    expect(result.error).toBe('The key was rejected.')
    expect(result.steps[0]!.status).toBe('error')
  })

  it('falls back to the draft when the final rewrite fails', async () => {
    const run = setup({
      reviewers: [{ provider: 'chatgpt', model: 'gpt-6.1-sol' }],
      respond: (call) => {
        if (isReview(call)) return reply(call.model, 'fix x')
        if (isFinal(call)) return reply(call.model, '', { error: 'overloaded' })
        return reply(call.model, 'the draft')
      },
    })
    const result = await run.promise
    expect(result.text).toBe('the draft')
    expect(result.error).toMatch(/final rewrite failed/)
    expect(result.steps.at(-1)).toMatchObject({ role: 'final', status: 'error' })
  })

  it('does not start the reviews after the user stops during the draft', async () => {
    const controller = new AbortController()
    const run = setup({
      reviewers: [{ provider: 'chatgpt', model: 'gpt-6.1-sol' }],
      signal: controller.signal,
      respond: (call) => {
        controller.abort()
        return reply(call.model, 'partial draft')
      },
    })
    const result = await run.promise
    expect(run.calls).toHaveLength(1)
    expect(result.error).toBe('Stopped.')
  })

  it('keeps tool events from different steps apart', async () => {
    const seen: string[] = []
    const run = setup({
      reviewers: [{ provider: 'chatgpt', model: 'gpt-6.1-sol' }],
      respond: (call) => reply(call.model, isReview(call) ? 'r' : 'a'),
    })
    // Re-run with a base that records events, emitting the same event id from draft and final.
    await run.promise
    const conversation = run.conversation
    const base: TurnContext = {
      apiKey: 'k',
      store,
      conversation,
      history: [{ id: 'u', role: 'user', text: 'q', createdAt: 1 }],
      system: 's',
      project: null,
      memoryEnabled: false,
      searchesThisMonth: 0,
      signal: new AbortController().signal,
      emit: { text: () => {}, thinking: () => {}, event: (e) => seen.push(e.id), usage: () => {} },
    }
    const result = await runPanelTurn({
      base,
      keyFor: () => 'k',
      searchesFor: () => 0,
      run: async (_provider, ctx) => {
        ctx.emit.event({ id: 'search-0', kind: 'web_search', title: 'Searched', status: 'done' })
        return reply(ctx.conversation.model, ctx.system === REVIEWER_SYSTEM ? 'r' : 'a')
      },
      emit: { step: () => {}, stepText: () => {}, stepUsage: () => {} },
    })
    // Draft and final both searched; the reviewer's events are not shown.
    expect(result.events).toHaveLength(2)
    expect(new Set(seen).size).toBe(2)
  })
})

describe('prompts', () => {
  const history: ChatMessage[] = [
    { id: '1', role: 'user', text: 'first question', createdAt: 1 },
    { id: '2', role: 'assistant', text: 'first answer', createdAt: 2 },
    { id: '3', role: 'user', text: 'second question', createdAt: 3 },
  ]

  it('gives the reviewer the conversation, the request and the draft', () => {
    const prompt = reviewPrompt(history, 'my draft')
    expect(prompt).toContain('<conversation_so_far>')
    expect(prompt).toContain('User: first question')
    expect(prompt).toContain('<request>\nsecond question\n</request>')
    expect(prompt).toContain('<draft_answer>\nmy draft\n</draft_answer>')
  })

  it('leaves the conversation block out on the first message', () => {
    expect(reviewPrompt([history[0]!], 'd')).not.toContain('conversation_so_far')
  })

  it('names each reviewer in the revision request', () => {
    const prompt = revisionPrompt([
      { model: 'gpt-6.1-sol', text: 'A' },
      { model: 'gemini-4-hydrogen', text: 'B' },
    ])
    expect(prompt.startsWith(REVISION_OPENING)).toBe(true)
    expect(prompt).toContain('by 2 other models')
    expect(prompt).toContain('<review from="GPT-6.1 Sol">\nA\n</review>')
    expect(prompt).toContain('<review from="Gemini 4 Hydrogen">\nB\n</review>')
  })
})

describe('combineUsage', () => {
  it('is estimated or unpriced if any step is', () => {
    const exact = usage('claude-opus-5-5', 10, 10)
    const estimated = { ...usage('gpt-6.1-sol', 10, 10), estimated: true }
    const unpriced = { ...emptyUsage('mystery-model'), estimated: false }
    expect(combineUsage('claude-opus-5-5', [exact]).estimated).toBe(false)
    expect(combineUsage('claude-opus-5-5', [exact, estimated]).estimated).toBe(true)
    expect(combineUsage('claude-opus-5-5', [exact, unpriced]).priced).toBe(false)
    expect(combineUsage('claude-opus-5-5', []).costUsd).toBe(0)
  })
})
