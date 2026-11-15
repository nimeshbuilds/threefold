// Turns the official data exports into Threefold conversations.
//
// ChatGPT and Claude let you request a ZIP of your data with a conversations.json
// file inside. Google has no conversation export; Takeout gives an activity log
// (one record per prompt), which is grouped into chats here. These parsers are pure so they can be tested without
// Electron. They are deliberately forgiving: unknown message kinds are skipped
// instead of failing the whole import.

import type { ChatMessage, Conversation, Provider } from '@shared/types'
import { DEFAULT_MODEL } from '@shared/pricing'

const MAX_ATTACHMENT_CHARS = 20_000

function toMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // ChatGPT uses seconds with a fraction.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function blankConversation(provider: Provider, id: string, model: string): Conversation {
  return {
    id,
    provider,
    title: 'Untitled chat',
    model,
    createdAt: 0,
    updatedAt: 0,
    costUsd: 0,
    messageCount: 0,
    tools: { webSearch: false, codeExec: false, imageGen: false },
    effort: 'default',
    messages: [],
  }
}

/** Joins adjacent messages from the same role, which the exports produce for tool-heavy turns. */
function mergeAdjacent(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = []
  for (const message of messages) {
    const last = merged[merged.length - 1]
    if (last && last.role === message.role && message.role === 'assistant') {
      last.text = `${last.text}\n\n${message.text}`.trim()
    } else {
      merged.push({ ...message })
    }
  }
  return merged
}

// ---------- ChatGPT ----------

function chatgptPartText(part: unknown): string {
  if (typeof part === 'string') return part
  if (!isRecord(part)) return ''
  const type = part.content_type
  if (type === 'image_asset_pointer') return '_[image not included in the export]_'
  if (type === 'audio_transcription' && typeof part.text === 'string') return part.text
  if (typeof part.text === 'string') return part.text
  return ''
}

function chatgptMessageText(content: unknown): string {
  if (!isRecord(content)) return ''
  const type = content.content_type
  if (type === 'text' || type === 'multimodal_text') {
    const parts = Array.isArray(content.parts) ? content.parts : []
    return parts.map(chatgptPartText).filter(Boolean).join('\n\n').trim()
  }
  if (type === 'code' && typeof content.text === 'string' && content.text.trim()) {
    const lang = typeof content.language === 'string' && content.language !== 'unknown' ? content.language : ''
    return '```' + lang + '\n' + content.text.trim() + '\n```'
  }
  // thoughts, reasoning_recap, tether_*, execution_output, user_editable_context ... are internal.
  return ''
}

export function parseChatGPTConversation(raw: unknown): Conversation | null {
  if (!isRecord(raw) || !isRecord(raw.mapping)) return null
  const mapping = raw.mapping as Record<string, unknown>
  const sourceId = String(raw.conversation_id ?? raw.id ?? '')
  if (!sourceId) return null

  // Walk from the node the user last saw back to the root; that is the visible branch.
  const path: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let cursor: unknown = raw.current_node
  if (typeof cursor !== 'string' || !isRecord(mapping[cursor])) {
    // Older exports: take the node with no children that was created last.
    let latest = -1
    for (const [id, node] of Object.entries(mapping)) {
      if (!isRecord(node)) continue
      const children = Array.isArray(node.children) ? node.children : []
      const created = isRecord(node.message) ? toMs(node.message.create_time) : 0
      if (children.length === 0 && created >= latest) {
        latest = created
        cursor = id
      }
    }
  }
  while (typeof cursor === 'string' && !seen.has(cursor)) {
    seen.add(cursor)
    const node = mapping[cursor]
    if (!isRecord(node)) break
    path.push(node)
    cursor = node.parent
  }
  path.reverse()

  let modelSlug = ''
  const messages: ChatMessage[] = []
  for (const node of path) {
    const message = node.message
    if (!isRecord(message)) continue
    const role = isRecord(message.author) ? message.author.role : undefined
    if (role !== 'user' && role !== 'assistant') continue
    const metadata = isRecord(message.metadata) ? message.metadata : {}
    if (metadata.is_visually_hidden_from_conversation === true) continue
    if (role === 'assistant' && typeof metadata.model_slug === 'string') modelSlug = metadata.model_slug
    // Assistant messages addressed to a tool are tool calls, not replies.
    if (role === 'assistant' && typeof message.recipient === 'string' && message.recipient !== 'all') continue
    const text = chatgptMessageText(message.content)
    if (!text) continue
    messages.push({
      id: `${sourceId}:${String(message.id ?? node.id ?? messages.length)}`,
      role,
      text,
      createdAt: toMs(message.create_time),
      model: role === 'assistant' && modelSlug ? modelSlug : undefined,
    })
  }

  const merged = mergeAdjacent(messages)
  if (merged.length === 0) return null

  const conversation = blankConversation('chatgpt', `imp-chatgpt-${sourceId}`, DEFAULT_MODEL.chatgpt)
  conversation.title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'Untitled chat'
  conversation.createdAt = toMs(raw.create_time) || merged[0]!.createdAt
  conversation.updatedAt = toMs(raw.update_time) || merged[merged.length - 1]!.createdAt || conversation.createdAt
  conversation.origin = 'chatgpt-export'
  conversation.messages = merged
  conversation.messageCount = merged.length
  return conversation
}

