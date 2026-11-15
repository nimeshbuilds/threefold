// Automatic fallback and handoff summaries: when a chat moves, where it goes,
// what the summary request looks like, and what is saved and billed.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yauzl from 'yauzl'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ChatEvent, ChatMessage, Conversation, HandoffProgress, LedgerEntry, Provider, Usage } from '@shared/types'
import { addRequest, emptyUsage } from '@shared/pricing'
import { DEFAULT_FALLBACK, cleanFallback, creditUsedPct, planFallback, type CreditState } from '@shared/fallback'
import {
  HANDOFF_END,
  HANDOFF_HEADING,
  HANDOFF_INSTRUCTIONS,
  HANDOFF_PROMPT,
  HANDOFF_PROMPT_INTRO,
  HANDOFF_WRITER_OPENING,
  HANDOFF_WRITER_SYSTEM,
  SKILL_NAME,
  handoffSystemNote,
  handoffTranscript,
  handoffWriterPrompt,
  parseHandoff,
} from '@shared/handoff'
import { assistantLabel, hasHistory, writeHandoff } from '../src/main/handoff'
import { buildSystemPrompt, type TurnContext, type TurnResult } from '../src/main/providers/common'
import { Store } from '../src/main/store'
import type { ChatService as ChatServiceType } from '../src/main/chat'

const root = path.resolve(__dirname, '..')

// ---------- deciding when to switch ----------

function spend(used: Partial<Record<Provider, [spent: number, monthly: number]>>): Record<Provider, CreditState> {
  const one = (provider: Provider): CreditState => {
    const [spentUsd, monthlyUsd] = used[provider] ?? [0, 0]
    return { spentUsd, liveUsd: 0, monthlyUsd }
  }
  return { claude: one('claude'), chatgpt: one('chatgpt'), gemini: one('gemini') }
}
const ON = { ...DEFAULT_FALLBACK, enabled: true }
const ALL: Provider[] = ['claude', 'chatgpt', 'gemini']

describe('planning a fallback', () => {
  it('is off by default and switches at 85% once turned on', () => {
    expect(DEFAULT_FALLBACK).toEqual({ enabled: false, thresholdPct: 85, prefer: 'auto' })
    const state = spend({ claude: [90, 100], chatgpt: [10, 100] })
    expect(planFallback({ fallback: DEFAULT_FALLBACK, spend: state, connected: ALL, from: 'claude' })).toEqual({ kind: 'none' })
    expect(planFallback({ fallback: ON, spend: state, connected: ALL, from: 'claude' })).toEqual({ kind: 'switch', to: 'chatgpt', usedPct: 90 })
  })

  it('stays put below the threshold and switches exactly at it', () => {
    const below = spend({ claude: [84.9, 100], chatgpt: [0, 100] })
    const at = spend({ claude: [85, 100], chatgpt: [0, 100] })
    expect(planFallback({ fallback: ON, spend: below, connected: ALL, from: 'claude' }).kind).toBe('none')
    expect(planFallback({ fallback: ON, spend: at, connected: ALL, from: 'claude' }).kind).toBe('switch')
  })

  it('counts a reply that is still streaming', () => {
    const state = spend({ claude: [80, 100], chatgpt: [0, 100] })
    state.claude.liveUsd = 6
    expect(planFallback({ fallback: ON, spend: state, connected: ALL, from: 'claude' })).toMatchObject({ kind: 'switch', usedPct: 86 })
  })

  it('picks the provider with the most dollars of credit left', () => {
    // Gemini is barely touched but only has $10; ChatGPT is half used but has $50 left.
    const state = spend({ claude: [95, 100], chatgpt: [50, 100], gemini: [1, 10] })
    expect(planFallback({ fallback: ON, spend: state, connected: ALL, from: 'claude' })).toMatchObject({ to: 'chatgpt' })
  })

  it('honours a preferred provider while it has credit to spare, and falls back to the best one when it does not', () => {
    const prefer = { ...ON, prefer: 'gemini' as const }
    const fine = spend({ claude: [95, 100], chatgpt: [50, 100], gemini: [1, 10] })
    const spent = spend({ claude: [95, 100], chatgpt: [50, 100], gemini: [9, 10] })
    expect(planFallback({ fallback: prefer, spend: fine, connected: ALL, from: 'claude' })).toMatchObject({ to: 'gemini' })
    expect(planFallback({ fallback: prefer, spend: spent, connected: ALL, from: 'claude' })).toMatchObject({ to: 'chatgpt' })
  })

  it('never switches to a provider that is not connected, has no monthly credit, or is itself nearly used up', () => {
    const state = spend({ claude: [95, 100], chatgpt: [0, 0], gemini: [9.5, 10] })
    expect(planFallback({ fallback: ON, spend: state, connected: ALL, from: 'claude' })).toEqual({ kind: 'stuck', usedPct: 95 })
    const other = spend({ claude: [95, 100], chatgpt: [0, 100], gemini: [0, 10] })
    expect(planFallback({ fallback: ON, spend: other, connected: ['claude', 'gemini'], from: 'claude' })).toMatchObject({ to: 'gemini' })
  })

  it('does nothing with one provider, or when this provider has no monthly credit to run out of', () => {
    const state = spend({ claude: [95, 100], chatgpt: [0, 100] })
    expect(planFallback({ fallback: ON, spend: state, connected: ['claude'], from: 'claude' }).kind).toBe('none')
    const payg = spend({ claude: [500, 0], chatgpt: [0, 100] })
    expect(creditUsedPct(payg.claude)).toBeNull()
    expect(planFallback({ fallback: ON, spend: payg, connected: ALL, from: 'claude' }).kind).toBe('none')
  })

  it('cleans up a saved setting', () => {
    expect(cleanFallback(undefined)).toEqual(DEFAULT_FALLBACK)
    expect(cleanFallback({ enabled: true, thresholdPct: 500, prefer: 'nobody' as never })).toEqual({ enabled: true, thresholdPct: 99, prefer: 'auto' })
    expect(cleanFallback({ thresholdPct: Number.NaN }).thresholdPct).toBe(85)
  })
})

