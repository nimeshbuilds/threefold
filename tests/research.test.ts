import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, Conversation, Provider } from '@shared/types'
import { IMAGE_PROVIDERS } from '@shared/types'
import {
  GEMINI_IMAGE_MODEL,
  GEMINI_RESEARCH_AGENT,
  MODELS,
  addRequest,
  emptyUsage,
  findModel,
  imageCost,
  tokenCost,
} from '@shared/pricing'
import { REVIEWER_RESEARCH_NOTE, REVIEWER_SYSTEM, REVISION_OPENING, runPanelTurn } from '../src/main/panel'
import {
  RESEARCH_BRIEF,
  imagePrompt,
  isResearch,
  userText,
  type TurnContext,
  type TurnResult,
} from '../src/main/providers/common'
import { interactionTokens } from '../src/main/providers/gemini'
import { runMockTurn } from '../src/main/providers/mock'
import { Store } from '../src/main/store'

let dir: string
let store: Store

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-research-'))
  store = new Store(dir)
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('research helpers', () => {
  const plain: ChatMessage = { id: 'a', role: 'user', text: 'What changed in Node 24?', createdAt: 1 }
  const research: ChatMessage = { ...plain, id: 'b', research: true }

  it('adds the research brief to a research message, the same way every time', () => {
    expect(userText(plain)).toBe('What changed in Node 24?')
    expect(userText(research)).toBe('What changed in Node 24?' + RESEARCH_BRIEF)
    expect(userText(research)).toBe(userText(research))
    expect(RESEARCH_BRIEF).toContain('cross-check')
  })

  it('treats a turn as research only when the message being answered asked for it', () => {
    expect(isResearch([plain])).toBe(false)
    expect(isResearch([plain, research])).toBe(true)
    // An earlier research message does not make a later ordinary one research.
    expect(isResearch([research, { id: 'r', role: 'assistant', text: 'report', createdAt: 2 }, plain])).toBe(false)
    expect(isResearch([])).toBe(false)
  })

  it('validates image tool arguments', () => {
    expect(imagePrompt({ prompt: '  a red fox  ' })).toBe('a red fox')
    expect(imagePrompt({ prompt: '' })).toBeNull()
    expect(imagePrompt({ text: 'fox' })).toBeNull()
    expect(imagePrompt(null)).toBeNull()
  })
})

describe('research and image pricing', () => {
  it('keeps feature-only models out of the picker but in the price table', () => {
    expect(findModel(GEMINI_RESEARCH_AGENT)?.internal).toBe(true)
    expect(findModel(GEMINI_IMAGE_MODEL)?.internal).toBe(true)
    const pickable = MODELS.filter((m) => m.provider === 'gemini' && !m.internal).map((m) => m.id)
    expect(pickable).not.toContain(GEMINI_RESEARCH_AGENT)
    expect(pickable).not.toContain(GEMINI_IMAGE_MODEL)
    expect(pickable).toContain('gemini-4-hydrogen')
  })

  it("prices a typical deep research run inside Google's own estimate", () => {
    // Google's figures for a typical run: ~250k input tokens (about 60% cached), ~60k output, ~80 searches.
    const before = Date.parse('2026-11-14T00:00:00Z')
    const tokens = tokenCost(
      GEMINI_RESEARCH_AGENT,
      { inputTokens: 100_000, cacheReadTokens: 150_000, cacheWriteTokens: 0, outputTokens: 60_000 },
      before,
    )!
    const total = tokens + 80 * 0.014
    expect(total).toBeGreaterThan(1)
    expect(total).toBeLessThan(3)
  })

  it('prices an image at about three cents, with image tokens at the image rate', () => {
    const cost = imageCost(GEMINI_IMAGE_MODEL, { inputTokens: 40, textOutputTokens: 0, imageOutputTokens: 1120 })!
    expect(cost).toBeCloseTo((40 * 1.5 + 1120 * 30) / 1_000_000, 9)
    expect(cost).toBeGreaterThan(0.033)
    expect(cost).toBeLessThan(0.035)
    expect(imageCost('gemini-4-hydrogen', { inputTokens: 1, textOutputTokens: 1, imageOutputTokens: 1 })).toBeNull()
  })

  it('knows which providers can generate images', () => {
    expect(IMAGE_PROVIDERS).toEqual(['chatgpt', 'gemini'])
  })
})

describe('interactionTokens', () => {
  it('reads tokens, searches and image tokens from an Interactions API result', () => {
    const tokens = interactionTokens({
      total_input_tokens: 250_000,
      total_cached_tokens: 150_000,
      total_tool_use_tokens: 5_000,
      total_output_tokens: 50_000,
      total_thought_tokens: 10_000,
      grounding_tool_count: [
        { type: 'google_search', count: 70 },
        { type: 'url_context', count: 10 },
      ],
      output_tokens_by_modality: [
        { modality: 'text', tokens: 48_880 },
        { modality: 'image', tokens: 1_120 },
      ],
    })
    expect(tokens).toEqual({
      inputTokens: 105_000,
      cacheReadTokens: 150_000,
      cacheWriteTokens: 0,
      outputTokens: 60_000,
      searches: 80,
      imageOutputTokens: 1_120,
    })
  })

  it('treats a missing usage block as zero', () => {
    expect(interactionTokens(undefined).inputTokens).toBe(0)
    expect(interactionTokens({}).searches).toBe(0)
  })
})