// ---------- Claude ----------

function claudeMessageText(message: Record<string, unknown>): string {
  const parts: string[] = []
  const content = Array.isArray(message.content) ? message.content : []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  let text = parts.join('\n\n').trim()
  if (!text && typeof message.text === 'string') text = message.text.trim()

  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  for (const attachment of attachments) {
    if (!isRecord(attachment)) continue
    const name = typeof attachment.file_name === 'string' && attachment.file_name ? attachment.file_name : 'attachment'
    const extracted = typeof attachment.extracted_content === 'string' ? attachment.extracted_content : ''
    if (extracted) {
      const body =
        extracted.length > MAX_ATTACHMENT_CHARS
          ? extracted.slice(0, MAX_ATTACHMENT_CHARS) + '\n… (truncated)'
          : extracted
      text += `\n\n**Attached: ${name}**\n\n\`\`\`\n${body}\n\`\`\``
    } else {
      text += `\n\n_[Attached: ${name}]_`
    }
  }
  const files = Array.isArray(message.files) ? message.files : []
  for (const file of files) {
    if (isRecord(file) && typeof file.file_name === 'string' && file.file_name) {
      text += `\n\n_[File not included in the export: ${file.file_name}]_`
    }
  }
  return text.trim()
}

export function parseClaudeConversation(raw: unknown): Conversation | null {
  if (!isRecord(raw) || !Array.isArray(raw.chat_messages)) return null
  const sourceId = String(raw.uuid ?? '')
  if (!sourceId) return null

  const messages: ChatMessage[] = []
  for (const entry of raw.chat_messages) {
    if (!isRecord(entry)) continue
    const role = entry.sender === 'human' ? 'user' : entry.sender === 'assistant' ? 'assistant' : null
    if (!role) continue
    const text = claudeMessageText(entry)
    if (!text) continue
    messages.push({
      id: `${sourceId}:${String(entry.uuid ?? messages.length)}`,
      role,
      text,
      createdAt: toMs(entry.created_at),
    })
  }
  const merged = mergeAdjacent(messages)
  if (merged.length === 0) return null

  const conversation = blankConversation('claude', `imp-claude-${sourceId}`, DEFAULT_MODEL.claude)
  conversation.title = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Untitled chat'
  conversation.createdAt = toMs(raw.created_at) || merged[0]!.createdAt
  conversation.updatedAt = toMs(raw.updated_at) || merged[merged.length - 1]!.createdAt || conversation.createdAt
  conversation.origin = 'claude-export'
  conversation.messages = merged
  conversation.messageCount = merged.length
  return conversation
}

// ---------- Gemini (Google Takeout, My Activity) ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const value = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

/** Turns the HTML that Takeout stores for a reply into readable Markdown. Lossy, but never throws. */
export function htmlToMarkdown(html: string): string {
  let text = html.replace(/\r/g, '')
  text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  text = text.replace(/<pre[^>]*>\s*(?:<code[^>]*>)?([\s\S]*?)(?:<\/code>)?\s*<\/pre>/gi, (_m, code: string) => {
    return `\n\n\`\`\`\n${code.replace(/<[^>]+>/g, '')}\n\`\`\`\n\n`
  })
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    return `\n\n${'#'.repeat(Number(level))} ${inner.trim()}\n\n`
  })
  text = text.replace(/<(strong|b)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '**$3**')
  text = text.replace(/<(em|i)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '*$3*')
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
  text = text.replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
  text = text.replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|ul|ol|table|tr|blockquote)>/gi, '\n\n')
  text = text.replace(/<\/(td|th)>/gi, ' | ')
  text = text.replace(/<[^>]+>/g, '')
  text = decodeEntities(text)
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The reply stored with an activity record. Google's field for it has varied, so several are tried. */
function geminiReply(record: Record<string, unknown>): string {
  const items = Array.isArray(record.safeHtmlItem) ? record.safeHtmlItem : []
  const fromHtml = items
    .map((item) => (isRecord(item) && typeof item.html === 'string' ? htmlToMarkdown(item.html) : ''))
    .filter(Boolean)
    .join('\n\n')
  if (fromHtml) return fromHtml
  const subtitles = Array.isArray(record.subtitles) ? record.subtitles : []
  const fromSubtitles = subtitles
    .map((item) => (isRecord(item) && typeof item.name === 'string' ? item.name : typeof item === 'string' ? item : ''))
    .filter(Boolean)
    .join('\n\n')
  if (fromSubtitles) return fromSubtitles
  return typeof record.description === 'string' ? record.description.trim() : ''
}