// ---------- the skill and the text of a handoff ----------

const SAMPLE = `${HANDOFF_HEADING}

**Title:** Planning the Lisbon trip
**From:** ChatGPT
**Date:** November 15, 2026

## Goal
Plan four days in Lisbon in March.

## Background
- Budget is 900 euros. From there we take the train.

## Details to keep
Title: this line is content, not the header

${HANDOFF_END}`

describe('the threefolds skill', () => {
  const skill = fs.readFileSync(path.join(root, 'skills', SKILL_NAME, 'SKILL.md'), 'utf8')
  const front = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? ''
  const name = front.match(/^name: (.+)$/m)?.[1] ?? ''
  const description = front.match(/^description: (.+)$/m)?.[1] ?? ''

  it('has front matter every app accepts', () => {
    expect(name).toBe('threefolds')
    // Lowercase letters, digits and hyphens, at most 64 characters, same as its folder.
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(name.length).toBeLessThanOrEqual(64)
    expect(description.length).toBeGreaterThan(40)
    expect(description.length).toBeLessThanOrEqual(1024)
    expect(description).not.toMatch(/[<>]/)
    expect(front.split('\n')).toHaveLength(2)
  })

  it('tells the assistant the exact first and last line', () => {
    expect(HANDOFF_INSTRUCTIONS).not.toMatch(/^---/)
    expect(HANDOFF_INSTRUCTIONS).toContain(HANDOFF_HEADING)
    expect(HANDOFF_INSTRUCTIONS).toContain(HANDOFF_END)
    expect(HANDOFF_INSTRUCTIONS).toMatch(/Leave out secrets/)
  })

  it('is what the app itself uses to write a summary, and what the copyable prompt contains', () => {
    expect(HANDOFF_WRITER_SYSTEM.startsWith(HANDOFF_WRITER_OPENING)).toBe(true)
    expect(HANDOFF_WRITER_SYSTEM).toContain(HANDOFF_INSTRUCTIONS)
    expect(HANDOFF_PROMPT).toBe(`${HANDOFF_PROMPT_INTRO}\n\n${HANDOFF_INSTRUCTIONS}`)
  })

  it('is published on the website unchanged, as a file and inside the ZIP', async () => {
    expect(fs.readFileSync(path.join(root, 'docs/skills/threefolds/SKILL.md'), 'utf8')).toBe(skill)
    const entries = await new Promise<Record<string, string>>((resolve, reject) => {
      yauzl.open(path.join(root, 'docs/skills/threefolds.zip'), { lazyEntries: true }, (error, zip) => {
        if (error || !zip) return reject(error ?? new Error('no zip'))
        const found: Record<string, string> = {}
        zip.on('end', () => resolve(found))
        zip.on('entry', (entry: yauzl.Entry) => {
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) return reject(streamError ?? new Error('no stream'))
            const chunks: Buffer[] = []
            stream.on('data', (chunk: Buffer) => chunks.push(chunk))
            stream.on('end', () => {
              found[entry.fileName] = Buffer.concat(chunks).toString('utf8')
              zip.readEntry()
            })
          })
        })
        zip.readEntry()
      })
    })
    // The skill folder sits at the top of the ZIP, with nothing else beside it.
    expect(Object.keys(entries)).toEqual(['threefolds/SKILL.md'])
    expect(entries['threefolds/SKILL.md']).toBe(skill)
  })

  it('has the same one-line prompt opening on the website', () => {
    expect(fs.readFileSync(path.join(root, 'docs/site.js'), 'utf8')).toContain(HANDOFF_PROMPT_INTRO)
  })
})

