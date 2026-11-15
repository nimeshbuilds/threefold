// Pieces shared by both chat providers.

import type {
  Attachment,
  ChatMessage,
  ChatTools,
  Citation,
  Conversation,
  Handoff,
  Memory,
  Project,
  Provider,
  ToolEvent,
  Usage,
} from '@shared/types'
import { handoffSystemNote } from '@shared/handoff'
import { MAX_INLINE_TEXT_BYTES, MAX_MEDIA_BYTES, type Store } from '../store'

export interface TurnContext {
  apiKey: string
  store: Store
  conversation: Conversation
  /** Everything up to and including the new user message. */
  history: ChatMessage[]
  system: string
  project: Project | null
  memoryEnabled: boolean
  /** Web searches this provider has already been asked for this calendar month. */
  searchesThisMonth: number
  signal: AbortSignal
  emit: {
    text(delta: string): void
    thinking(delta: string): void
    event(event: ToolEvent): void
    usage(usage: Usage): void
  }
}

export interface TurnResult {
  text: string
  thinking: string
  events: ToolEvent[]
  citations: Citation[]
  generated: Attachment[]
  usage: Usage
  /** Model that actually answered (differs from the requested one after a fallback). */
  model: string
  replay?: unknown
  /** Set when the provider stopped without a normal answer. */
  error?: string
  containerId?: string
  containerChargedAt?: number
}

/**
 * Appended to a user message that was sent as deep research, for the providers
 * that research with their ordinary chat model (Claude and ChatGPT). It is added
 * the same way every time the message is replayed, so the conversation prefix
 * stays byte-identical between requests.
 */
export const RESEARCH_BRIEF =
  '\n\n<research_mode>\n' +
  'Treat this as a deep research task. Work out the questions that need answering, search widely, read primary sources, ' +
  'and cross-check every important claim against independent sources. Keep going until the evidence is solid. ' +
  'Then write a well-structured report: a short summary first, then the findings with specific facts, figures and dates, ' +
  'each with an inline citation. Say plainly what you could not confirm and where sources disagree.\n' +
  '</research_mode>'

/** The text of a user message as a research-capable chat model should see it. */
export function userText(message: Pick<ChatMessage, 'text' | 'research'>): string {
  return message.research ? message.text + RESEARCH_BRIEF : message.text
}

/** True when the message being answered was sent as deep research. */
export function isResearch(history: ChatMessage[]): boolean {
  return history[history.length - 1]?.research === true
}

export const IMAGE_TOOL_NAME = 'generate_image'
export const IMAGE_TOOL_DESCRIPTION =
  'Create an image from a text description and show it to the user. Use it when the user asks for a picture, ' +
  'illustration, logo, diagram rendering or photo. Write a detailed prompt: subject, style, composition, lighting and any text to include.'

/** Validates the arguments of a generate_image call. Returns the prompt, or null when they are malformed. */
export function imagePrompt(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const prompt = (input as Record<string, unknown>).prompt
  if (typeof prompt !== 'string' || !prompt.trim()) return null
  return prompt.trim().slice(0, 4000)
}

export const MEMORY_TOOL_NAME = 'save_memory'
export const MEMORY_TOOL_DESCRIPTION =
  'Save one short fact about the user that will be useful in future conversations ' +
  '(a preference, their role, an ongoing project). Use it when the user asks you to remember ' +
  'something or shares a lasting fact about themselves. Do not save one-off details or secrets.'

/** Validates the arguments of a save_memory call. Returns the text, or null when they are malformed. */
export function memoryText(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const text = (input as Record<string, unknown>).text
  if (typeof text !== 'string' || !text.trim()) return null
  return text.trim()
}

const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' }
const PROVIDER_API: Record<Provider, string> = {
  claude: 'the Anthropic API',
  chatgpt: 'the OpenAI API',
  gemini: "Google's Gemini API",
}