function isGeminiRecord(record: Record<string, unknown>): boolean {
  const products = Array.isArray(record.products) ? record.products.join(' ') : ''
  return /gemini|bard/i.test(`${typeof record.header === 'string' ? record.header : ''} ${products}`)
}

const PROMPT_PREFIX = /^(Prompted|Asked|Said)\s+/i
/** Prompts this far apart are treated as separate chats. */
const GEMINI_GAP_MS = 30 * 60_000

/**
 * Builds chats from a Takeout "Gemini Apps" activity file. The file is a flat
 * list of prompts with their replies and has no notion of a conversation, so
 * prompts that were close together in time are grouped into one chat.
 */
export function parseGeminiActivity(data: unknown): ParsedExport {
  const result: ParsedExport = { conversations: [], found: 0, errors: [] }
  if (!Array.isArray(data)) {
    result.errors.push('The file is not a list of activity records.')
    return result
  }
  const exchanges: Array<{ time: number; prompt: string; reply: string }> = []
  for (const record of data) {
    result.found += 1
    if (!isRecord(record) || typeof record.title !== 'string') continue
    const reply = geminiReply(record)
    const known = PROMPT_PREFIX.test(record.title)
    // Exports in other languages word the title differently. A Gemini record that carries a reply is still a prompt.
    if (!known && !(reply && isGeminiRecord(record))) continue
    const prompt = (known ? record.title.replace(PROMPT_PREFIX, '') : record.title).trim()
    const time = toMs(record.time)
    if (!prompt || !time) continue
    exchanges.push({ time, prompt, reply })
  }
  exchanges.sort((a, b) => a.time - b.time)

  let current: Conversation | null = null
  let lastTime = 0
  for (const exchange of exchanges) {
    if (!current || exchange.time - lastTime > GEMINI_GAP_MS) {
      current = blankConversation('gemini', `imp-gemini-${exchange.time}`, DEFAULT_MODEL.gemini)
      current.title = exchange.prompt.slice(0, 60)
      current.createdAt = exchange.time
      current.origin = 'gemini-export'
      result.conversations.push(current)
    }
    current.messages.push({ id: `${current.id}:${exchange.time}:u`, role: 'user', text: exchange.prompt, createdAt: exchange.time })
    if (exchange.reply) {
      current.messages.push({ id: `${current.id}:${exchange.time}:a`, role: 'assistant', text: exchange.reply, createdAt: exchange.time })
    }
    current.updatedAt = exchange.time
    current.messageCount = current.messages.length
    lastTime = exchange.time
  }
  return result
}

// ---------- entry point ----------

export interface ParsedExport {
  conversations: Conversation[]
  found: number
  errors: string[]
}

const NAMES: Record<Provider, string> = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' }

/** Guesses which app an export came from by looking at the first usable entries. */
export function detectExport(data: unknown): Provider | null {
  if (!Array.isArray(data)) return null
  for (const item of data.slice(0, 20)) {
    if (!isRecord(item)) continue
    if (isRecord(item.mapping)) return 'chatgpt'
    if (Array.isArray(item.chat_messages)) return 'claude'
    if (typeof item.header === 'string' && typeof item.title === 'string' && 'time' in item) return 'gemini'
  }
  return null
}

export function parseExport(provider: Provider, data: unknown): ParsedExport {
  const result: ParsedExport = { conversations: [], found: 0, errors: [] }
  if (!Array.isArray(data)) {
    result.errors.push('The file is not a list of conversations.')
    return result
  }
  const detected = detectExport(data)
  if (detected && detected !== provider) {
    result.errors.push(
      `This looks like a ${NAMES[detected]} export. Switch to ${NAMES[detected]} mode and import it there.`,
    )
    return result
  }
  if (provider === 'gemini') return parseGeminiActivity(data)

  const parse = provider === 'chatgpt' ? parseChatGPTConversation : parseClaudeConversation
  for (const item of data) {
    result.found += 1
    try {
      const conversation = parse(item)
      if (conversation) result.conversations.push(conversation)
    } catch (error) {
      if (result.errors.length < 5) result.errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return result
}