describe('reading a pasted handoff', () => {
  it('keeps the handoff and reads its title and origin from the header only', () => {
    const parsed = parseHandoff(SAMPLE)!
    expect(parsed.title).toBe('Planning the Lisbon trip')
    expect(parsed.from).toBe('ChatGPT')
    expect(parsed.summary.startsWith(HANDOFF_HEADING)).toBe(true)
    expect(parsed.summary).not.toContain('end of handoff')
    expect(parsed.summary).toContain('Budget is 900 euros')
  })

  it('drops chatter before the heading and after the end line, and a code fence around it', () => {
    const wrapped = `Sure! Here is your handoff:\n\n\`\`\`\n${SAMPLE}\n\`\`\`\n\nCopy this message and paste it into Threefold.`
    const parsed = parseHandoff(wrapped)!
    expect(parsed.summary).toBe(parseHandoff(SAMPLE)!.summary)
    const unfinished = parseHandoff(`\`\`\`markdown\n${HANDOFF_HEADING}\n\n## Goal\nShip it.\n\`\`\``)!
    expect(unfinished.summary).toBe(`${HANDOFF_HEADING}\n\n## Goal\nShip it.`)
  })

  it('accepts a summary that was written without the skill', () => {
    const parsed = parseHandoff('  We were debugging a flaky test in the payments service.  ')!
    expect(parsed).toEqual({ summary: 'We were debugging a flaky test in the payments service.', title: undefined, from: undefined })
  })

  it('reads other header styles and ignores the template placeholders', () => {
    expect(parseHandoff(`${HANDOFF_HEADING}\nTitle: "Budget review"\n**From**: Gemini\n`)).toMatchObject({ title: 'Budget review', from: 'Gemini' })
    // The skill's own layout puts the header in a list, so it reads well in every app.
    expect(parseHandoff(`${HANDOFF_HEADING}\n\n- **Title:** Q3 plan\n* **From:** Claude Opus\n- **Date:** today\n\n## Goal\nTitle: not this`)).toMatchObject({ title: 'Q3 plan', from: 'Claude Opus' })
    expect(HANDOFF_INSTRUCTIONS).toContain('- **Title:**')
    const template = `${HANDOFF_HEADING}\n- **Title:** a short title for this conversation, under 60 characters\n- **From:** your name and model if you know it\n`
    expect(parseHandoff(template)).toMatchObject({ title: undefined, from: undefined })
  })

  it('returns nothing for empty text', () => {
    expect(parseHandoff('')).toBeNull()
    expect(parseHandoff('   \n ')).toBeNull()
    expect(parseHandoff(`${HANDOFF_HEADING}\n${HANDOFF_END}`)).toMatchObject({ summary: HANDOFF_HEADING })
  })
})

function message(role: 'user' | 'assistant', text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `${role}-${text.slice(0, 8)}-${Math.random()}`, role, text, createdAt: 1, ...extra }
}

