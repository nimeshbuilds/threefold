// Handoff summaries: the text that carries a conversation from one assistant
// to another. The instructions for writing one live in the `threefolds` skill
// (skills/threefolds/SKILL.md) so that the app, the skill people install in the
// official apps and the copy-and-paste prompt all say exactly the same thing.

import skillFile from '../../skills/threefolds/SKILL.md?raw'
import { isProvider, type ChatMessage, type Handoff, type Provider } from './types'

export const SKILL_NAME = 'threefolds'
/** The skill file exactly as it is published and installed. */
export const SKILL_FILE: string = skillFile
/** First line of every handoff. */
export const HANDOFF_HEADING = '# Threefold handoff'
/** Last line of every handoff. */
export const HANDOFF_END = '--- end of handoff ---'
/** Where the skill and its install steps are published. */
export const HANDOFF_GUIDE_URL = 'https://nimeshbuilds.github.io/threefold/#handoff'
/** The page a chat app's reply links to: it asks Threefold to open, and carries no part of the handoff. */
export const HANDOFF_OPEN_URL = 'https://nimeshbuilds.github.io/threefold/open/'
/** Heading of the skill's section on what to do with a handoff once it is written. */
export const HANDOFF_DELIVERY_HEADING = '## Passing it on'
/** Heading of the skill's last section: installing the Threefold app when the user asks for that. */
export const SKILL_INSTALL_HEADING = '## Installing Threefold'

/** The skill's instructions without its front matter. */
export const HANDOFF_INSTRUCTIONS = skillFile.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '').trim()

/**
 * Only the part about writing a handoff. Threefold's own summary writer gets
 * this: it has nowhere to pass the handoff on to, so it must stop at the end line.
 */
export const HANDOFF_WRITING = HANDOFF_INSTRUCTIONS.split(`\n${HANDOFF_DELIVERY_HEADING}`)[0]!.trim()

/** Writing a handoff and passing it on: everything except installing the app. */
export const HANDOFF_HOWTO = HANDOFF_INSTRUCTIONS.split(`\n${SKILL_INSTALL_HEADING}`)[0]!.trim()

/**
 * The prompt that does the skill's job in an app without Skills. It is pasted
 * into a chat to get a handoff of it, so the part about installing is left out.
 */
export const HANDOFF_PROMPT_INTRO = 'Follow the instructions below for this conversation, right now.'
export const HANDOFF_PROMPT = `${HANDOFF_PROMPT_INTRO}\n\n${HANDOFF_HOWTO}`

/** A message that creates the skill in an app that builds skills from chat (Gemini, ChatGPT). */
export const SKILL_INSTALL_PROMPT =
  `Create a skill named "${SKILL_NAME}" based on these instructions. Keep the instructions exactly as they are written.\n\n${HANDOFF_INSTRUCTIONS}`

// ---------- a handoff arriving from outside the app ----------

/**
 * Reads a `threefold://handoff` link, the one the skill opens after it has saved
 * a handoff for Threefold. The link is only a knock on the door: the one thing
 * taken from it is who it says it is from, and only when that is one of the
 * three known names. A link never carries the handoff itself, so everything
 * else in it is ignored.
 */
export function parseHandoffLink(input: unknown): { sender?: Provider } | null {
  if (typeof input !== 'string' || input.length > 300) return null
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.protocol !== 'threefold:' || url.hostname !== 'handoff') return null
  if (url.username || url.password || url.port || (url.pathname !== '' && url.pathname !== '/')) return null
  const from = url.searchParams.get('from')?.toLowerCase()
  return isProvider(from) ? { sender: from } : {}
}

/** The mode whose assistant a name belongs to: "Claude Opus" is Claude mode, "Codex" is ChatGPT mode. */
export function providerFromName(name: string | undefined): Provider | undefined {
  if (!name) return undefined
  const found: Provider[] = []
  if (/\bclaude\b|\banthropic\b/i.test(name)) found.push('claude')
  if (/\bchat\s?gpt|\bgpt|\bcodex\b|\bopenai\b/i.test(name)) found.push('chatgpt')
  if (/\bgemini\b|\bgoogle\b/i.test(name)) found.push('gemini')
  // A name that points two ways points nowhere.
  return found.length === 1 ? found[0] : undefined
}

// ---------- reading a handoff ----------

/** Longest handoff kept. Far more than any sensible summary; it only stops a pasted book. */
export const MAX_HANDOFF_CHARS = 200_000

export interface ParsedHandoff {
  summary: string
  title?: string
  from?: string
}