function context(provider: Provider, history: ChatMessage[], tools: Partial<Conversation['tools']> = {}): {
  ctx: TurnContext
  events: string[]
} {
  const events: string[] = []
  const conversation = store.createConversation(provider, provider === 'claude' ? 'claude-opus-5-5' : provider === 'chatgpt' ? 'gpt-6.1-sol' : 'gemini-4-hydrogen')
  conversation.tools = { webSearch: false, codeExec: false, imageGen: false, ...tools }
  return {
    events,
    ctx: {
      apiKey: 'demo',
      store,
      conversation,
      history,
      system: 'SYSTEM',
      project: null,
      memoryEnabled: false,
      searchesThisMonth: 0,
      signal: new AbortController().signal,
      emit: { text: () => {}, thinking: () => {}, event: (e) => events.push(`${e.kind}:${e.status}`), usage: () => {} },
    },
  }
}

describe('demo provider', () => {
  it('writes a research report for a research message and counts a search', async () => {
    const { ctx, events } = context('claude', [{ id: 'u', role: 'user', text: 'State of EV batteries', research: true, createdAt: 1 }])
    const result = await runMockTurn(ctx)
    expect(result.text).toContain('demo research report')
    expect(events).toContain('research:done')
    expect(result.usage.webSearches).toBe(1)
    expect(result.citations).toHaveLength(1)
  })

  it('creates a placeholder image only where the provider can generate images', async () => {
    const ask: ChatMessage[] = [{ id: 'u', role: 'user', text: 'Draw a picture of a fox', createdAt: 1 }]
    const gemini = await runMockTurn(context('gemini', ask, { imageGen: true }).ctx)
    expect(gemini.generated).toHaveLength(1)
    expect(gemini.generated[0]!.kind).toBe('image')
    expect(store.readAttachment(gemini.generated[0]!).subarray(1, 4).toString()).toBe('PNG')
    const claude = await runMockTurn(context('claude', ask, { imageGen: true }).ctx)
    expect(claude.generated).toHaveLength(0)
  })
})

describe('Threefold review with deep research', () => {
  function reply(model: string, text: string): TurnResult {
    const usage = { ...addRequest(emptyUsage(model), model, { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 }), estimated: false }
    return { text, thinking: '', events: [], citations: [], generated: [], usage, model }
  }

  async function run(research: boolean) {
    const conversation = store.createConversation('gemini', 'gemini-4-hydrogen')
    conversation.panel = true
    conversation.reviewers = [{ provider: 'claude', model: 'claude-opus-5-5' }]
    const history: ChatMessage[] = [{ id: 'u', role: 'user', text: 'Compare solid-state battery makers', research: research || undefined, createdAt: 1 }]
    const calls: Array<{ provider: Provider; system: string; tools: Conversation['tools']; last: ChatMessage; research: boolean }> = []
    const result = await runPanelTurn({
      base: {
        apiKey: 'k',
        store,
        conversation,
        history,
        system: 'BASE',
        project: null,
        memoryEnabled: false,
        searchesThisMonth: 0,
        signal: new AbortController().signal,
        emit: { text: () => {}, thinking: () => {}, event: () => {}, usage: () => {} },
      },
      keyFor: () => 'k',
      searchesFor: () => 0,
      run: async (provider, ctx) => {
        const last = ctx.history[ctx.history.length - 1]!
        calls.push({ provider, system: ctx.system, tools: ctx.conversation.tools, last, research: isResearch(ctx.history) })
        if (ctx.system.startsWith(REVIEWER_SYSTEM)) return reply(ctx.conversation.model, 'review')
        return reply(ctx.conversation.model, last.text.startsWith(REVISION_OPENING) ? 'final' : 'draft')
      },
      emit: { step: () => {}, stepText: () => {}, stepUsage: () => {} },
    })
    return { result, calls }
  }

  it('makes the draft a research run, lets reviewers search, and lets the final rewrite search', async () => {
    const { result, calls } = await run(true)
    const [draft, review, final] = calls
    expect(result.text).toBe('final')
    // Draft: the answering provider sees a research message.
    expect(draft!.provider).toBe('gemini')
    expect(draft!.research).toBe(true)
    // Review: a fresh, non-research message, with web search on and the research instructions added.
    expect(review!.provider).toBe('claude')
    expect(review!.research).toBe(false)
    expect(review!.tools.webSearch).toBe(true)
    expect(review!.system).toBe(REVIEWER_SYSTEM + REVIEWER_RESEARCH_NOTE)
    // Final: an ordinary turn (not a second research run), with web search available.
    expect(final!.provider).toBe('gemini')
    expect(final!.research).toBe(false)
    expect(final!.tools.webSearch).toBe(true)
  })

  it('keeps reviewers offline and the final unchanged in an ordinary review', async () => {
    const { calls } = await run(false)
    const [draft, review, final] = calls
    expect(draft!.research).toBe(false)
    expect(review!.tools.webSearch).toBe(false)
    expect(review!.system).toBe(REVIEWER_SYSTEM)
    expect(final!.tools.webSearch).toBe(false)
  })
})