describe('the transcript given to the summary writer', () => {
  it('names each speaker and mentions files, sources and research', () => {
    const text = handoffTranscript(
      [
        message('user', 'Compare these two contracts', {
          research: true,
          attachments: [{ id: 'a', name: 'old.pdf', mime: 'application/pdf', size: 1, kind: 'pdf', file: 'a.pdf' }],
        }),
        message('assistant', 'The new one is stricter.', {
          citations: [{ url: 'https://example.com/law', title: 'Law' }],
          generated: [{ id: 'g', name: 'diff.csv', mime: 'text/csv', size: 1, kind: 'data', file: 'g.csv' }],
        }),
        message('assistant', '   '),
      ],
      'Claude',
    )
    expect(text).toBe(
      'USER:\nCompare these two contracts\n[Sent as a deep research request]\n[Attached file: old.pdf]\n\n' +
        'ASSISTANT (Claude):\nThe new one is stricter.\n[The assistant produced a file: diff.csv]\nSources: https://example.com/law',
    )
  })

  it('keeps the start and the recent part of a very long chat', () => {
    const long = [message('user', 'OPENING ' + 'a'.repeat(3000)), message('assistant', 'b'.repeat(3000) + ' LATEST')]
    const text = handoffTranscript(long, 'Gemini', 2000)
    expect(text.length).toBeLessThan(2200)
    expect(text).toContain('OPENING')
    expect(text).toContain('LATEST')
    expect(text).toContain('left out because it is too long')
  })

  it('asks for a summary with the right names and carries an earlier handoff along', () => {
    const prompt = handoffWriterPrompt({ transcript: 'USER:\nhi', from: 'ChatGPT (GPT-6.1 Sol)', today: 'November 15, 2026', earlier: 'OLD SUMMARY' })
    expect(prompt).toContain('For the "From" line write: ChatGPT (GPT-6.1 Sol). For the "Date" line write: November 15, 2026.')
    expect(prompt).toContain('<earlier_handoff>\nOLD SUMMARY\n</earlier_handoff>')
    expect(prompt).toContain('<conversation>\nUSER:\nhi\n</conversation>')
    expect(handoffWriterPrompt({ transcript: 'x', from: 'Claude', today: 'today' })).not.toContain('earlier_handoff')
  })

  it('labels the assistant the way a person would', () => {
    expect(assistantLabel('claude', 'claude-opus-5-5')).toBe('Claude Opus 5.5')
    expect(assistantLabel('chatgpt', 'gpt-6.1-sol')).toBe('ChatGPT (GPT-6.1 Sol)')
    expect(assistantLabel('gemini', 'gemini-4-hydrogen')).toBe('Gemini 4 Hydrogen')
  })
})

describe('the system prompt of a chat that starts from a handoff', () => {
  const base = { provider: 'gemini' as const, displayName: '', project: null, memories: [], memoryEnabled: false, tools: { webSearch: false, codeExec: false, imageGen: false } }

  it('includes the summary as history, last, and marks it as background', () => {
    const system = buildSystemPrompt({ ...base, handoff: { summary: 'SUMMARY TEXT', from: 'Claude Opus 5.5' } })
    expect(system.endsWith('<handoff>\nSUMMARY TEXT\n</handoff>')).toBe(true)
    expect(system).toContain('continues one the user started with Claude Opus 5.5')
    expect(system).toContain('do not ask the user to repeat')
    expect(system).toContain('the user is right')
    expect(handoffSystemNote({ summary: 'x' })).toContain('started in another assistant')
  })

  it('is unchanged for an ordinary chat', () => {
    expect(buildSystemPrompt(base)).not.toContain('handoff')
    expect(buildSystemPrompt({ ...base, handoff: { summary: '  ' } })).not.toContain('<handoff>')
  })
})

// ---------- the whole flow, with stand-in providers ----------

function usage(model: string, input: number, output: number): Usage {
  return {
    ...addRequest(emptyUsage(model), model, { inputTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output }),
    estimated: false,
  }
}

interface Call {
  provider: Provider
  model: string
  system: string
  prompt: string
  effort: Conversation['effort']
  memoryEnabled: boolean
  apiKey: string
}

let dir: string
let store: Store
let ChatService: typeof ChatServiceType