export function buildSystemPrompt(input: {
  provider: Provider
  displayName: string
  project: Project | null
  memories: Memory[]
  memoryEnabled: boolean
  tools: ChatTools
  /** The chat continues another conversation from this summary. */
  handoff?: Pick<Handoff, 'summary' | 'from'>
  now?: Date
}): string {
  const { provider, displayName, project, memories, memoryEnabled } = input
  const today = (input.now ?? new Date()).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  const parts: string[] = [
    `You are a helpful assistant in Threefold, a desktop chat app that connects to ${PROVIDER_API[provider]} with the user's own API key. ` +
      `This conversation is in ${PROVIDER_NAME[provider]} mode. Today is ${today}.`,
    'Write in Markdown. Use fenced code blocks with a language tag for code. Be direct and match the length of the answer to the question.',
    'When the user asks for a web page, an interactive demo, a diagram or a graphic, put the complete, self-contained file in ONE fenced code block tagged `html` or `svg`. ' +
      'The app opens that block in a live preview panel next to the chat, so do not split it across several blocks and do not rely on local files.',
  ]
  if (displayName.trim()) parts.push(`The user's name is ${displayName.trim()}.`)

  if (memoryEnabled) {
    parts.push(
      `You can remember things between conversations with the \`${MEMORY_TOOL_NAME}\` tool. ` +
        'Saved memories are visible to the user in Settings, and they can delete them.',
    )
    if (memories.length > 0) {
      parts.push(
        'What you remember about the user from earlier conversations:\n' +
          memories.map((m) => `- ${m.text}`).join('\n'),
      )
    }
  }

  if (project) {
    const lines = [`This chat belongs to the project "${project.name}".`]
    if (project.instructions.trim()) {
      lines.push(`The user's instructions for this project:\n${project.instructions.trim()}`)
    }
    if (project.files.length > 0) {
      lines.push(
        `Project files are included at the start of the conversation: ${project.files.map((f) => f.name).join(', ')}.`,
      )
    }
    parts.push(lines.join('\n\n'))
  }
  if (input.handoff?.summary.trim()) parts.push(handoffSystemNote(input.handoff))
  return parts.join('\n\n')
}

export type PreparedAttachment =
  | { type: 'image'; attachment: Attachment; base64: string }
  | { type: 'pdf'; attachment: Attachment; base64: string }
  | { type: 'text'; attachment: Attachment; text: string }
  | { type: 'sandbox'; attachment: Attachment }
  | { type: 'note'; attachment: Attachment; text: string }

/** Reads an attachment from disk and decides how it can be sent to a model. */
export function prepareAttachment(store: Store, attachment: Attachment, codeExec: boolean): PreparedAttachment {
  let data: Buffer
  try {
    data = store.readAttachment(attachment)
  } catch {
    return { type: 'note', attachment, text: `[The file "${attachment.name}" is no longer on this computer.]` }
  }
  if (attachment.kind === 'image' || attachment.kind === 'pdf') {
    if (data.byteLength > MAX_MEDIA_BYTES) {
      return { type: 'note', attachment, text: `[The file "${attachment.name}" is too large to send.]` }
    }
    return { type: attachment.kind, attachment, base64: data.toString('base64') }
  }
  if (attachment.kind === 'data' && codeExec) return { type: 'sandbox', attachment }

  const looksBinary = data.subarray(0, 8000).includes(0)
  if (looksBinary) {
    return {
      type: 'note',
      attachment,
      text:
        attachment.kind === 'data'
          ? `[The file "${attachment.name}" was attached. Turn on Code execution to let the model open it.]`
          : `[The file "${attachment.name}" is a binary file and could not be read as text.]`,
    }
  }
  if (data.byteLength > MAX_INLINE_TEXT_BYTES) {
    const head = data.subarray(0, MAX_INLINE_TEXT_BYTES).toString('utf8')
    return {
      type: 'text',
      attachment,
      text: `${head}\n\n[Only the first ${Math.round(MAX_INLINE_TEXT_BYTES / 1000)} KB of this file is shown.]`,
    }
  }
  return { type: 'text', attachment, text: data.toString('utf8') }
}

export function fileBlockText(name: string, text: string): string {
  return `<file name="${name.replace(/"/g, "'")}">\n${text}\n</file>`
}

/** Keeps a list of tool events in order and reports each change to the renderer. */
export class EventLog {
  readonly events: ToolEvent[] = []
  constructor(private readonly emit: (event: ToolEvent) => void) {}

  upsert(event: ToolEvent): ToolEvent {
    const index = this.events.findIndex((e) => e.id === event.id)
    if (index === -1) this.events.push(event)
    else this.events[index] = event
    this.emit(event)
    return event
  }

  patch(id: string, patch: Partial<ToolEvent>): void {
    const existing = this.events.find((e) => e.id === id)
    if (existing) this.upsert({ ...existing, ...patch })
  }

  finishRunning(): void {
    for (const event of this.events) {
      if (event.status === 'running') this.upsert({ ...event, status: 'done' })
    }
  }
}

export function addCitation(list: Citation[], url: string, title: string | null | undefined): void {
  if (!/^https?:\/\//i.test(url)) return
  if (list.some((c) => c.url === url)) return
  list.push({ url, title: title?.trim() || new URL(url).hostname })
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
