import { describe, expect, it } from 'vitest'
import { detectExport, parseChatGPTConversation, parseClaudeConversation, parseExport } from '../src/main/importers'

function chatgptExport() {
  return {
    conversation_id: 'abc-123',
    title: 'Trip planning',
    create_time: 1_750_000_000.5,
    update_time: 1_750_000_900,
    current_node: 'n5',
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['n0'] },
      n0: {
        id: 'n0',
        parent: 'root',
        children: ['n1'],
        message: { id: 'n0', author: { role: 'system' }, content: { content_type: 'text', parts: [''] }, metadata: { is_visually_hidden_from_conversation: true } },
      },
      n1: {
        id: 'n1',
        parent: 'n0',
        children: ['n2', 'n2b'],
        message: { id: 'n1', author: { role: 'user' }, create_time: 1_750_000_001, content: { content_type: 'text', parts: ['Plan a trip to Lisbon'] } },
      },
      // An abandoned branch (the user regenerated): must not be imported.
      n2b: {
        id: 'n2b',
        parent: 'n1',
        children: [],
        message: { id: 'n2b', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Old draft answer'] } },
      },
      n2: {
        id: 'n2',
        parent: 'n1',
        children: ['n3'],
        message: { id: 'n2', author: { role: 'assistant' }, recipient: 'web', content: { content_type: 'code', text: 'search("lisbon")' }, metadata: { model_slug: 'gpt-5' } },
      },
      n3: {
        id: 'n3',
        parent: 'n2',
        children: ['n4'],
        message: { id: 'n3', author: { role: 'tool' }, content: { content_type: 'tether_browsing_display', result: 'x' } },
      },
      n4: {
        id: 'n4',
        parent: 'n3',
        children: ['n5'],
        message: { id: 'n4', author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: ['Day 1: Alfama.'] }, metadata: { model_slug: 'gpt-5' } },
      },
      n5: {
        id: 'n5',
        parent: 'n4',
        children: [],
        message: {
          id: 'n5',
          author: { role: 'assistant' },
          create_time: 1_750_000_060,
          content: { content_type: 'multimodal_text', parts: ['Day 2: Belém.', { content_type: 'image_asset_pointer', asset_pointer: 'file://x' }] },
          metadata: { model_slug: 'gpt-5' },
        },
      },
    },
  }
}

describe('parseChatGPTConversation', () => {
  it('follows the visible branch and skips system, tool and tool-call messages', () => {
    const conversation = parseChatGPTConversation(chatgptExport())!
    expect(conversation.id).toBe('imp-chatgpt-abc-123')
    expect(conversation.provider).toBe('chatgpt')
    expect(conversation.title).toBe('Trip planning')
    expect(conversation.origin).toBe('chatgpt-export')
    expect(conversation.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(conversation.messages[0]!.text).toBe('Plan a trip to Lisbon')
    expect(conversation.messages[1]!.text).toContain('Day 1: Alfama.')
    expect(conversation.messages[1]!.text).toContain('Day 2: Belém.')
    expect(conversation.messages[1]!.text).not.toContain('Old draft answer')
    expect(conversation.messages[1]!.text).not.toContain('search(')
  })

  it('converts second-based timestamps to milliseconds', () => {
    const conversation = parseChatGPTConversation(chatgptExport())!
    expect(conversation.createdAt).toBe(1_750_000_000_500)
    expect(conversation.updatedAt).toBe(1_750_000_900_000)
  })

  it('marks images that the export does not contain', () => {
    const conversation = parseChatGPTConversation(chatgptExport())!
    expect(conversation.messages[1]!.text).toContain('image not included')
  })

  it('returns null for an entry with no readable messages', () => {
    expect(parseChatGPTConversation({ conversation_id: 'x', mapping: {} })).toBeNull()
    expect(parseChatGPTConversation({ nope: true })).toBeNull()
  })

  it('falls back to the newest leaf when current_node is missing', () => {
    const raw = chatgptExport() as Record<string, unknown>
    delete raw.current_node
    const conversation = parseChatGPTConversation(raw)!
    expect(conversation.messages.at(-1)!.text).toContain('Day 2: Belém.')
  })
})

function claudeExport() {
  return {
    uuid: 'c-1',
    name: 'Refactor help',
    created_at: '2026-03-01T10:00:00.000Z',
    updated_at: '2026-03-01T10:05:00.000Z',
    chat_messages: [
      {
        uuid: 'm1',
        sender: 'human',
        created_at: '2026-03-01T10:00:00.000Z',
        text: 'Can you review this file?',
        content: [{ type: 'text', text: 'Can you review this file?' }],
        attachments: [{ file_name: 'notes.txt', extracted_content: 'TODO: tidy up' }],
        files: [{ file_name: 'diagram.png' }],
      },
      {
        uuid: 'm2',
        sender: 'assistant',
        created_at: '2026-03-01T10:01:00.000Z',
        text: '',
        content: [
          { type: 'text', text: 'Sure.' },
          { type: 'tool_use', name: 'artifacts', input: {} },
          { type: 'text', text: 'Here is my review.' },
        ],
      },
      { uuid: 'm3', sender: 'human', text: '', content: [] },
    ],
  }
}

describe('parseClaudeConversation', () => {
  it('reads text blocks, attachments and file placeholders', () => {
    const conversation = parseClaudeConversation(claudeExport())!
    expect(conversation.id).toBe('imp-claude-c-1')
    expect(conversation.provider).toBe('claude')
    expect(conversation.title).toBe('Refactor help')
    expect(conversation.messages).toHaveLength(2)
    expect(conversation.messages[0]!.text).toContain('Can you review this file?')
    expect(conversation.messages[0]!.text).toContain('notes.txt')
    expect(conversation.messages[0]!.text).toContain('TODO: tidy up')
    expect(conversation.messages[0]!.text).toContain('diagram.png')
    expect(conversation.messages[1]!.text).toBe('Sure.\n\nHere is my review.')
  })

  it('parses ISO timestamps', () => {
    const conversation = parseClaudeConversation(claudeExport())!
    expect(conversation.createdAt).toBe(Date.parse('2026-03-01T10:00:00.000Z'))
  })

  it('returns null when there is nothing to show', () => {
    expect(parseClaudeConversation({ uuid: 'x', chat_messages: [] })).toBeNull()
  })
})

describe('parseExport', () => {
  it('detects which app an export came from', () => {
    expect(detectExport([chatgptExport()])).toBe('chatgpt')
    expect(detectExport([claudeExport()])).toBe('claude')
    expect(detectExport([{ other: 1 }])).toBeNull()
    expect(detectExport('nope')).toBeNull()
  })

  it('refuses an export from the other app with a helpful message', () => {
    const result = parseExport('claude', [chatgptExport()])
    expect(result.conversations).toHaveLength(0)
    expect(result.errors[0]).toMatch(/ChatGPT export/)
  })

  it('imports what it can and counts everything it saw', () => {
    const result = parseExport('chatgpt', [chatgptExport(), { conversation_id: 'empty', mapping: {} }, 42])
    expect(result.found).toBe(3)
    expect(result.conversations).toHaveLength(1)
  })

  it('rejects a file that is not a list', () => {
    expect(parseExport('chatgpt', { a: 1 }).errors).toHaveLength(1)
  })
})