beforeAll(async () => {
  // Demo mode: every provider counts as connected and no network is touched for chat names.
  process.env.THREEFOLD_DEMO = '1'
  ChatService = (await import('../src/main/chat')).ChatService
})
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-handoff-'))
  store = new Store(dir)
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function harness(options: { writer?: (ctx: TurnContext) => TurnResult | Promise<TurnResult> } = {}) {
  const events: ChatEvent[] = []
  const calls: Call[] = []
  const waiters: Array<() => void> = []
  const run = async (provider: Provider, ctx: TurnContext): Promise<TurnResult> => {
    const model = ctx.conversation.model
    calls.push({
      provider,
      model,
      system: ctx.system,
      prompt: ctx.history.at(-1)?.text ?? '',
      effort: ctx.conversation.effort,
      memoryEnabled: ctx.memoryEnabled,
      apiKey: ctx.apiKey,
    })
    const writing = ctx.system.startsWith(HANDOFF_WRITER_OPENING)
    if (writing && options.writer) return options.writer(ctx)
    const result: TurnResult = {
      text: writing ? `Here you go.\n\n${SAMPLE}\n\nCopy this message.` : `Reply from ${provider}`,
      thinking: '',
      events: [],
      citations: [],
      generated: [],
      usage: usage(model, 2000, 400),
      model,
    }
    ctx.emit.usage(result.usage)
    return result
  }
  const chat = new ChatService(
    store,
    { get: () => 'unused' },
    (event) => {
      events.push(event)
      for (const waiter of waiters.splice(0)) waiter()
    },
    () => {},
    run,
  )
  /** Resolves once an event matching the test has arrived. */
  const until = async (test: (event: ChatEvent) => boolean): Promise<ChatEvent> => {
    for (;;) {
      const hit = events.find(test)
      if (hit) return hit
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
  }
  const handoffs = (): HandoffProgress[] => events.flatMap((e) => (e.type === 'handoff' ? [e.handoff] : []))
  return { chat, events, calls, until, handoffs }
}

/** A Claude chat with one exchange in it. */
function claudeChat(patch: Partial<Conversation> = {}): Conversation {
  const conversation = store.createConversation('claude', 'claude-opus-5-5')
  conversation.title = 'Lisbon trip'
  conversation.tools = { webSearch: true, codeExec: false, imageGen: true }
  conversation.effort = 'high'
  conversation.messages = [
    message('user', 'Help me plan four days in Lisbon'),
    message('assistant', 'Start in Alfama.', { model: 'claude-opus-5-5' }),
  ]
  Object.assign(conversation, patch)
  store.saveConversation(conversation)
  return conversation
}

/** Fallback on, and Claude's $100 credit 90% used. */
function nearlyOut(prefer: Provider | 'auto' = 'auto'): void {
  store.updateSettings({
    fallback: { enabled: true, thresholdPct: 85, prefer },
    credits: {
      claude: { monthlyUsd: 100, renewalDay: 1 },
      chatgpt: { monthlyUsd: 100, renewalDay: 1 },
      gemini: { monthlyUsd: 10, renewalDay: 1 },
    },
  })
  store.recordSpend({ ts: Date.now(), provider: 'claude', model: 'claude-opus-5-5', costUsd: 90, kind: 'chat', ref: 'earlier', inputTokens: 1, outputTokens: 1 })
}

function ledger(): LedgerEntry[] {
  return fs
    .readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry)
}

