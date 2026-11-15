import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { artifactDocument, artifactFileName, artifactFromBlock } from '@shared/artifacts'
import { ToolError, editFile, listDir, readFile, resolveInside, runCommand, searchFiles, writeFile } from '../src/main/code/tools'
import { sanitizeReplay } from '../src/main/providers/anthropic'
import { buildSystemPrompt, memoryText, prepareAttachment } from '../src/main/providers/common'
import { LiveMeter } from '../src/main/providers/meter'
import { Store, classify } from '../src/main/store'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twofold-test-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('artifacts', () => {
  it('treats a full HTML page as an artifact and reads its title', () => {
    const artifact = artifactFromBlock('html', '<!doctype html><html><head><title>My page</title></head><body>hi</body></html>')
    expect(artifact).toMatchObject({ kind: 'html', title: 'My page' })
  })

  it('leaves a short HTML snippet inline', () => {
    expect(artifactFromBlock('html', '<p>hello</p>')).toBeNull()
  })

  it('recognises SVG by tag or by content', () => {
    expect(artifactFromBlock('svg', '<svg viewBox="0 0 1 1"></svg>')?.kind).toBe('svg')
    expect(artifactFromBlock('xml', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')?.kind).toBe('svg')
    expect(artifactFromBlock('xml', '<note>plain xml</note>')).toBeNull()
  })

  it('never turns ordinary code into an artifact', () => {
    expect(artifactFromBlock('ts', 'const a = 1')).toBeNull()
    expect(artifactFromBlock(undefined, 'plain text')).toBeNull()
  })

  it('wraps SVG in a page for preview and builds a safe file name', () => {
    const artifact = artifactFromBlock('svg', '<svg><title>Sales / Q3 chart!</title></svg>')!
    expect(artifactDocument(artifact)).toContain('<svg>')
    expect(artifactFileName(artifact)).toBe('sales-q3-chart.svg')
  })
})

describe('code tools: path confinement', () => {
  it('resolves paths inside the project', () => {
    fs.mkdirSync(path.join(dir, 'src'))
    expect(resolveInside(dir, 'src/a.ts')).toBe(path.join(fs.realpathSync(dir), 'src/a.ts'))
  })

  it('rejects parent traversal and absolute paths', () => {
    expect(() => resolveInside(dir, '../outside.txt')).toThrow(ToolError)
    expect(() => resolveInside(dir, 'a/../../outside.txt')).toThrow(ToolError)
    expect(() => resolveInside(dir, '/etc/passwd')).toThrow(ToolError)
  })

  it('rejects a symlink that points outside the project', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'twofold-outside-'))
    try {
      fs.symlinkSync(outside, path.join(dir, 'link'))
      expect(() => resolveInside(dir, 'link/secret.txt')).toThrow(ToolError)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses to write outside the project', async () => {
    await expect(writeFile(dir, '../escape.txt', 'x')).rejects.toThrow(ToolError)
    expect(fs.existsSync(path.join(dir, '..', 'escape.txt'))).toBe(false)
  })
})

describe('code tools: behaviour', () => {
  it('writes, lists, reads and searches files', async () => {
    await writeFile(dir, 'src/app.ts', 'const greeting = "hello"\nexport default greeting\n')
    fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'node_modules/pkg/index.js'), 'const greeting = 1')

    expect(await listDir(dir, '.')).toContain('src/')
    expect(await readFile(dir, 'src/app.ts', 2, 2)).toBe('    2  export default greeting')
    const hits = await searchFiles(dir, 'greeting')
    expect(hits).toContain('src/app.ts:1')
    expect(hits).not.toContain('node_modules')
  })

  it('edits exactly one occurrence unless told otherwise', async () => {
    await writeFile(dir, 'a.txt', 'one two one')
    await expect(editFile(dir, 'a.txt', 'one', 'ONE', false)).rejects.toThrow(/appears 2 times/)
    await expect(editFile(dir, 'a.txt', 'missing', 'x', false)).rejects.toThrow(/not found/)
    await editFile(dir, 'a.txt', 'one', 'ONE', true)
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('ONE two ONE')
  })

  it('keeps "$" patterns in the replacement text literal', async () => {
    await writeFile(dir, 'b.txt', 'price')
    await editFile(dir, 'b.txt', 'price', '$& and $1', false)
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('$& and $1')
  })

  it('runs a command in the project folder and reports the exit code', async () => {
    const output = await runCommand(dir, 'pwd && exit 3', 10, new AbortController().signal)
    expect(output).toContain(fs.realpathSync(dir))
    expect(output).toContain('[exit code 3]')
  })

  it('stops a command when the user aborts', async () => {
    const controller = new AbortController()
    const pending = runCommand(dir, 'sleep 30', 60, controller.signal)
    setTimeout(() => controller.abort(), 50)
    expect(await pending).toContain('[stopped by the user]')
  })
})