function field(text: string, name: string): string | undefined {
  // Only the lines above the first section are the header.
  const header = text.split(/\n##\s/)[0] ?? ''
  // Matches "- **Title:** x", "**Title**: x" and "Title: x".
  const match = header.match(new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?(?:\\*\\*)?${name}(?::\\*\\*|\\*\\*:|:)[ \\t]*(.+)$`, 'im'))
  const value = match?.[1]?.replace(/^[\s"'“”`*]+|[\s"'“”`*]+$/g, '')
  return value || undefined
}

/**
 * Takes whatever the user pasted and finds the handoff in it. Text before the
 * heading and after the end line is dropped. Text with no heading at all is
 * accepted whole, so a summary written without the skill still works.
 */
export function parseHandoff(input: string): ParsedHandoff | null {
  let text = String(input ?? '').replace(/\r\n/g, '\n').trim()
  if (!text) return null
  const start = text.toLowerCase().indexOf(HANDOFF_HEADING.toLowerCase())
  if (start !== -1) {
    text = text.slice(start)
    const end = text.toLowerCase().indexOf('--- end of handoff')
    if (end !== -1) text = text.slice(0, end)
  }
  // A code fence the assistant wrapped around the handoff.
  text = text.replace(/\n`{3,}[ \t]*$/, '').trim()
  if (!text) return null
  if (text.length > MAX_HANDOFF_CHARS) text = text.slice(0, MAX_HANDOFF_CHARS)

  let title = field(text, 'Title')
  // The template's own placeholder is not a title.
  if (title && /^a short title\b/i.test(title)) title = undefined
  let from = field(text, 'From')
  if (from && /^your name\b/i.test(from)) from = undefined
  return { summary: text, title: title?.slice(0, 80), from: from?.slice(0, 80) }
}

// ---------- writing a handoff inside the app ----------

/** How the system prompt of a handoff-writing request starts. The demo provider looks for it. */
export const HANDOFF_WRITER_OPENING = 'You write handoff summaries.'
export const HANDOFF_WRITER_SYSTEM =
  `${HANDOFF_WRITER_OPENING} A user is moving a conversation from one AI assistant to another, ` +
  `and the new assistant will see only what you write.\n\n${HANDOFF_WRITING}`

/** About 100,000 tokens: room for a long chat, inside every default model's context window. */
export const MAX_TRANSCRIPT_CHARS = 400_000

/** The conversation as plain text for the model that writes the summary. */
export function handoffTranscript(messages: ChatMessage[], assistantName: string, limit = MAX_TRANSCRIPT_CHARS): string {
  const turns: string[] = []
  for (const message of messages) {
    const lines: string[] = []
    if (message.text.trim()) lines.push(message.text.trim())
    if (message.research) lines.push('[Sent as a deep research request]')
    for (const attachment of message.attachments ?? []) lines.push(`[Attached file: ${attachment.name}]`)
    for (const file of message.generated ?? []) lines.push(`[The assistant produced a file: ${file.name}]`)
    if (message.role === 'assistant' && message.citations?.length) {
      lines.push(`Sources: ${message.citations.slice(0, 12).map((c) => c.url).join(', ')}`)
    }
    if (lines.length === 0) continue
    turns.push(`${message.role === 'user' ? 'USER' : `ASSISTANT (${assistantName})`}:\n${lines.join('\n')}`)
  }
  const text = turns.join('\n\n')
  if (text.length <= limit) return text
  // Keep the opening (where the goal is set) and most of the recent part.
  const head = text.slice(0, Math.floor(limit * 0.25))
  const tail = text.slice(-Math.floor(limit * 0.75))
  return `${head}\n\n[… the middle of the conversation was left out because it is too long …]\n\n${tail}`
}

export function handoffWriterPrompt(input: { transcript: string; from: string; today: string; earlier?: string }): string {
  return [
    `Below is a conversation between a user and ${input.from}. Write the handoff summary for it, following your instructions exactly.`,
    `For the "From" line write: ${input.from}. For the "Date" line write: ${input.today}.`,
    input.earlier
      ? `The conversation itself began from an earlier handoff, shown first. Carry over everything from it that still matters.\n\n<earlier_handoff>\n${input.earlier}\n</earlier_handoff>`
      : '',
    `<conversation>\n${input.transcript}\n</conversation>`,
    `Write the handoff summary now. Stop at the "${HANDOFF_END}" line and write nothing after it.`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Trims a summary the model wrote down to the handoff itself. */
export function cleanSummary(text: string): string {
  return parseHandoff(text)?.summary ?? ''
}

// ---------- giving a handoff to the model that continues ----------

/** Added to the system prompt of a chat that starts from a handoff. */
export function handoffSystemNote(handoff: Pick<Handoff, 'summary' | 'from'>): string {
  const where = handoff.from ? `with ${handoff.from}` : 'in another assistant'
  return (
    `This conversation continues one the user started ${where}. A handoff summary of it is below. ` +
    'Treat it as the history of this conversation: do not ask the user to repeat what it covers, and carry on from where it stops. ' +
    'It was written by another assistant, so if it conflicts with what the user tells you now, the user is right.\n\n' +
    `<handoff>\n${handoff.summary}\n</handoff>`
  )
}