describe('automatic fallback', () => {
  it('moves the chat to the provider with the most credit left, with a summary written by that provider', async () => {
    nearlyOut()
    const source = claudeChat()
    const { chat, events, calls, until, handoffs } = harness()
    expect(chat.start({ conversationId: source.id, text: 'What about day two?', attachments: [] })).toEqual({ ok: true })
    const done = await until((e) => e.type === 'done')
    if (done.type !== 'done') throw new Error('unreachable')

    // Two requests, both to the new provider: the summary, then the answer.
    expect(calls.map((c) => c.provider)).toEqual(['chatgpt', 'chatgpt'])
    const [writer, answer] = calls as [Call, Call]
    expect(writer.system).toBe(HANDOFF_WRITER_SYSTEM)
    expect(writer.model).toBe(store.getSettings().defaultModel.chatgpt)
    expect(writer.effort).toBe('low')
    expect(writer.memoryEnabled).toBe(false)
    expect(writer.prompt).toContain('USER:\nHelp me plan four days in Lisbon\n\nASSISTANT (Claude):\nStart in Alfama.')
    expect(writer.prompt).toContain('For the "From" line write: Claude Opus 5.5.')
    // The message being sent is not part of the history that gets summarised.
    expect(writer.prompt).not.toContain('What about day two?')

    const moved = store.getConversation(done.conversationId)!
    expect(moved.id).not.toBe(source.id)
    expect(moved.provider).toBe('chatgpt')
    expect(moved.title).toBe('Lisbon trip')
    expect(moved.effort).toBe('high')
    expect(moved.tools).toEqual({ webSearch: true, codeExec: false, imageGen: true })
    expect(moved.handoff).toMatchObject({ source: 'fallback', from: 'Claude Opus 5.5', fromProvider: 'claude', fromConversationId: source.id, usedPct: 90 })
    expect(moved.handoff!.summary).toBe(parseHandoff(SAMPLE)!.summary)
    expect(moved.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'What about day two?'],
      ['assistant', 'Reply from chatgpt'],
    ])
    expect(answer.system).toContain(`<handoff>\n${moved.handoff!.summary}\n</handoff>`)
    expect(answer.prompt).toBe('What about day two?')

    // The old chat is untouched except for a pointer to where it continues.
    const old = store.getConversation(source.id)!
    expect(old.messages).toHaveLength(2)
    expect(old.continuedIn).toEqual({ conversationId: moved.id, provider: 'chatgpt' })

    // Both requests are billed to the new provider, and the chat's cost includes the summary.
    const fresh = ledger().filter((entry) => entry.ref !== 'earlier')
    expect(fresh.map((entry) => [entry.kind, entry.provider, entry.ref])).toEqual([
      ['handoff', 'chatgpt', source.id],
      ['chat', 'chatgpt', moved.id],
    ])
    expect(moved.costUsd).toBeCloseTo(fresh[0]!.costUsd + fresh[1]!.costUsd, 10)
    expect(moved.handoff!.usage!.costUsd).toBeCloseTo(fresh[0]!.costUsd, 10)

    // The window hears about it in order: writing, done (with the new chat), then the turn in the new chat.
    expect(handoffs().map((h) => h.status)).toEqual(['writing', 'writing', 'done'])
    expect(handoffs().at(-1)).toMatchObject({ reason: 'credit', from: 'claude', to: 'chatgpt', usedPct: 90 })
    expect(handoffs().at(-1)!.conversation!.id).toBe(moved.id)
    const order = events.map((e) => (e.type === 'handoff' ? `handoff:${e.handoff.status}` : `${e.type}:${e.conversationId === moved.id ? 'new' : 'old'}`))
    expect(order.indexOf('handoff:done')).toBeLessThan(order.indexOf('user:new'))
    expect(order).not.toContain('user:old')
    // Once everything has settled, neither chat is marked as busy.
    await vitestSettled(chat, source.id)
    expect(chat.isRunning(source.id)).toBe(false)
    expect(chat.isRunning(moved.id)).toBe(false)
  })

  it('goes to the preferred provider, and drops image generation where the new provider has none', async () => {
    nearlyOut('gemini')
    const source = claudeChat({ provider: 'chatgpt', model: 'gpt-6.1-sol' })
    store.recordSpend({ ts: Date.now(), provider: 'chatgpt', model: 'gpt-6.1-sol', costUsd: 99, kind: 'chat', ref: 'earlier', inputTokens: 1, outputTokens: 1 })
    store.updateSettings({ fallback: { enabled: true, thresholdPct: 85, prefer: 'gemini' } })
    const first = harness()
    first.chat.start({ conversationId: source.id, text: 'next', attachments: [] })
    const done = await first.until((e) => e.type === 'done')
    expect(store.getConversation(done.conversationId)!.provider).toBe('gemini')

    // Claude has no image API, so a chat that moves there loses that one tool.
    store.updateSettings({ fallback: { enabled: true, thresholdPct: 85, prefer: 'claude' }, credits: { ...store.getSettings().credits, claude: { monthlyUsd: 1000, renewalDay: 1 } } })
    const again = claudeChat({ provider: 'chatgpt', model: 'gpt-6.1-sol' })
    const second = harness()
    second.chat.start({ conversationId: again.id, text: 'next', attachments: [] })
    const moved = store.getConversation((await second.until((e) => e.type === 'done')).conversationId)!
    expect(moved.provider).toBe('claude')
    expect(moved.tools).toEqual({ webSearch: true, codeExec: false, imageGen: false })
  })

  it('leaves the chat where it is below the threshold, when switched off, when told to stay, and in a reviewed chat', async () => {
    const stays = async (prepare: () => Conversation): Promise<void> => {
      const source = prepare()
      const { chat, calls, until, handoffs } = harness()
      chat.start({ conversationId: source.id, text: 'next', attachments: [] })
      const done = await until((e) => e.type === 'done')
      expect(done.conversationId).toBe(source.id)
      expect(new Set(calls.map((c) => c.provider))).toEqual(new Set(['claude']))
      expect(handoffs()).toEqual([])
    }
    await stays(() => {
      nearlyOut()
      store.updateSettings({ fallback: { enabled: true, thresholdPct: 95, prefer: 'auto' } })
      return claudeChat()
    })
    await stays(() => {
      store.updateSettings({ fallback: { enabled: false, thresholdPct: 85, prefer: 'auto' } })
      return claudeChat()
    })
    await stays(() => {
      store.updateSettings({ fallback: { enabled: true, thresholdPct: 85, prefer: 'auto' } })
      return claudeChat({ noFallback: true })
    })
    await stays(() => claudeChat({ panel: true, reviewers: [] }))
  })

  it('answers with the original provider when the summary cannot be written', async () => {
    nearlyOut()
    const source = claudeChat()
    const { chat, calls, until, handoffs } = harness({
      writer: (ctx) => ({ text: '', thinking: '', events: [], citations: [], generated: [], usage: usage(ctx.conversation.model, 500, 0), model: ctx.conversation.model, error: 'Rate limited.' }),
    })
    chat.start({ conversationId: source.id, text: 'What about day two?', attachments: [] })
    const done = await until((e) => e.type === 'done')
    expect(done.conversationId).toBe(source.id)
    expect(calls.map((c) => c.provider)).toEqual(['chatgpt', 'claude'])
    expect(handoffs().at(-1)).toMatchObject({ status: 'failed', error: 'The handoff summary could not be written: Rate limited.' })
    const saved = store.getConversation(source.id)!
    expect(saved.messages.map((m) => m.text)).toEqual(['Help me plan four days in Lisbon', 'Start in Alfama.', 'What about day two?', 'Reply from claude'])
    expect(saved.continuedIn).toBeUndefined()
    expect(store.listConversations()).toHaveLength(1)
    // The failed attempt still used tokens, and that is on the bill.
    expect(ledger().filter((e) => e.ref !== 'earlier').map((e) => [e.kind, e.provider])).toEqual([['handoff', 'chatgpt'], ['chat', 'claude']])
  })

  it('treats an empty summary as a failure', async () => {
    nearlyOut()
    const source = claudeChat()
    const { chat, until, handoffs } = harness({
      writer: (ctx) => ({ text: '   ', thinking: '', events: [], citations: [], generated: [], usage: usage(ctx.conversation.model, 500, 1), model: ctx.conversation.model }),
    })
    chat.start({ conversationId: source.id, text: 'next', attachments: [] })
    expect((await until((e) => e.type === 'done')).conversationId).toBe(source.id)
    expect(handoffs().at(-1)!.error).toMatch(/empty summary/)
  })

  it('gives the message back when stopped while the summary is being written', async () => {
    nearlyOut()
    const source = claudeChat()
    const { chat, calls, until, handoffs } = harness({
      writer: (ctx) =>
        new Promise<TurnResult>((resolve) => {
          ctx.signal.addEventListener('abort', () =>
            resolve({ text: '# Threefold han', thinking: '', events: [], citations: [], generated: [], usage: usage(ctx.conversation.model, 500, 5), model: ctx.conversation.model, error: 'Stopped.' }),
          )
        }),
    })
    chat.start({ conversationId: source.id, text: 'What about day two?', attachments: [] })
    await until((e) => e.type === 'handoff' && e.handoff.status === 'writing')
    expect(chat.isRunning(source.id)).toBe(true)
    chat.stop(source.id)
    await until((e) => e.type === 'handoff' && e.handoff.status === 'stopped')
    expect(handoffs().at(-1)!.unsent).toEqual({ text: 'What about day two?', attachments: [] })
    expect(calls).toHaveLength(1)
    expect(store.listConversations()).toHaveLength(1)
    expect(store.getConversation(source.id)!.messages).toHaveLength(2)
  })

  it('starts a chat with no history on the other provider without writing a summary', async () => {
    nearlyOut()
    const empty = store.createConversation('claude', 'claude-opus-5-5')
    store.saveConversation(empty)
    const { chat, calls, until, handoffs } = harness()
    chat.start({ conversationId: empty.id, text: 'First question', attachments: [] })
    const done = await until((e) => e.type === 'done')
    expect(calls.map((c) => c.provider)).toEqual(['chatgpt'])
    expect(calls[0]!.system).not.toContain('<handoff>')
    expect(handoffs().map((h) => h.status)).toEqual(['done'])
    const moved = store.getConversation(done.conversationId)!
    expect(moved.handoff).toBeUndefined()
    expect(moved.title).toBe('First question')
    // The empty chat that was never used is not left behind.
    expect(store.getConversation(empty.id)).toBeNull()
    expect(store.listConversations().map((m) => m.id)).toEqual([moved.id])
  })

  it('summarises only what stays when the message being sent replaces earlier ones', async () => {
    nearlyOut()
    const source = claudeChat()
    source.messages.push(message('user', 'A question that is being edited'), message('assistant', 'An answer that is being replaced'))
    store.saveConversation(source)
    const { chat, calls, until } = harness()
    chat.start({ conversationId: source.id, text: 'The edited question', attachments: [], truncateFrom: source.messages[2]!.id })
    await until((e) => e.type === 'done')
    expect(calls[0]!.prompt).toContain('Start in Alfama.')
    expect(calls[0]!.prompt).not.toContain('being edited')
    expect(calls[0]!.prompt).not.toContain('being replaced')
    // The original chat keeps all four messages.
    expect(store.getConversation(source.id)!.messages).toHaveLength(4)
  })
})

