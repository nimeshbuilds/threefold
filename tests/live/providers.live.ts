// Live checks against the real Anthropic, OpenAI and Gemini APIs.
//
//   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=... pnpm test:live
//
// Set any subset of the three keys; providers without a key are skipped. Every
// check uses the cheapest model unless it says otherwise, and the total spent
// is printed at the end (expect a few cents with all three keys).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChatMessage, ChatTools, Conversation, ModelRef, PanelStep, Provider, ToolEvent, Usage } from '@shared/types'
import { DEFAULT_MODEL, MODELS, UTILITY_MODEL, formatUsd } from '@shared/pricing'
import { runPanelTurn } from '../../src/main/panel'
import { claudeTitle, runClaudeTurn, verifyClaudeKey } from '../../src/main/providers/anthropic'
import { buildSystemPrompt, type TurnContext, type TurnResult } from '../../src/main/providers/common'
import { geminiTitle, runGeminiTurn, verifyGeminiKey } from '../../src/main/providers/gemini'
import { openaiTitle, runOpenAITurn, verifyOpenAIKey } from '../../src/main/providers/openai'
import { Store } from '../../src/main/store'

const KEYS: Record<Provider, string | undefined> = {
  claude: process.env.ANTHROPIC_API_KEY,
  chatgpt: process.env.OPENAI_API_KEY,
  gemini: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
}
const RUN: Record<Provider, (ctx: TurnContext) => Promise<TurnResult>> = {
  claude: runClaudeTurn,
  chatgpt: runOpenAITurn,
  gemini: runGeminiTurn,
}
const VERIFY = { claude: verifyClaudeKey, chatgpt: verifyOpenAIKey, gemini: verifyGeminiKey }
const TITLE = { claude: claudeTitle, chatgpt: openaiTitle, gemini: geminiTitle }
const NO_TOOLS: ChatTools = { webSearch: false, codeExec: false, imageGen: false }

let dir: string
let store: Store
const spent: Array<{ what: string; usage: Usage }> = []

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-live-'))
  store = new Store(dir)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  const total = spent.reduce((sum, entry) => sum + entry.usage.costUsd, 0)
  console.log('\nSpent by these checks:')
  for (const entry of spent) console.log(`  ${formatUsd(entry.usage.costUsd).padStart(9)}  ${entry.what}`)
  console.log(`  ${formatUsd(total).padStart(9)}  total\n`)
})