describe('sanitizeReplay', () => {
  it('leaves ordinary turns untouched', () => {
    const turn = [{ role: 'assistant' as const, content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'hi' }] }]
    expect(sanitizeReplay(turn as never)).toEqual(turn)
  })

  it('drops thinking and unanswered tool calls before a fallback block, keeping the block in place', () => {
    const turn = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'thinking', thinking: '', signature: 'a' },
          { type: 'text', text: 'partial' },
          { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} },
          { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
          { type: 'server_tool_use', id: 's2', name: 'web_search', input: {} },
          { type: 'tool_use', id: 't1', name: 'save_memory', input: {} },
          { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
          { type: 'thinking', thinking: '', signature: 'b' },
          { type: 'text', text: 'final' },
        ],
      },
    ]
    const [message] = sanitizeReplay(turn as never)
    const types = (message!.content as Array<{ type: string; id?: string }>).map((b) => b.type + (b.id ? `:${b.id}` : ''))
    expect(types).toEqual(['text', 'server_tool_use:s1', 'web_search_tool_result', 'fallback', 'thinking', 'text'])
  })
})

describe('memory tool input', () => {
  it('accepts a text string and rejects anything else', () => {
    expect(memoryText({ text: '  likes pnpm ' })).toBe('likes pnpm')
    expect(memoryText({ text: '' })).toBeNull()
    expect(memoryText({ text: 5 })).toBeNull()
    expect(memoryText(null)).toBeNull()
    expect(memoryText('text')).toBeNull()
  })
})

describe('buildSystemPrompt', () => {
  const base = { displayName: 'Sam', tools: { webSearch: false, codeExec: false, imageGen: false }, now: new Date(2026, 10, 14) }

  it('includes memories only when memory is on', () => {
    const memories = [{ id: '1', text: 'Prefers TypeScript', createdAt: 0, source: 'user' as const }]
    const on = buildSystemPrompt({ ...base, provider: 'claude', project: null, memories, memoryEnabled: true })
    const off = buildSystemPrompt({ ...base, provider: 'claude', project: null, memories, memoryEnabled: false })
    expect(on).toContain('Prefers TypeScript')
    expect(on).toContain('save_memory')
    expect(off).not.toContain('Prefers TypeScript')
    expect(off).not.toContain('save_memory')
  })

  it('adds project instructions and names the mode honestly', () => {
    const project = { id: 'p', provider: 'chatgpt' as const, name: 'Docs', instructions: 'Be terse.', files: [], createdAt: 0, updatedAt: 0 }
    const prompt = buildSystemPrompt({ ...base, provider: 'chatgpt', project, memories: [], memoryEnabled: false })
    expect(prompt).toContain('Be terse.')
    expect(prompt).toContain('the OpenAI API')
    expect(prompt).toContain('Twofold')
    expect(prompt).toContain('Sam')
  })
})