describe('handing a chat off by hand', () => {
  it('writes a summary and opens a new chat, without sending anything', async () => {
    const source = claudeChat()
    const { chat, calls, until, handoffs } = harness()
    expect(chat.handoff(source.id, 'gemini')).toEqual({ ok: true })
    const done = await until((e) => e.type === 'handoff' && e.handoff.status === 'done')
    if (done.type !== 'handoff') throw new Error('unreachable')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.provider).toBe('gemini')
    const moved = store.getConversation(done.handoff.conversation!.id)!
    expect(moved.provider).toBe('gemini')
    expect(moved.messages).toEqual([])
    expect(moved.handoff).toMatchObject({ source: 'manual', fromProvider: 'claude' })
    expect(moved.handoff!.usedPct).toBeUndefined()
    expect(handoffs().at(-1)).toMatchObject({ reason: 'manual', from: 'claude', to: 'gemini' })
    expect(store.getConversation(source.id)!.continuedIn).toEqual({ conversationId: moved.id, provider: 'gemini' })
    await vitestSettled(chat, source.id)
  })

  it('carries an earlier handoff into the next one', async () => {
    const source = claudeChat({ handoff: { source: 'pasted', summary: 'EARLIER SUMMARY', createdAt: 1 } })
    const { chat, calls, until } = harness()
    chat.handoff(source.id, 'chatgpt')
    await until((e) => e.type === 'handoff' && e.handoff.status === 'done')
    expect(calls[0]!.prompt).toContain('<earlier_handoff>\nEARLIER SUMMARY\n</earlier_handoff>')
  })

  it('reports a failure and changes nothing', async () => {
    const source = claudeChat()
    const { chat, until, calls } = harness({
      writer: (ctx) => ({ text: '', thinking: '', events: [], citations: [], generated: [], usage: emptyUsage(ctx.conversation.model), model: ctx.conversation.model, error: 'No credit.' }),
    })
    chat.handoff(source.id, 'chatgpt')
    const failed = await until((e) => e.type === 'handoff' && e.handoff.status === 'failed')
    expect(failed.type === 'handoff' && failed.handoff.error).toBe('The handoff summary could not be written: No credit.')
    expect(calls).toHaveLength(1)
    expect(store.listConversations()).toHaveLength(1)
  })

  it('refuses what makes no sense', () => {
    const { chat } = harness()
    const source = claudeChat()
    expect(chat.handoff('missing', 'chatgpt').error).toMatch(/no longer exists/)
    expect(chat.handoff(source.id, 'claude').error).toMatch(/already in Claude mode/)
    expect(chat.handoff(claudeChat({ panel: true }).id, 'chatgpt').error).toMatch(/reviewed chat/)
    const empty = store.createConversation('claude', 'claude-opus-5-5')
    store.saveConversation(empty)
    expect(chat.handoff(empty.id, 'chatgpt').error).toMatch(/nothing to hand off/)
    expect(hasHistory({ messages: [], handoff: { source: 'pasted', summary: 'x', createdAt: 1 } })).toBe(true)
  })
})