/** A 24x24 solid red PNG, built here so the test needs no fixture file. */
function redPng(): Buffer {
  const size = 24
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0).map((_, i) => (i % 3 === 0 ? 220 : 20))])
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(zlib.crc32(body) >>> 0, body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

interface Turn {
  result: TurnResult
  events: ToolEvent[]
  streamed: string
  liveUsages: Usage[]
}

async function turn(
  provider: Provider,
  what: string,
  options: {
    text: string
    model?: string
    tools?: Partial<ChatTools>
    memory?: boolean
    attachments?: ChatMessage['attachments']
    history?: ChatMessage[]
    signal?: AbortSignal
    onText?: (soFar: string) => void
  },
): Promise<Turn> {
  const conversation: Conversation = {
    ...store.createConversation(provider, options.model ?? UTILITY_MODEL[provider]),
    tools: { ...NO_TOOLS, ...options.tools },
  }
  const history: ChatMessage[] = [
    ...(options.history ?? []),
    { id: `u-${Date.now()}`, role: 'user', text: options.text, attachments: options.attachments, createdAt: Date.now() },
  ]
  const events: ToolEvent[] = []
  const liveUsages: Usage[] = []
  let streamed = ''
  const result = await RUN[provider]({
    apiKey: KEYS[provider]!,
    store,
    conversation,
    history,
    system: buildSystemPrompt({
      provider,
      displayName: '',
      project: null,
      memories: [],
      memoryEnabled: options.memory ?? false,
      tools: conversation.tools,
    }),
    project: null,
    memoryEnabled: options.memory ?? false,
    searchesThisMonth: 0,
    signal: options.signal ?? new AbortController().signal,
    emit: {
      text: (delta) => {
        streamed += delta
        options.onText?.(streamed)
      },
      thinking: () => {},
      event: (event) => {
        const index = events.findIndex((e) => e.id === event.id)
        if (index === -1) events.push(event)
        else events[index] = event
      },
      usage: (usage) => liveUsages.push(usage),
    },
  })
  spent.push({ what: `${provider}: ${what}`, usage: result.usage })
  return { result, events, streamed, liveUsages }
}

for (const provider of ['claude', 'chatgpt', 'gemini'] as const) {
  describe.skipIf(!KEYS[provider])(`${provider} (live)`, () => {
    it('accepts the key and offers every model in the price table that the app defaults to', async () => {
      const ids = await VERIFY[provider](KEYS[provider]!)
      expect(ids.length).toBeGreaterThan(0)
      const has = (id: string): boolean => ids.some((candidate) => candidate === id || candidate.startsWith(id + '-'))
      expect(has(DEFAULT_MODEL[provider]), `default model ${DEFAULT_MODEL[provider]} is not offered to this key`).toBe(true)
      expect(has(UTILITY_MODEL[provider]), `utility model ${UTILITY_MODEL[provider]} is not offered to this key`).toBe(true)
      const missing = MODELS.filter((m) => m.provider === provider && !has(m.id)).map((m) => m.id)
      if (missing.length > 0) console.log(`  note: ${provider} key does not list: ${missing.join(', ')}`)
    })

    it('streams a reply and reports an exact, priced cost', async () => {
      const { result, streamed, liveUsages } = await turn(provider, 'basic chat', { text: 'Reply with exactly the word: pong' })
      expect(result.error).toBeUndefined()
      expect(result.text.toLowerCase()).toContain('pong')
      expect(streamed).toBe(result.text)
      expect(result.usage.priced).toBe(true)
      expect(result.usage.estimated).toBe(false)
      expect(result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens).toBeGreaterThan(0)
      expect(result.usage.outputTokens).toBeGreaterThan(0)
      expect(result.usage.costUsd).toBeGreaterThan(0)
      expect(liveUsages.length).toBeGreaterThan(0)
    })

    it('works on the default model with its default settings', async () => {
      const { result } = await turn(provider, 'default model', {
        model: DEFAULT_MODEL[provider],
        text: 'What is 17 + 25? Reply with just the number.',
      })
      expect(result.error).toBeUndefined()
      expect(result.text).toContain('42')
    })

    it('keeps context across turns', async () => {
      const history: ChatMessage[] = [
        { id: 'h1', role: 'user', text: 'My dog is called Biscuit. Just say OK.', createdAt: 1 },
        { id: 'h2', role: 'assistant', text: 'OK.', createdAt: 2 },
      ]
      const { result } = await turn(provider, 'multi-turn', { history, text: "What is my dog's name? One word." })
      expect(result.error).toBeUndefined()
      expect(result.text).toMatch(/biscuit/i)
    })

    it('reads an attached image', async () => {
      const image = store.saveAttachment('red.png', redPng())
      const { result } = await turn(provider, 'image input', {
        text: 'What colour is this image? Answer with one word.',
        attachments: [image],
      })
      expect(result.error).toBeUndefined()
      expect(result.text).toMatch(/red/i)
    })

    it('reads an attached text file', async () => {
      const file = store.saveAttachment('notes.txt', Buffer.from('The secret passphrase is "marmalade-42".'))
      const { result } = await turn(provider, 'text file input', {
        text: 'What is the secret passphrase in the attached file? Reply with the passphrase only.',
        attachments: [file],
      })
      expect(result.error).toBeUndefined()
      expect(result.text).toContain('marmalade-42')
    })

    it('saves a memory through the memory tool', async () => {
      const before = store.listMemories().length
      const { result, events } = await turn(provider, 'memory tool', {
        memory: true,
        text: 'Please remember that my favourite colour is teal. Use your memory tool, then confirm in one short sentence.',
      })
      expect(result.error).toBeUndefined()
      const memories = store.listMemories()
      expect(memories.length).toBe(before + 1)
      expect(memories.at(-1)!.text).toMatch(/teal/i)
      expect(events.some((e) => e.kind === 'memory' && e.status === 'done')).toBe(true)
      expect(result.text.trim().length).toBeGreaterThan(0)
    })

    it('searches the web and counts the search', async () => {
      const { result, events } = await turn(provider, 'web search', {
        tools: { webSearch: true },
        text: 'Search the web for the current version of Node.js LTS and tell me the version number in one sentence.',
      })
      expect(result.error).toBeUndefined()
      expect(result.text).toMatch(/\d+/)
      expect(events.some((e) => e.kind === 'web_search')).toBe(true)
      expect(result.usage.webSearches).toBeGreaterThan(0)
    })

    it('runs code in the sandbox', async () => {
      const { result, events } = await turn(provider, 'code execution', {
        tools: { codeExec: true },
        text: 'Use code execution to compute 123457 * 6789 and reply with just the resulting number.',
      })
      expect(result.error).toBeUndefined()
      expect(result.text.replace(/[,\s]/g, '')).toContain('838149573')
      expect(events.some((e) => e.kind === 'code')).toBe(true)
    })

    it('stops when asked and keeps what was written', async () => {
      const controller = new AbortController()
      const { result } = await turn(provider, 'stop mid-reply', {
        text: 'Count from 1 to 400, one number per line.',
        signal: controller.signal,
        onText: (soFar) => {
          if (soFar.length > 40) controller.abort()
        },
      })
      expect(result.error).toBe('Stopped.')
      expect(result.text.length).toBeGreaterThan(0)
      expect(result.usage.estimated).toBe(true)
    })

    it('names a chat', async () => {
      const named = await TITLE[provider](KEYS[provider]!, 'How do I bake sourdough bread at home?', 'Start with a mature starter…')
      expect(named).not.toBeNull()
      expect(named!.title.length).toBeGreaterThan(0)
      expect(named!.title.split(/\s+/).length).toBeLessThanOrEqual(10)
      spent.push({ what: `${provider}: title`, usage: named!.usage })
    })

    it('explains a rejected key instead of crashing', async () => {
      await expect(VERIFY[provider]('not-a-real-key')).rejects.toBeTruthy()
    })
  })
}

const available = (['claude', 'chatgpt', 'gemini'] as const).filter((provider) => KEYS[provider])

describe.skipIf(available.length === 0)('Threefold review (live)', () => {
  it('drafts, reviews and rewrites across the connected providers', async () => {
    const answering = available[0]!
    // Review with every other connected provider; with a single key, review with a second model from the same one.
    const reviewers: ModelRef[] =
      available.length > 1
        ? available.slice(1).map((provider) => ({ provider, model: UTILITY_MODEL[provider] }))
        : [{ provider: answering, model: DEFAULT_MODEL[answering] }]
    const conversation: Conversation = {
      ...store.createConversation(answering, UTILITY_MODEL[answering]),
      panel: true,
      reviewers,
    }
    const history: ChatMessage[] = [
      { id: 'u', role: 'user', text: 'In two sentences: why is the sky blue?', createdAt: Date.now() },
    ]
    const steps: PanelStep[] = []
    let finalText = ''
    const result = await runPanelTurn({
      base: {
        apiKey: KEYS[answering]!,
        store,
        conversation,
        history,
        system: buildSystemPrompt({ provider: answering, displayName: '', project: null, memories: [], memoryEnabled: false, tools: NO_TOOLS }),
        project: null,
        memoryEnabled: false,
        searchesThisMonth: 0,
        signal: new AbortController().signal,
        emit: { text: (delta) => (finalText += delta), thinking: () => {}, event: () => {}, usage: () => {} },
      },
      keyFor: (provider) => KEYS[provider] ?? null,
      searchesFor: () => 0,
      run: (provider, ctx) => RUN[provider](ctx),
      emit: {
        step: (step) => {
          const index = steps.findIndex((s) => s.id === step.id)
          if (index === -1) steps.push(step)
          else steps[index] = step
        },
        stepText: () => {},
        stepUsage: () => {},
      },
    })
    spent.push({ what: `threefold: ${answering} reviewed by ${reviewers.map((r) => r.provider).join(' + ')}`, usage: result.usage })

    expect(result.error).toBeUndefined()
    expect(result.steps.map((s) => s.role)).toEqual(['draft', ...reviewers.map(() => 'critique'), 'final'])
    expect(result.steps.every((s) => s.status === 'done')).toBe(true)
    expect(result.steps.every((s) => s.text.trim().length > 0)).toBe(true)
    expect(result.text).toBe(finalText)
    expect(result.text).toMatch(/scatter|wavelength|Rayleigh/i)
    const stepTotal = result.steps.reduce((sum, s) => sum + (s.usage?.costUsd ?? 0), 0)
    expect(result.usage.costUsd).toBeCloseTo(stepTotal, 9)
    expect(result.usage.estimated).toBe(false)
  })
})