describe('LiveMeter', () => {
  it('estimates while streaming and replaces the estimate with the billed figure', () => {
    vi.useFakeTimers()
    try {
      const seen: Array<{ cost: number; estimated: boolean }> = []
      const meter = new LiveMeter('claude-opus-5-5', (u) => seen.push({ cost: u.costUsd, estimated: u.estimated }))
      meter.inputKnown('claude-opus-5-5', { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 })
      expect(seen.at(-1)).toEqual({ cost: 4, estimated: true })

      meter.outputChars(3600)
      vi.advanceTimersByTime(200)
      // 3600 characters is about 1000 tokens of output at $20 per million.
      expect(seen.at(-1)!.cost).toBeCloseTo(4.02, 6)
      expect(seen.at(-1)!.estimated).toBe(true)

      meter.requestFinished('claude-opus-5-5', { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2000 }, { webSearches: 1 })
      const final = meter.finish(false)
      expect(final.estimated).toBe(false)
      expect(final.costUsd).toBeCloseTo(4 + 0.04 + 0.01, 6)
      expect(final.webSearches).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the estimate, flagged, when a reply is interrupted', () => {
    const meter = new LiveMeter('gpt-6.1-sol', () => {})
    meter.requestStarted('gpt-6.1-sol', { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }, false)
    meter.outputChars(360)
    const final = meter.finish(true)
    expect(final.estimated).toBe(true)
    expect(final.outputTokens).toBe(100)
    expect(final.costUsd).toBeGreaterThan(0)
  })
})

describe('Store', () => {
  it('saves, lists, searches and deletes conversations, and survives a restart', () => {
    const store = new Store(dir)
    const conversation = store.createConversation('claude', 'claude-opus-5-5')
    conversation.title = 'Quarterly report'
    conversation.messages.push({ id: 'm1', role: 'user', text: 'Summarise the zebra migration', createdAt: 1 })
    store.saveConversation(conversation)

    expect(store.listConversations()).toHaveLength(1)
    expect(store.searchConversations('quarterly', 'claude')).toHaveLength(1)
    expect(store.searchConversations('zebra', 'claude')).toHaveLength(1)
    expect(store.searchConversations('zebra', 'chatgpt')).toHaveLength(0)

    const reopened = new Store(dir)
    expect(reopened.getConversation(conversation.id)?.messages[0]?.text).toContain('zebra')
    reopened.deleteConversation(conversation.id)
    expect(new Store(dir).listConversations()).toHaveLength(0)
  })

  it('rebuilds the index from conversation files when it is missing', () => {
    const store = new Store(dir)
    const conversation = store.createConversation('chatgpt', 'gpt-6.1-sol')
    store.saveConversation(conversation)
    fs.rmSync(path.join(dir, 'conversations-index.json'))
    expect(new Store(dir).listConversations().map((m) => m.id)).toEqual([conversation.id])
  })

  it('sums spend for the current billing cycle only, per provider, and adds live turns', () => {
    const store = new Store(dir)
    store.updateSettings({ credits: { claude: { monthlyUsd: 100, renewalDay: 1 }, chatgpt: { monthlyUsd: 200, renewalDay: 1 } } })
    const now = new Date(2026, 10, 14, 12).getTime()
    const entry = { model: 'claude-opus-5-5', kind: 'chat' as const, ref: 'c', inputTokens: 10, outputTokens: 5 }
    store.recordSpend({ ...entry, ts: now - 1000, provider: 'claude', costUsd: 1.5 })
    store.recordSpend({ ...entry, ts: new Date(2026, 9, 20).getTime(), provider: 'claude', costUsd: 9 })
    store.recordSpend({ ...entry, ts: now - 2000, provider: 'chatgpt', costUsd: 0.25, model: 'gpt-6.1-sol' })
    store.setLive('turn', 'claude', 0.1)

    const summary = store.spendSummary(now)
    expect(summary.claude.spentUsd).toBeCloseTo(1.5, 9)
    expect(summary.claude.liveUsd).toBeCloseTo(0.1, 9)
    expect(summary.claude.todayUsd).toBeCloseTo(1.5, 9)
    expect(summary.claude.monthlyUsd).toBe(100)
    expect(summary.chatgpt.spentUsd).toBeCloseTo(0.25, 9)
    expect(summary.claude.byModel[0]).toMatchObject({ model: 'claude-opus-5-5', inputTokens: 10 })

    store.clearLive('turn')
    expect(store.spendSummary(now).claude.liveUsd).toBe(0)
  })

  it('keeps attachments inside its own folder whatever name is asked for', () => {
    const store = new Store(dir)
    const attachment = store.saveAttachment('../../evil.txt', Buffer.from('hi'))
    expect(attachment.name).toBe('evil.txt')
    expect(store.attachmentPath(attachment).startsWith(path.join(dir, 'attachments'))).toBe(true)
    expect(store.findAttachmentFile('../settings.json')).toBeNull()
  })

  it('does not save the same memory twice', () => {
    const store = new Store(dir)
    store.addMemory('Uses pnpm', 'user')
    store.addMemory('Uses pnpm', 'claude')
    expect(store.listMemories()).toHaveLength(1)
  })
})

describe('attachments', () => {
  it('classifies files by extension', () => {
    expect(classify('photo.JPG').kind).toBe('image')
    expect(classify('paper.pdf').kind).toBe('pdf')
    expect(classify('sales.csv').kind).toBe('data')
    expect(classify('notes.md').kind).toBe('text')
  })

  it('sends data files to the sandbox only when code execution is on', () => {
    const store = new Store(dir)
    const csv = store.saveAttachment('sales.csv', Buffer.from('a,b\n1,2\n'))
    expect(prepareAttachment(store, csv, true).type).toBe('sandbox')
    const inline = prepareAttachment(store, csv, false)
    expect(inline.type).toBe('text')
  })

  it('explains instead of sending a binary file as text', () => {
    const store = new Store(dir)
    const xlsx = store.saveAttachment('book.xlsx', Buffer.from([0x50, 0x4b, 0, 0, 1, 2]))
    const prepared = prepareAttachment(store, xlsx, false)
    expect(prepared.type).toBe('note')
    expect(prepared.type === 'note' && prepared.text).toMatch(/Code execution/)
  })
})