describe('writing a summary', () => {
  it('returns a clean summary and reports a thrown error instead of throwing', async () => {
    const source = claudeChat()
    const target = { provider: 'gemini' as const, model: 'gemini-4-hydrogen' }
    const base = { store, source, target, apiKey: 'k', signal: new AbortController().signal, onUsage: () => {} }
    const good = await writeHandoff({
      ...base,
      run: async (_provider, ctx) => ({ text: `\`\`\`\n${SAMPLE}\n\`\`\``, thinking: '', events: [], citations: [], generated: [], usage: usage(ctx.conversation.model, 10, 10), model: ctx.conversation.model }),
    })
    expect(good).toMatchObject({ from: 'Claude Opus 5.5', model: 'gemini-4-hydrogen', error: undefined })
    expect(good.summary).toBe(parseHandoff(SAMPLE)!.summary)
    const bad = await writeHandoff({
      ...base,
      run: async () => {
        throw new Error('socket hang up')
      },
    })
    expect(bad).toMatchObject({ summary: '', error: 'socket hang up' })
    expect(bad.usage.costUsd).toBe(0)
  })
})

/** Lets the background promise of a manual handoff finish before the temp folder is removed. */
async function vitestSettled(chat: ChatServiceType, id: string): Promise<void> {
  for (let i = 0; i < 50 && chat.isRunning(id); i++) await new Promise((resolve) => setTimeout(resolve, 2))
}
